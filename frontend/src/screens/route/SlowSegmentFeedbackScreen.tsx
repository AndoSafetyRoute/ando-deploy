// 신호 D — 안내 종료(별점) 후, BE 가 미리 계산해 둔 "1m당 소요시간(pace) 상위
// min(10, 유효구간수)" 구간에 대한 게이트형 평가. 또한 RouteDetailScreen의
// "구간 설문조사" 버튼으로 언제든 다시 열 수 있다(동일 화면 재사용).
//
// 2026-09 재설계(모달 카드 1개씩 + 좌우 화살표): 예전엔 전체를 스크롤 리스트로
// 한 번에 보여줬는데, 구간이 5개까지 있으면 스크롤이 길어지고 위치 확인용
// 지도도 별도 팝업(🗺 버튼)이라 흐름이 끊겼다. 지금은 카드 1장(=구간 1개)을
// 모달로 띄우고 그 구간만 줌된 지도를 바로 아래 인라인으로 보여주며, 화살표로
// 답을 되돌아가서 고칠 수 있게 한다.
//
// 구간마다 1단계 3버튼: "이 구간, 어떠셨나요?" 편했어요(+1) / 보통이었어요(0) /
// 힘들었어요(-1) — 버튼을 눌러도 즉시 전송하지 않는다(로컬에 쌓임). 우측 상단
// X는 아무것도 전송하지 않고 닫기만 한다(예전 "건너뛰기"와 동일하게 무전송).
// 하단 중앙 "완료"만 지금까지 답한 것 전부를 한 번에 POST한다 — 전부 안 답해도
// 1개 이상이면 보낼 수 있다(응답률이 병목이라 강제 완주를 요구하지 않음).
//
// 순위/필터는 BE(GET /navigation/{route_id}/slow-segments)에서 끝나 있고, 여기선
// 받은 목록을 구간 설명·지도와 함께 보여주고 verdict 만 얹어 POST 한다.
//
// 물어볼 구간이 없거나(eligible:false) route_id 가 없으면 화면 없이 곧장 다음으로.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { C } from "../../constants/colors";
import RouteMapView, { type MapRoute } from "./RouteMapView";
import { getSlowSegments, postSegmentHardshipFeedback } from "../../api/slowSegments";
import {
  hasSlowSegments,
  isSegmentAnswerComplete,
  buildSegmentAnswers,
  type SlowSegment,
  type SlowSegmentsResponse,
  type Verdict,
} from "../../utils/slowSegmentModel";
import type { MeasurementUnit } from "../../api/routeApi";

type RawSeg = {
  start?: { latitude?: number; longitude?: number };
  end?:   { latitude?: number; longitude?: number };
  slope?: number; slope_pct?: number;
  length?: number; length_m?: number;
};

/** routeSegments(start/end 좌표)에서 전체 경로 좌표열. */
function toCoordList(segs: RawSeg[]): { latitude: number; longitude: number }[] {
  const out: { latitude: number; longitude: number }[] = [];
  segs.forEach((s, i) => {
    const st = s.start, en = s.end;
    if (i === 0 && st && Number.isFinite(st.latitude) && Number.isFinite(st.longitude)) {
      out.push({ latitude: st.latitude!, longitude: st.longitude! });
    }
    if (en && Number.isFinite(en.latitude) && Number.isFinite(en.longitude)) {
      out.push({ latitude: en.latitude!, longitude: en.longitude! });
    }
  });
  return out;
}

type Props = {
  navigation: any;
  route?: {
    params?: {
      routeSegments?: string;   // JSON 배열 (NavigationScreen normalizeSegments 결과) — 회색 전체 경로선용
      // 측정 파이프라인 v2 — BE route_slow_segments.seg_index가 이제 unit_index를
      // 가리키므로, 하이라이트·위치설명 둘 다 이 배열을 seg_index로 직접 찾아
      // 써야 한다(routeSegments를 seg_index로 슬라이스하면 완전히 다른 지점을
      // 가리킨다 — raw edge 배열과 unit 배열은 인덱스 체계가 다름).
      measurementUnits?: string;
      serverRouteId?: string;   // /navigation/start 의 route_id
      nextRouteId?:   string;   // 이어서 갈 RouteDetail 의 로컬 id
      sessionId?:     string;   // (선택) 수집 세션 id — 없으면 null 저장
    };
  };
};

export default function SlowSegmentFeedbackScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const p = route?.params ?? {};

  const segsRaw: RawSeg[] = useMemo(() => {
    try { return JSON.parse(p.routeSegments ?? "[]"); } catch { return []; }
  }, [p.routeSegments]);

  // unit_index로 직접 인덱싱한다 — BE(build_measurement_units)가 unit_index를
  // 배열 순서 그대로(0,1,2…) 매기므로, 필터링 없이 그대로 두면 위치가 안 어긋난다.
  // RouteDetailScreen의 "구간 설문조사"(나중에 평가) 경로는 좌표 있는 unit만
  // 채우고 나머지는 null로 비운 희소 배열을 보낼 수 있다 — 그래서 null도 허용.
  const measurementUnits: (MeasurementUnit | null)[] = useMemo(() => {
    try { return JSON.parse(p.measurementUnits ?? "[]"); } catch { return []; }
  }, [p.measurementUnits]);

  const serverRouteId = p.serverRouteId ? Number(p.serverRouteId) : null;

  const [loading, setLoading] = useState(true);
  const [resp, setResp] = useState<SlowSegmentsResponse | null>(null);
  const [verdict, setVerdict] = useState<Record<number, Verdict | undefined>>({}); // seg_index → 응답
  const [submitting, setSubmitting] = useState(false);
  const [idx, setIdx] = useState(0); // 지금 보여주는 카드 = segments[idx]
  const wentNext = useRef(false);

  // S5 — 3버튼 흐름 다음은 RouteDetail이 아니라 "가장 힘들었던 구간" 문항
  // (SegmentHardestPickScreen). 같은 params를 그대로 넘겨 그 화면이 독립적으로
  // /slow-segments를 다시 조회할 수 있게 한다(자체적으로 eligible 판정).
  const goNext = () => {
    if (wentNext.current) return;
    wentNext.current = true;
    navigation?.navigate("SegmentHardestPick", {
      routeSegments:  p.routeSegments,
      measurementUnits: p.measurementUnits,
      serverRouteId:  p.serverRouteId,
      nextRouteId:    p.nextRouteId,
      sessionId:      p.sessionId,
    });
  };

  // 마운트 시 조회. route_id 없으면 곧장 통과.
  useEffect(() => {
    let alive = true;
    if (serverRouteId == null || !Number.isFinite(serverRouteId)) { goNext(); return; }
    getSlowSegments(serverRouteId)
      .then((r) => { if (alive) setResp(r); })
      .catch((e) => { if (alive) { console.log("[FE] slow-segments 조회 실패:", e); setResp(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [serverRouteId]);

  const segments: SlowSegment[] = resp?.segments ?? [];
  const eligible = hasSlowSegments(resp);

  // 조회 끝났는데 물어볼 게 없으면 통과.
  useEffect(() => {
    if (!loading && !eligible) goNext();
  }, [loading, eligible]);

  const allCoords = useMemo(() => toCoordList(segsRaw), [segsRaw]);
  const hasMap = allCoords.length >= 2;

  if (loading) {
    return (
      <View style={ss.loadingWrap}>
        <ActivityIndicator color={C.primary} />
      </View>
    );
  }
  if (!eligible) return null;

  const isComplete = (s: SlowSegment) => isSegmentAnswerComplete(verdict[s.seg_index]);
  const doneCount = segments.filter(isComplete).length;

  // X — 아무것도 전송하지 않고 닫기만("건너뛰기"와 동일한 무전송 원칙 유지).
  const closeWithoutSubmit = () => {
    if (submitting) return;
    goNext();
  };

  // 완료 — 지금까지 답한 것만 골라 한 번에 전송. 전부 안 답해도 1개 이상이면 보낼 수 있다
  // (응답률이 병목이라 강제 완주를 요구하지 않기로 함, 2026-09 재설계).
  const submit = async () => {
    if (submitting || doneCount === 0) return;
    setSubmitting(true);
    const payload = buildSegmentAnswers(segments, verdict, p.sessionId || null);
    try {
      if (serverRouteId != null && payload.answers.length > 0) {
        await postSegmentHardshipFeedback(serverRouteId, payload);
      }
    } catch (e) {
      console.log("[FE] segment-hardship-feedback 저장 실패:", e);   // 저장 실패해도 흐름은 계속
    } finally {
      setSubmitting(false);
      goNext();
    }
  };

  const s = segments[idx];
  const v = verdict[s.seg_index];

  const highlightCoords = (() => {
    const unit = measurementUnits[s.seg_index];
    if (!unit) return [];
    const [startLng, startLat] = unit.start_coords;
    const [endLng, endLat] = unit.end_coords;
    return [
      { latitude: startLat, longitude: startLng },
      { latitude: endLat,   longitude: endLng },
    ];
  })();

  const mapRoutes: MapRoute[] | null = !hasMap ? null : [{
    id: "walked",
    color: "#C7C7D1",
    coordinates: allCoords,
    segments: [{
      coordinates: highlightCoords,
      color: C.primary,
      slopeMean: s.slope_pct,
      zone: s.zone || "warning",
    }],
  }];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={closeWithoutSubmit}>
      <View style={[ss.backdrop, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
        <View style={ss.card}>
          <View style={ss.cardHeader}>
            <Text style={ss.title}>유난히 더뎠던 구간, 어떠셨나요?</Text>
            <TouchableOpacity style={ss.closeBtn} onPress={closeWithoutSubmit} hitSlop={10} disabled={submitting}>
              <Text style={ss.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={ss.sub}>
            다른 곳보다 걸음이 느려졌던 구간이에요. 실제로 불편했는지 알려 주세요.
          </Text>

          <View style={ss.pagerRow}>
            <TouchableOpacity
              style={[ss.arrowBtn, idx === 0 && ss.arrowBtnHidden]}
              disabled={idx === 0}
              onPress={() => setIdx((i) => Math.max(0, i - 1))}
              hitSlop={8}
            >
              <Text style={ss.arrowText}>‹</Text>
            </TouchableOpacity>

            <View style={ss.segCard}>
              <Text style={ss.rankLine}>느린 순위 {s.rank}위{s.name ? ` · ${s.name}` : ""}</Text>

              {/* 위치 설명 텍스트("출발 후 Xm·Y%지점 ··· 약 N분 걸음") 대신 지도로
                  대체 — 어디인지는 글보다 지도가 더 잘 보여준다는 판단(2026-09).
                  좌표가 없는 경로(구버전 데이터/"구간 설문조사" 진입인데 좌표
                  없는 옛 경로)만 조용히 비워 둔다 — 억지로 지어내지 않는다. */}
              <View style={ss.inlineMapBox}>
                {hasMap && mapRoutes ? (
                  <RouteMapView routes={mapRoutes} selectedRouteId="walked" showSlopeMarkers />
                ) : (
                  <View style={ss.mapFallback}>
                    <Text style={ss.mapFallbackText}>이 구간의 지도 정보가 없어요</Text>
                  </View>
                )}
              </View>

              <Text style={ss.qLabel}>이 구간, 어떠셨나요?</Text>
              <View style={ss.choiceRow}>
                <TouchableOpacity
                  style={[ss.gate, v === 1 && ss.gateGoodOn]}
                  activeOpacity={0.8}
                  onPress={() => setVerdict((m) => ({ ...m, [s.seg_index]: 1 }))}
                >
                  <Text style={[ss.gateLabel, v === 1 && ss.gateLabelOn]}>편함</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[ss.gate, v === 0 && ss.gateNeutralOn]}
                  activeOpacity={0.8}
                  onPress={() => setVerdict((m) => ({ ...m, [s.seg_index]: 0 }))}
                >
                  <Text style={[ss.gateLabel, v === 0 && ss.gateLabelOn]}>보통</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[ss.gate, v === -1 && ss.gateBadOn]}
                  activeOpacity={0.8}
                  onPress={() => setVerdict((m) => ({ ...m, [s.seg_index]: -1 }))}
                >
                  <Text style={[ss.gateLabel, v === -1 && ss.gateLabelOn]}>힘듦</Text>
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity
              style={[ss.arrowBtn, idx === segments.length - 1 && ss.arrowBtnHidden]}
              disabled={idx === segments.length - 1}
              onPress={() => setIdx((i) => Math.min(segments.length - 1, i + 1))}
              hitSlop={8}
            >
              <Text style={ss.arrowText}>›</Text>
            </TouchableOpacity>
          </View>

          <Text style={ss.pageDots}>
            {segments.map((_, i) => i === idx ? "●" : "○").join(" ")}
          </Text>

          <TouchableOpacity
            style={[ss.cta, (doneCount === 0 || submitting) && ss.ctaOff]}
            disabled={doneCount === 0 || submitting}
            onPress={submit}
          >
            <Text style={ss.ctaText}>
              {submitting ? "저장 중…" : doneCount > 0 ? `완료 (${doneCount}개 응답)` : "완료"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const ss = StyleSheet.create({
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "transparent" },

  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },

  card: {
    width: "100%",
    maxWidth: 560,
    maxHeight: "94%",
    backgroundColor: C.bg,
    borderRadius: 22,
    padding: 18,
  },

  cardHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  closeBtn: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.06)", marginLeft: 10,
  },
  closeBtnText: { fontSize: 15, fontWeight: "800", color: C.textSub },

  title: { flex: 1, fontSize: 18, fontWeight: "800", color: C.text },
  sub: { fontSize: 12.5, color: C.textSub, marginTop: 8, lineHeight: 18 },

  pagerRow: { flexDirection: "row", alignItems: "center", marginTop: 14, gap: 6 },

  arrowBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: "center", justifyContent: "center",
    backgroundColor: C.white, borderWidth: 1, borderColor: C.border,
  },
  arrowBtnHidden: { opacity: 0 },
  arrowText: { fontSize: 20, fontWeight: "900", color: C.primaryDark, marginTop: -2 },

  segCard: { flex: 1, backgroundColor: C.white, borderRadius: 16, padding: 16 },
  rankLine: { fontSize: 14, fontWeight: "800", color: C.primaryDark, textAlign: "center" },

  inlineMapBox: {
    height: 320, borderRadius: 14, overflow: "hidden",
    marginTop: 12, backgroundColor: C.bg,
  },
  mapFallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  mapFallbackText: { fontSize: 13, color: C.textMute, fontWeight: "600" },

  qLabel: { fontSize: 13, fontWeight: "700", color: C.text, textAlign: "center", marginTop: 14 },
  choiceRow: { flexDirection: "row", gap: 8, marginTop: 10 },

  gate: { flex: 1, alignItems: "center", paddingVertical: 12, paddingHorizontal: 4, borderRadius: 12, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.white },
  gateGoodOn:    { borderColor: C.success, backgroundColor: "#E5F7F3" },
  gateNeutralOn: { borderColor: C.warn,    backgroundColor: "#FFF8E6" },
  gateBadOn:     { borderColor: C.danger,  backgroundColor: "#FFECEC" },
  gateLabel: { fontSize: 12, fontWeight: "700", color: C.textSub, textAlign: "center" },
  gateLabelOn: { color: C.text },

  pageDots: { textAlign: "center", marginTop: 12, fontSize: 10, color: C.textMute, letterSpacing: 2 },

  cta: { marginTop: 14, backgroundColor: C.primary, borderRadius: 14, paddingVertical: 14, alignItems: "center" },
  ctaOff: { backgroundColor: C.primaryLight },
  ctaText: { color: C.white, fontSize: 15, fontWeight: "700" },
});
