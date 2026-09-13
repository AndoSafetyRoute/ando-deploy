// 신호 D — 안내 종료(별점) 후, BE 가 미리 계산해 둔 "1m당 소요시간(pace) 상위
// min(10, 유효구간수)" 구간에 대한 게이트형 평가. 기존 구간평가 화면을 대체한다.
//
// 구간마다:
//   Q1 "소요시간 상위 10위 구간이에요. 불편했나요?"  예 / 아니오
//   Q1=예 → Q2 "힘듦 정도 1~10점"
//   Q1=아니오 → Q2 없이 다음 구간 (점수 null)
//   완료 → POST (Q1 응답한 구간 전부, 아니오는 hardship_score=null)
//
// 순위/필터는 BE(GET /navigation/{route_id}/slow-segments)에서 끝나 있고, 여기선
// 받은 목록을 구간 설명·지도 하이라이트와 함께 보여주고 Q1/Q2 만 얹어 POST 한다.
// 저장은 수집 동의와 무관한 독립 엔드포인트(별점처럼 always-on).
//
// 물어볼 구간이 없거나(eligible:false) route_id 가 없으면 화면 없이 곧장 다음으로.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { C } from "../../constants/colors";
import RouteMapView, { type MapRoute } from "./RouteMapView";
import { getSlowSegments, postSegmentHardshipFeedback } from "../../api/slowSegments";
import {
  hasSlowSegments,
  isSegmentAnswerComplete,
  buildSegmentAnswers,
  measuredSeconds,
  HARDSHIP_MIN,
  HARDSHIP_MAX,
  type SlowSegment,
  type SlowSegmentsResponse,
} from "../../utils/slowSegmentModel";
import { describeSegment } from "../../utils/segmentDescription";
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

const SCORE_VALUES = Array.from(
  { length: HARDSHIP_MAX - HARDSHIP_MIN + 1 },
  (_, i) => HARDSHIP_MIN + i,
);

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
  const measurementUnits: MeasurementUnit[] = useMemo(() => {
    try { return JSON.parse(p.measurementUnits ?? "[]"); } catch { return []; }
  }, [p.measurementUnits]);

  // describeSegment()(segmentDescription.ts)가 기대하는 필드명(length_m)으로
  // 변환 — "출발 후 몇 m 지점"을 measurement_units(unit_index 배열) 기준으로
  // 계산하기 위함. routeSegments(raw edge)로 계산하면 같은 인덱스 불일치로
  // 위치 설명 자체가 틀어진다(하이라이트와 동일한 문제).
  // 알려진 이슈(사소, 지금 안 고침): measurementUnits는 서울 밖 직선 구간
  // (outside_seoul)을 포함하지 않으므로, 하이브리드 경로(출발/도착이 서울 밖)에서
  // locateSegment()의 totalM(분모)이 실제 전체 여정보다 짧게 잡혀 "몇 % 지점"
  // 진행률 텍스트가 약간 어긋날 수 있다 — 하이라이트 위치 자체는 영향 없음.
  const descSegs = useMemo(
    () => measurementUnits.map((u) => ({ slope_pct: u.slope_pct, length_m: u.distance_m })),
    [measurementUnits]
  );

  const serverRouteId = p.serverRouteId ? Number(p.serverRouteId) : null;

  const [loading, setLoading] = useState(true);
  const [resp, setResp] = useState<SlowSegmentsResponse | null>(null);
  const [uncomfortable, setUncomfortable] = useState<Record<number, boolean>>({}); // seg_index → Q1
  const [score, setScore] = useState<Record<number, number>>({});                   // seg_index → Q2 (1..10)
  const [submitting, setSubmitting] = useState(false);
  const wentNext = useRef(false);

  const goNext = () => {
    if (wentNext.current) return;
    wentNext.current = true;
    navigation?.navigate("RouteDetail", { routeId: p.nextRouteId ?? "" });
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

  // 지도 모달 (걸은 경로 회색 + 이 구간 강조)
  const allCoords = useMemo(() => toCoordList(segsRaw), [segsRaw]);
  const hasMap = allCoords.length >= 2;
  const [mapSegIdx, setMapSegIdx] = useState<number | null>(null);   // segments 배열의 위치(=rank-1)

  if (loading) {
    return (
      <View style={[ss.screen, ss.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={C.primary} />
      </View>
    );
  }
  if (!eligible) return <View style={[ss.screen, { paddingTop: insets.top }]} />;

  const isComplete = (s: SlowSegment) =>
    isSegmentAnswerComplete(uncomfortable[s.seg_index], score[s.seg_index]);
  const allComplete = segments.every(isComplete);
  const doneCount = segments.filter(isComplete).length;

  // seg_index(=unit_index)로 measurement_units 배열에서 그 unit을 직접 찾아
  // 시작~끝 좌표로 지도 강조 범위를 만든다. 레거시(routeSegments를 seg_index로
  // 슬라이스하던 방식)는 unit_index와 raw edge 인덱스 체계가 달라 더 이상 맞지
  // 않는다 — seg_index_end도 이제 항상 seg_index와 같다(BE가 그렇게 채움, 병합
  // 구간 개념 없음).
  const highlightFor = (s: SlowSegment) => {
    const unit = measurementUnits[s.seg_index];
    if (!unit) return [];
    const [startLng, startLat] = unit.start_coords;
    const [endLng, endLat] = unit.end_coords;
    return [
      { latitude: startLat, longitude: startLng },
      { latitude: endLat,   longitude: endLng },
    ];
  };

  const mapModalRoutes: MapRoute[] | null =
    mapSegIdx === null
      ? null
      : [{
          id: "walked",
          color: "#C7C7D1",
          coordinates: allCoords,
          segments: [{
            coordinates: highlightFor(segments[mapSegIdx]),
            color: C.primary,
            slopeMean: segments[mapSegIdx].slope_pct,
            zone: segments[mapSegIdx].zone || "warning",
          }],
        }];

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    const payload = buildSegmentAnswers(segments, uncomfortable, score, p.sessionId || null);
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

  return (
    <View style={[ss.screen, { paddingTop: insets.top + 12 }]}>
      <Text style={ss.title}>유난히 더뎠던 구간, 어떠셨나요?</Text>
      <Text style={ss.sub}>
        다른 곳보다 걸음이 느려졌던 구간이에요. 실제로 불편했는지 알려 주세요.
      </Text>

      <ScrollView
        style={{ flex: 1, marginTop: 12 }}
        contentContainerStyle={{ gap: 14, paddingVertical: 8 }}
        showsVerticalScrollIndicator={false}
      >
        {segments.map((s, i) => {
          const d = describeSegment({
            segs: descSegs,
            startIdx: s.seg_index,
            endIdx: s.seg_index_end ?? s.seg_index,
            slopePct: s.slope_pct,
            lengthM: s.distance_m,
            orderNo1Based: i + 1,
            totalTargets: segments.length,
            measuredSeconds: measuredSeconds(s),
          });
          const unc = uncomfortable[s.seg_index];
          const sc = score[s.seg_index];
          return (
            <View key={s.seg_index} style={ss.card}>
              <Text style={ss.rankLine}>느린 순위 {s.rank}위{s.name ? ` · ${s.name}` : ""}</Text>
              <Text style={ss.locLine}>{d.locationText}</Text>
              <Text style={ss.metaLine}>{d.metaText}</Text>

              {hasMap && (
                <TouchableOpacity
                  style={ss.mapLinkBtn}
                  activeOpacity={0.7}
                  onPress={() => setMapSegIdx(i)}
                  hitSlop={{ top: 4, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={ss.mapLinkText}>🗺 지도로 확인하기</Text>
                </TouchableOpacity>
              )}

              {/* Q1 — 불편했나요 */}
              <Text style={ss.qLabel}>이 구간, 불편했나요?</Text>
              <View style={ss.choiceRow}>
                <TouchableOpacity
                  style={[ss.gate, unc === true && ss.gateYesOn]}
                  activeOpacity={0.8}
                  onPress={() => setUncomfortable((m) => ({ ...m, [s.seg_index]: true }))}
                >
                  <Text style={[ss.gateLabel, unc === true && ss.gateLabelOn]}>예, 불편했어요</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[ss.gate, unc === false && ss.gateNoOn]}
                  activeOpacity={0.8}
                  onPress={() => setUncomfortable((m) => ({ ...m, [s.seg_index]: false }))}
                >
                  <Text style={[ss.gateLabel, unc === false && ss.gateLabelOn]}>아니요, 괜찮았어요</Text>
                </TouchableOpacity>
              </View>

              {/* Q2 — 불편했을 때만 1~10점 */}
              {unc === true && (
                <>
                  <Text style={ss.qLabel}>얼마나 힘드셨나요? (1 = 조금, 10 = 매우)</Text>
                  <View style={ss.scoreRow}>
                    {SCORE_VALUES.map((n) => {
                      const on = sc === n;
                      return (
                        <TouchableOpacity
                          key={n}
                          style={[ss.scoreChip, on && ss.scoreChipOn]}
                          activeOpacity={0.8}
                          onPress={() => setScore((m) => ({ ...m, [s.seg_index]: n }))}
                        >
                          <Text style={[ss.scoreChipText, on && ss.scoreChipTextOn]}>{n}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </>
              )}
              {unc === false && (
                <Text style={ss.gateNote}>알려주셔서 고마워요.</Text>
              )}
            </View>
          );
        })}
      </ScrollView>

      <View style={{ gap: 10, marginBottom: insets.bottom + 12 }}>
        <TouchableOpacity
          style={[ss.cta, (!allComplete || submitting) && ss.ctaOff]}
          disabled={!allComplete || submitting}
          onPress={submit}
        >
          <Text style={ss.ctaText}>{submitting ? "저장 중…" : "완료"}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={goNext} disabled={submitting}>
          <Text style={ss.skip}>
            {doneCount > 0 ? `${doneCount}개만 답하고 건너뛰기` : "건너뛰기"}
          </Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={mapSegIdx !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setMapSegIdx(null)}
      >
        <View style={ss.mapModalBackdrop}>
          <View style={[ss.mapModalCard, { marginBottom: insets.bottom + 16 }]}>
            <View style={ss.mapModalHeader}>
              <Text style={ss.mapModalTitle}>
                {mapSegIdx !== null ? `느린 순위 ${segments[mapSegIdx].rank}위` : ""} 구간
              </Text>
              <TouchableOpacity onPress={() => setMapSegIdx(null)} hitSlop={10}>
                <Text style={ss.mapModalClose}>닫기</Text>
              </TouchableOpacity>
            </View>
            <View style={ss.mapModalBox}>
              {mapModalRoutes && (
                <RouteMapView routes={mapModalRoutes} selectedRouteId="walked" showSlopeMarkers />
              )}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const ss = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 20 },
  center: { alignItems: "center", justifyContent: "center" },
  title: { fontSize: 19, fontWeight: "800", color: C.text, textAlign: "center" },
  sub: { fontSize: 13, color: C.textSub, textAlign: "center", marginTop: 8, lineHeight: 19 },

  card: { backgroundColor: C.white, borderRadius: 16, padding: 18 },
  rankLine: { fontSize: 13, fontWeight: "800", color: C.primaryDark, textAlign: "center" },
  locLine: { fontSize: 13, color: C.textSub, textAlign: "center", marginTop: 6 },
  metaLine: { fontSize: 12.5, color: C.textMute, textAlign: "center", marginTop: 3 },

  mapLinkBtn: { alignSelf: "center", marginTop: 10, marginBottom: 2, paddingVertical: 4, paddingHorizontal: 8 },
  mapLinkText: { fontSize: 12.5, fontWeight: "700", color: C.primaryDark },

  qLabel: { fontSize: 13, fontWeight: "700", color: C.text, textAlign: "center", marginTop: 14 },
  choiceRow: { flexDirection: "row", gap: 10, marginTop: 10 },

  gate: { flex: 1, alignItems: "center", paddingVertical: 13, borderRadius: 12, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.white },
  gateYesOn: { borderColor: C.danger, backgroundColor: "#FFECEC" },
  gateNoOn: { borderColor: C.success, backgroundColor: "#E5F7F3" },
  gateLabel: { fontSize: 12.5, fontWeight: "700", color: C.textSub, textAlign: "center" },
  gateLabelOn: { color: C.text },
  gateNote: { fontSize: 12, color: C.textMute, textAlign: "center", marginTop: 10 },

  scoreRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 10 },
  scoreChip: {
    width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: C.border, backgroundColor: C.white,
  },
  scoreChipOn: { borderColor: C.primary, backgroundColor: C.primaryBg },
  scoreChipText: { fontSize: 14, fontWeight: "700", color: C.textSub },
  scoreChipTextOn: { color: C.primaryDark },

  cta: { backgroundColor: C.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  ctaOff: { backgroundColor: C.primaryLight },
  ctaText: { color: C.white, fontSize: 15, fontWeight: "700" },
  skip: { textAlign: "center", color: C.textMute, fontSize: 13, paddingVertical: 6 },

  mapModalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  mapModalCard: { backgroundColor: C.white, borderRadius: 20, marginHorizontal: 12, overflow: "hidden" },
  mapModalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
  },
  mapModalTitle: { fontSize: 15, fontWeight: "700", color: C.text },
  mapModalClose: { fontSize: 13, fontWeight: "700", color: C.textSub },
  mapModalBox: { height: 320, backgroundColor: C.bg },
});
