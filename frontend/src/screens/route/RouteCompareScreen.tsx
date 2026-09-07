// 3경로 비교 화면 (⑬) — ando_ml_plan_v2 §6, 인계 §5
//
// 2026-09 제품 결정 (routeChoiceModel.ts 상단 주석 참고):
//   - 표시 순서 고정: 거리 우선 → 유형별 추천 → 사용자 맞춤형 (CANDIDATE_ORDER).
//     라벨도 설명적으로 노출한다(예전엔 "경로 A/B/C" 중립 + 매번 무작위 순서였다).
//   - 사용자 맞춤형(personal)이 아직 없으면(⑨ 배치 학습 전엔 항상 그렇다) 카드를
//     생략하지 않고 **비활성 카드 + "아직 준비중입니다"** 로 자리를 지킨다 — 위치가
//     고정이라 "그 자리엔 언젠가 맞춤 경로가 온다"를 사용자가 학습할 수 있게.
//   - 선택 결과는 개별 POST 없이 CollectSession → /collect/batch route_choice 로만.
//   - 선택 후 안내로 넘어갈 때 collectSessionId 를 함께 넘겨 같은 세션으로 계측을 이어붙인다.
//
// ⚠️ 현재 백엔드는 candidateRoutes 에 1~2개(type, CCH 있으면 distance)만 채운다 →
//    "사용자 맞춤형" 자리는 항상 비활성 표시된다. ⑨ 배치가 채워지면 자동으로 활성화된다.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { C } from "../../constants/colors";
import RouteMapView, { type MapRoute } from "./RouteMapView";
import { requestRouteCandidates, type RoutingComparison, type DebugRoute } from "../../api/routeCompare";
import {
  buildComparison,
  buildRouteChoicePayload,
  type ShownCandidate,
} from "../../utils/routeChoiceModel";
import { CollectSession } from "../../utils/collectQueue";
import { getCollectConsent } from "../../personalization/collectConsent";

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

// 순서가 고정(거리 우선/유형별/맞춤형)이라 색도 그 순서에 고정 대응된다.
// 앱 공용 토큰(C)에서 그대로 가져와 다른 화면과 색感이 어긋나지 않게 한다.
const LANE_COLORS = [C.primary, C.success, C.warn];

function fmtDist(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}
function fmtTime(s: number) {
  const min = Math.max(1, Math.round(s / 60));
  return `약 ${min}분`;
}

// ── __DEV__ 전용: 최단경로 2종(CCH vs NetworkX) 계측 패널 ──────────────────────
function DebugPanel({
  cmp, open, onToggle,
}: { cmp: RoutingComparison; open: boolean; onToggle: () => void }) {
  const sc: any = cmp.shortest_cch ?? {};
  const sn: any = cmp.shortest_nx ?? {};
  const ec = cmp.engine_compare;
  const dt = cmp.detour;
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <View style={ss.dbgRow}><Text style={ss.dbgK}>{k}</Text><Text style={ss.dbgV}>{v}</Text></View>
  );
  return (
    <View style={ss.dbg}>
      <TouchableOpacity onPress={onToggle} activeOpacity={0.7}>
        <Text style={ss.dbgTitle}>{open ? "▾" : "▸"} 최단경로 비교 (DEV)</Text>
      </TouchableOpacity>
      {open && (
        <View style={{ marginTop: 6 }}>
          {dt && (
            <>
              <Row k="유형 우회율 (type ÷ 최단CCH)" v={`${dt.type_vs_shortest?.toFixed(3)}x`} />
              {dt.safe_distance_vs_shortest != null && (
                <Row k="급경사배제 우회율 (distance ÷ 최단)" v={`${dt.safe_distance_vs_shortest.toFixed(3)}x`} />
              )}
              <Row k="순수 최단거리 (CCH)" v={`${Math.round(dt.base_length_m)}m`} />
            </>
          )}
          <View style={ss.dbgHr} />
          <Row k="CCH 쿼리" v={"query_ms" in sc ? `${sc.query_ms}ms · path ${sc.path_nodes}노드` : (sc.error ?? "-")} />
          <Row k="NetworkX 쿼리" v={
            "query_ms" in sn
              ? `${sn.query_ms}ms · settled ${sn.nodes_settled?.toLocaleString()} · relax ${sn.edges_relaxed?.toLocaleString()} · heap↑${sn.peak_heap?.toLocaleString()}`
              : (sn.skipped ?? sn.error ?? "-")
          } />
          {ec && (
            <>
              <View style={ss.dbgHr} />
              <Row k="속도차 (NX ÷ CCH)" v={`${ec.speedup_x}x 느림`} />
              <Row k="탐색량 (NX settled ÷ CCH path)" v={ec.settled_vs_pathnodes_x != null ? `${ec.settled_vs_pathnodes_x}x` : "-"} />
              <Row k="경로 동일" v={ec.paths_identical ? "예" : `아니오 (Δ${ec.length_delta_m}m)`} />
            </>
          )}
          {cmp.od_straight_m != null && <Row k="직선거리" v={`${Math.round(cmp.od_straight_m)}m`} />}
        </View>
      )}
    </View>
  );
}

export default function RouteCompareScreen({ navigation, route }: Props) {
  const p = route?.params ?? {};
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<ShownCandidate[]>([]);
  const [selectedPos, setSelectedPos] = useState<number | null>(null);
  // __DEV__ 디버그 전용 — 최단경로 2종 비교 계측값 + 지도에 겹쳐 그릴 좌표.
  const [routingCmp, setRoutingCmp] = useState<RoutingComparison | null>(null);
  const [debugRoutes, setDebugRoutes] = useState<DebugRoute[]>([]);
  const [showDebug, setShowDebug] = useState(true);

  // 화면 진입 시 계측 세션을 연다 — 선택 로그와 이후 안내 계측이 같은 session_id 를 공유한다.
  // 동의 전엔 세션 자체를 안 만든다(이하 collectRef.current?. 호출은 전부 안전하게 no-op) —
  // 예전엔 동의 여부와 무관하게 항상 세션을 만들어 route_choice 를 그대로 보냈었다.
  const collectRef = useRef<CollectSession | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const consent = await getCollectConsent();
        if (alive && consent === "granted") collectRef.current = new CollectSession();
      } catch { /* 동의 확인 실패 시 수집 안 함(보수적 기본값) */ }

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
        if (__DEV__) {
          setRoutingCmp(res.routingComparison ?? null);
          setDebugRoutes(res.debugRoutes ?? []);
        }
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
    () => [
      ...shown.map((s) => ({
        id: String(s.shownPos),
        color: LANE_COLORS[s.shownPos] ?? C.primary,
        coordinates: (s.route.coordinates ?? []).map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
      })),
      // __DEV__: 최단경로 2종(CCH 주황 / NetworkX 보라)을 지도에 겹쳐 그린다.
      ...(__DEV__
        ? debugRoutes.map((d) => ({
            id: `dbg-${d.kind}`,
            color: d.color,
            coordinates: (d.coordinates ?? []).map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
          }))
        : []),
    ],
    [shown, debugRoutes],
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
        navigation_segments: chosen.route.navigation_segments ?? [],
        waypoints: chosen.route.waypoints ?? [],
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
          : "걷기 편해 보이는 경로를 하나 고르세요."}
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

        {/* release_v4: 테스트 데이터 적용 전까지 제공 경로를 2종으로 축소한다
            — ① 거리 우선, ② 유형별 경계 점수 반영. "사용자 맞춤형" 비활성 자리표시
            카드는 이 버전에서 노출하지 않는다(⑨ 배치 학습/테스트 데이터가 들어오면
            BE 가 personal 후보를 다시 채우고 buildComparison 이 알아서 3번째 카드를
            만든다 — 그때 이 자리표시 UI 복원 여부를 다시 판단). */}
      </ScrollView>

      {__DEV__ && routingCmp && (
        <DebugPanel cmp={routingCmp} open={showDebug} onToggle={() => setShowDebug((v) => !v)} />
      )}

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

  dbg: { marginHorizontal: 12, marginTop: 4, marginBottom: 6, padding: 10, borderRadius: 10, backgroundColor: "#1B0F4A0D", borderWidth: 1, borderColor: C.border },
  dbgTitle: { fontSize: 12, fontWeight: "800", color: C.navy },
  dbgRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 2, gap: 10 },
  dbgK: { fontSize: 11, color: C.textSub, flexShrink: 1 },
  dbgV: { fontSize: 11, color: C.text, fontWeight: "700", textAlign: "right", flexShrink: 1 },
  dbgHr: { height: 1, backgroundColor: C.border, marginVertical: 4 },

  cta: { backgroundColor: C.primary, marginHorizontal: 16, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  ctaOff: { backgroundColor: C.primaryLight },
  ctaText: { color: C.white, fontSize: 15, fontWeight: "700" },
});
