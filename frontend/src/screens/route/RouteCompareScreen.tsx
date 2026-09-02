// 3경로 비교 화면 (⑬) — ando_ml_plan_v2 §6, 인계 §5
//
// 규칙(문서에서 못박음):
//   - 라벨 절대 금지. "경로 A / B / C" 중립 표기만. kind(type/distance/personal)는
//     화면에 절대 노출하지 않는다(§6.5). 표시 순서는 매번 무작위(shownPos 기록).
//   - 선택 결과는 개별 POST 없이 CollectSession → /collect/batch route_choice 로만.
//   - 선택 후 안내로 넘어갈 때 collectSessionId 를 함께 넘겨 같은 세션으로 계측을 이어붙인다.
//
// ⚠️ 현재 백엔드는 candidateRoutes 에 1개(kind:"type")만 채운다 → 화면엔 "경로 A" 1장만
//    뜬다("비교 없음", chosen_kind=null). distance/personal 이 붙으면 자동으로 2~3장이 된다.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { C } from "../../constants/colors";
import RouteMapView, { type MapRoute } from "./RouteMapView";
import { requestRouteCandidates } from "../../api/routeCompare";
import {
  buildComparison,
  buildRouteChoicePayload,
  type ShownCandidate,
} from "../../utils/routeChoiceModel";
import { CollectSession } from "../../utils/collectQueue";

type Props = {
  navigation: any;
  route?: {
    params?: {
      from?: string;
      to?: string;
      walkerType?: string;
      startName?: string;
      startAddress?: string;
      startLatitude?: string;
      startLongitude?: string;
      endName?: string;
      endAddress?: string;
      endLatitude?: string;
      endLongitude?: string;
    };
  };
};

// 위치/순서 편향을 피하려 의미 없는 중립 팔레트 (좋음/나쁨 연상 없는 색).
const LANE_COLORS = ["#7C6FF7", "#2FB5A8", "#E8833A"];

function fmtDist(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}
function fmtTime(s: number) {
  const min = Math.max(1, Math.round(s / 60));
  return `약 ${min}분`;
}

export default function RouteCompareScreen({ navigation, route }: Props) {
  const p = route?.params ?? {};
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<ShownCandidate[]>([]);
  const [selectedPos, setSelectedPos] = useState<number | null>(null);

  // 화면 진입 시 계측 세션을 연다 — 선택 로그와 이후 안내 계측이 같은 session_id 를 공유한다.
  const collectRef = useRef<CollectSession | null>(null);
  if (collectRef.current === null) collectRef.current = new CollectSession();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await requestRouteCandidates({
          startLatitude:  p.startLatitude ?? "",
          startLongitude: p.startLongitude ?? "",
          endLatitude:    p.endLatitude ?? "",
          endLongitude:   p.endLongitude ?? "",
          userType:       p.walkerType || "manual_wheelchair",
        });
        if (!alive) return;
        const { shown: s } = buildComparison(res.candidateRoutes);
        setShown(s);
        setSelectedPos(s.length === 1 ? 0 : null);
      } catch (e: any) {
        if (alive) setError(e?.message ?? "경로를 불러오지 못했습니다.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      // 선택 없이 화면을 벗어나면 세션을 닫아 버퍼를 비운다(빈 배치는 안 나감).
      void collectRef.current?.flush({ final: true });
      collectRef.current = null;
    };
  }, []);

  const mapRoutes: MapRoute[] = useMemo(
    () =>
      shown.map((s) => ({
        id: String(s.shownPos),
        color: LANE_COLORS[s.shownPos] ?? C.primary,
        coordinates: (s.route.coordinates ?? []).map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
      })),
    [shown],
  );

  const proceed = () => {
    if (selectedPos === null) return;
    const chosen = shown.find((s) => s.shownPos === selectedPos) ?? null;
    const cs = collectRef.current;
    if (cs && chosen) {
      cs.setRouteChoice(buildRouteChoicePayload(shown, chosen));
      cs.flush().catch(() => {});
    }
    const sessionId = cs?.sessionId;
    collectRef.current = null; // 아래 navigate 로 언마운트되므로 cleanup 의 flush 중복 방지

    if (!chosen) return;
    navigation?.navigate("Navigation", {
      mode: "walk",
      from: p.from,
      to: p.to,
      walkerType: p.walkerType,
      startName: p.startName,
      startAddress: p.startAddress,
      startLatitude: p.startLatitude,
      startLongitude: p.startLongitude,
      endName: p.endName,
      endAddress: p.endAddress,
      endLatitude: p.endLatitude,
      endLongitude: p.endLongitude,
      collectSessionId: sessionId,
      routeData: JSON.stringify({
        coordinates: chosen.route.coordinates,
        routeSegments: chosen.route.routeSegments,
        totalDistance: chosen.route.totalDistance,
        avgSlope: chosen.route.avgSlope,
        estimatedTimeS: chosen.route.estimatedTimeS,
      }),
    });
  };

  if (loading) {
    return (
      <View style={[ss.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={C.primary} />
        <Text style={ss.muted}>경로를 비교하는 중…</Text>
      </View>
    );
  }
  if (error || shown.length === 0) {
    return (
      <View style={[ss.center, { paddingTop: insets.top }]}>
        <Text style={ss.errIcon}>🗺</Text>
        <Text style={ss.errTitle}>경로를 표시할 수 없습니다</Text>
        <Text style={ss.muted}>{error || "후보 경로가 없습니다."}</Text>
        <TouchableOpacity style={ss.ghostBtn} onPress={() => navigation?.goBack()}>
          <Text style={ss.ghostBtnText}>돌아가기</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const single = shown.length === 1;

  return (
    <View style={[ss.screen, { paddingTop: insets.top }]}>
      <View style={ss.header}>
        <TouchableOpacity onPress={() => navigation?.goBack()} hitSlop={12}>
          <Text style={ss.back}>‹</Text>
        </TouchableOpacity>
        <Text style={ss.title} numberOfLines={1}>{p.from ?? "출발"} → {p.to ?? "도착"}</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={ss.mapBox}>
        <RouteMapView
          routes={mapRoutes}
          selectedRouteId={selectedPos !== null ? String(selectedPos) : String(shown[0].shownPos)}
          startLabel={p.from}
          endLabel={p.to}
          showSlopeMarkers={false}
        />
      </View>

      <Text style={ss.hint}>
        {single
          ? "지금은 비교할 다른 경로가 없어 한 가지만 안내됩니다."
          : "걷기 편해 보이는 경로를 하나 고르세요. 순서는 매번 무작위입니다."}
      </Text>

      <ScrollView style={ss.list} contentContainerStyle={{ paddingBottom: 8 }}>
        {shown.map((s) => {
          const on = s.shownPos === selectedPos;
          return (
            <TouchableOpacity
              key={s.shownPos}
              activeOpacity={0.8}
              style={[ss.card, on && ss.cardOn]}
              onPress={() => setSelectedPos(s.shownPos)}
            >
              <View style={[ss.dot, { backgroundColor: LANE_COLORS[s.shownPos] ?? C.primary }]} />
              <View style={{ flex: 1 }}>
                <Text style={ss.cardLabel}>{s.label}</Text>
                <Text style={ss.cardMeta}>
                  {fmtDist(s.route.totalDistance)} · 평균 경사 {Number(s.route.avgSlope ?? 0).toFixed(1)}% · {fmtTime(s.route.estimatedTimeS)}
                </Text>
              </View>
              <View style={[ss.radio, on && ss.radioOn]}>{on ? <View style={ss.radioInner} /> : null}</View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <TouchableOpacity
        style={[ss.cta, selectedPos === null && ss.ctaOff, { marginBottom: insets.bottom + 12 }]}
        disabled={selectedPos === null}
        onPress={proceed}
      >
        <Text style={ss.ctaText}>{single ? "이 경로로 안내 시작" : "이 경로로 안내 시작"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const ss = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: C.bg, gap: 10, padding: 24 },
  muted: { color: C.textMute, fontSize: 13, textAlign: "center" },
  errIcon: { fontSize: 40 },
  errTitle: { fontSize: 16, fontWeight: "700", color: C.text },
  ghostBtn: { marginTop: 8, paddingVertical: 10, paddingHorizontal: 20, borderRadius: 10, borderWidth: 1, borderColor: C.border },
  ghostBtnText: { color: C.textSub, fontWeight: "600" },

  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10 },
  back: { fontSize: 28, color: C.navy, width: 24 },
  title: { flex: 1, textAlign: "center", fontSize: 15, fontWeight: "700", color: C.text },

  mapBox: { height: 260, marginHorizontal: 12, borderRadius: 14, overflow: "hidden", backgroundColor: C.white },
  hint: { color: C.textSub, fontSize: 12.5, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 4 },

  list: { flexGrow: 0, paddingHorizontal: 12, marginTop: 4 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.white, borderRadius: 12, padding: 14, marginTop: 8, borderWidth: 1.5, borderColor: "transparent" },
  cardOn: { borderColor: C.primary, backgroundColor: C.primaryBg },
  dot: { width: 12, height: 12, borderRadius: 6 },
  cardLabel: { fontSize: 15, fontWeight: "700", color: C.text },
  cardMeta: { fontSize: 12.5, color: C.textSub, marginTop: 3 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.border, alignItems: "center", justifyContent: "center" },
  radioOn: { borderColor: C.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.primary },

  cta: { backgroundColor: C.primary, marginHorizontal: 16, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  ctaOff: { backgroundColor: C.primaryLight },
  ctaText: { color: C.white, fontSize: 15, fontWeight: "700" },
});
