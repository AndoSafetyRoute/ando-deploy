// 구간 평가 화면 (⑭) — 안내 종료(만족도) 후 경사 뚜렷한 구간 1~2개에 대해
// "편함 / 보통 / 불편함" 단일 탭. ando_ml_plan_v2 §3.2 신호 D, §5.6(μEMA — 반복 부담 최소).
//
// 저장: CollectSession.addSegmentFeedback → /collect/batch. segment_feedback 테이블은
// session_id 컬럼이 없고 route_id 로 연결되므로(§3.7), 여기선 자체 세션을 새로 열고
// serverRouteId 만 있으면 된다.
//
// 평가할 구간이 없으면(완만한 경로) 화면 없이 곧장 다음으로 넘어간다.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { C } from "../../constants/colors";
import { CollectSession } from "../../utils/collectQueue";
import {
  pickFeedbackSegments,
  VERDICT,
  type VerdictLabel,
} from "../../utils/segmentFeedbackModel";

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

  const [answers, setAnswers] = useState<Record<number, VerdictLabel>>({});
  const collectRef = useRef<CollectSession | null>(null);
  if (collectRef.current === null) collectRef.current = new CollectSession();

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
    </View>
  );
}

const ss = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 20 },
  title: { fontSize: 19, fontWeight: "800", color: C.text, textAlign: "center" },
  sub: { fontSize: 13, color: C.textSub, textAlign: "center", marginTop: 8, lineHeight: 19 },
  card: { backgroundColor: C.white, borderRadius: 16, padding: 18 },
  segTitle: { fontSize: 15, fontWeight: "700", color: C.text, textAlign: "center", marginBottom: 14 },
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
});
