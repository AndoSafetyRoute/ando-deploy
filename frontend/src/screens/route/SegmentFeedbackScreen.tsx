// 구간 평가 화면 (⑭) — 안내 종료(만족도) 후 경사 뚜렷한 구간 1~2개에 대해
// "편함 / 보통 / 불편함" 단일 탭. ando_ml_plan_v2 §3.2 신호 D, §5.6(μEMA — 반복 부담 최소).
//
// 저장: CollectSession.addSegmentFeedback → /collect/batch. segment_feedback 테이블은
// session_id 컬럼이 없고 route_id 로 연결되므로(§3.7), 여기선 자체 세션을 새로 열고
// serverRouteId 만 있으면 된다.
//
// 평가할 구간이 없으면(완만한 경로) 화면 없이 곧장 다음으로 넘어간다.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { C } from "../../constants/colors";
import { CollectSession } from "../../utils/collectQueue";
import { getCollectConsent } from "../../personalization/collectConsent";
import RouteMapView, { type MapRoute } from "./RouteMapView";
import {
  pickFeedbackSegments,
  VERDICT,
  type VerdictLabel,
} from "../../utils/segmentFeedbackModel";

type RawSeg = {
  start?: { latitude?: number; longitude?: number };
  end?:   { latitude?: number; longitude?: number };
};

/** routeSegments(start/end 좌표 있는 원본)에서 전체 경로 좌표열을 뽑는다. */
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
      routeSegments?: string;   // JSON 배열 (NavigationScreen 이 넘김)
      serverRouteId?: string;   // /navigation/start 의 route_id
      nextRouteId?: string;     // 이어서 갈 RouteDetail 의 로컬 id
    };
  };
};

const CHOICES: { key: VerdictLabel; label: string; emoji: string }[] = [
  { key: "easy",   label: "편함",   emoji: "🙂" },
  { key: "normal", label: "보통",   emoji: "😐" },
  { key: "hard",   label: "불편함", emoji: "😣" },
];

function fmtSlope(s: number) {
  const dir = s > 0 ? "오르막" : s < 0 ? "내리막" : "평지";
  return `${dir} ${Math.abs(s).toFixed(1)}%`;
}
function fmtLen(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

export default function SegmentFeedbackScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const p = route?.params ?? {};

  const segsRaw = useMemo(() => {
    try { return JSON.parse(p.routeSegments ?? "[]"); } catch { return []; }
  }, [p.routeSegments]);

  const targets = useMemo(() => pickFeedbackSegments(segsRaw), [segsRaw]);
  const serverRouteId = p.serverRouteId ? Number(p.serverRouteId) : null;

  // "지도로 확인하기" — 걸은 경로 전체(회색) 위에 평가 대상 구간만 강조색으로.
  const allCoords = useMemo(() => toCoordList(segsRaw), [segsRaw]);
  const hasMap = allCoords.length >= 2;
  const [mapTargetIdx, setMapTargetIdx] = useState<number | null>(null);

  const [answers, setAnswers] = useState<Record<number, VerdictLabel>>({});
  // 동의 전엔 세션을 안 만든다 — 아래 collectRef.current?. 호출들은 null 이어도 안전.
  const collectRef = useRef<CollectSession | null>(null);
  useEffect(() => {
    let alive = true;
    getCollectConsent().then((c) => {
      if (alive && c === "granted") collectRef.current = new CollectSession();
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const goNext = () => {
    void collectRef.current?.flush({ final: true });
    collectRef.current = null;
    navigation?.navigate("RouteDetail", { routeId: p.nextRouteId ?? "" });
  };

  // 평가할 구간이 없으면 즉시 통과
  useEffect(() => {
    if (targets.length === 0) goNext();
    return () => { void collectRef.current?.flush({ final: true }); };
  }, [targets.length]);

  if (targets.length === 0) return <View style={[ss.screen, { paddingTop: insets.top }]} />;

  const allAnswered = targets.every((_, i) => answers[i] != null);

  /** target(startIdx~endIdx) 구간의 좌표열만 뽑아 지도 강조색 구간으로 만든다. */
  const highlightFor = (t: { startIdx: number; endIdx: number }) =>
    toCoordList(segsRaw.slice(t.startIdx, t.endIdx + 1) as RawSeg[]);

  const mapModalRoutes: MapRoute[] | null =
    mapTargetIdx === null
      ? null
      : [
          {
            id: "walked",
            color: "#C7C7D1",
            coordinates: allCoords,
            segments: [
              {
                coordinates: highlightFor(targets[mapTargetIdx]),
                color: C.primary,
                slopeMean: targets[mapTargetIdx].slope_mean,
                zone: targets[mapTargetIdx].slope_mean === 0 ? "flat" : "warning",
              },
            ],
          },
        ];

  const submit = () => {
    const cs = collectRef.current;
    if (cs) {
      targets.forEach((t, i) => {
        const lbl = answers[i];
        if (!lbl) return;
        cs.addSegmentFeedback({
          route_id:   serverRouteId ?? undefined,
          slope_mean: t.slope_mean,
          length_m:   t.length_m,
          verdict:    VERDICT[lbl],
        });
      });
    }
    goNext();
  };

  return (
    <View style={[ss.screen, { paddingTop: insets.top + 12 }]}>
      <Text style={ss.title}>방금 걸은 구간, 어땠나요?</Text>
      <Text style={ss.sub}>경사가 뚜렷했던 구간만 짧게 여쭤봐요. 한 번씩만 눌러 주세요.</Text>

      <View style={{ flex: 1, justifyContent: "center", gap: 20 }}>
        {targets.map((t, i) => (
          <View key={i} style={ss.card}>
            <Text style={ss.segTitle}>{fmtSlope(t.slope_mean)} · {fmtLen(t.length_m)}</Text>
            {hasMap && (
              <TouchableOpacity
                style={ss.mapLinkBtn}
                activeOpacity={0.7}
                onPress={() => setMapTargetIdx(i)}
                hitSlop={{ top: 4, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={ss.mapLinkText}>🗺 지도로 확인하기</Text>
              </TouchableOpacity>
            )}
            <View style={ss.choiceRow}>
              {CHOICES.map((c) => {
                const on = answers[i] === c.key;
                return (
                  <TouchableOpacity
                    key={c.key}
                    style={[ss.choice, on && ss.choiceOn]}
                    activeOpacity={0.8}
                    onPress={() => setAnswers((a) => ({ ...a, [i]: c.key }))}
                  >
                    <Text style={ss.choiceEmoji}>{c.emoji}</Text>
                    <Text style={[ss.choiceLabel, on && ss.choiceLabelOn]}>{c.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))}
      </View>

      <View style={{ gap: 10, marginBottom: insets.bottom + 12 }}>
        <TouchableOpacity style={[ss.cta, !allAnswered && ss.ctaOff]} disabled={!allAnswered} onPress={submit}>
          <Text style={ss.ctaText}>완료</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={goNext}>
          <Text style={ss.skip}>건너뛰기</Text>
        </TouchableOpacity>
      </View>

      {/* 지도로 확인하기 — 전체 경로(회색) 위에 이 구간(강조색)만 표시. 눌렀을 때만
          마운트해 WebView 비용을 평소엔 안 물게 한다. */}
      <Modal
        visible={mapTargetIdx !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setMapTargetIdx(null)}
      >
        <View style={ss.mapModalBackdrop}>
          <View style={[ss.mapModalCard, { marginBottom: insets.bottom + 16 }]}>
            <View style={ss.mapModalHeader}>
              <Text style={ss.mapModalTitle}>
                {mapTargetIdx !== null ? fmtSlope(targets[mapTargetIdx].slope_mean) : ""} 구간
              </Text>
              <TouchableOpacity onPress={() => setMapTargetIdx(null)} hitSlop={10}>
                <Text style={ss.mapModalClose}>닫기</Text>
              </TouchableOpacity>
            </View>
            <View style={ss.mapModalBox}>
              {mapModalRoutes && (
                <RouteMapView
                  routes={mapModalRoutes}
                  selectedRouteId="walked"
                  showSlopeMarkers
                />
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
  title: { fontSize: 19, fontWeight: "800", color: C.text, textAlign: "center" },
  sub: { fontSize: 13, color: C.textSub, textAlign: "center", marginTop: 8, lineHeight: 19 },
  card: { backgroundColor: C.white, borderRadius: 16, padding: 18 },
  segTitle: { fontSize: 15, fontWeight: "700", color: C.text, textAlign: "center", marginBottom: 2 },
  mapLinkBtn: { alignSelf: "center", marginBottom: 12, paddingVertical: 4, paddingHorizontal: 8 },
  mapLinkText: { fontSize: 12.5, fontWeight: "700", color: C.primaryDark },
  choiceRow: { flexDirection: "row", gap: 10 },
  choice: { flex: 1, alignItems: "center", paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.white },
  choiceOn: { borderColor: C.primary, backgroundColor: C.primaryBg },
  choiceEmoji: { fontSize: 24 },
  choiceLabel: { marginTop: 6, fontSize: 13, fontWeight: "600", color: C.textSub },
  choiceLabelOn: { color: C.primaryDark },
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
