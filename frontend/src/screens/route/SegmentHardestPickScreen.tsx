// S5 — "가장 힘들었던 구간" 문항. SlowSegmentFeedbackScreen(3버튼 흐름)을 마친
// 뒤에 이어지는 화면. 같은 구간 목록(GET /navigation/{route_id}/slow-segments,
// question_order로 이미 순위/대조가 섞여 옴)에서 하나를 고르거나 "비슷했어요"를
// 고른다. 별도 엔드포인트(POST .../segment-hardest-pick)로 제출 — 설계 이유는
// database.py save_segment_hardest_pick 참고(3버튼 제출과 원자적으로 묶을
// 이유가 없음).
//
// 물어볼 구간이 없거나(eligible:false) route_id가 없으면 화면 없이 곧장
// RouteDetail로(SlowSegmentFeedbackScreen과 동일 원칙).

import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { C } from "../../constants/colors";
import RouteMapView, { type MapRoute } from "./RouteMapView";
import { getSlowSegments, postSegmentHardestPick } from "../../api/slowSegments";
import {
  hasSlowSegments,
  fmtPace,
  type SlowSegment,
  type SlowSegmentsResponse,
} from "../../utils/slowSegmentModel";
import type { MeasurementUnit } from "../../api/routeApi";

type RawSeg = {
  start?: { latitude?: number; longitude?: number };
  end?:   { latitude?: number; longitude?: number };
};

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
      routeSegments?: string;
      measurementUnits?: string;
      serverRouteId?: string;
      nextRouteId?:   string;
      sessionId?:     string;
    };
  };
};

const NONE_KEY = -1; // "비슷했어요" 선택값(seg_index는 항상 >=0이라 안전하게 구분 가능)

export default function SegmentHardestPickScreen({ navigation, route }: Props) {
  const insets = useSafeAreaInsets();
  const p = route?.params ?? {};

  const segsRaw: RawSeg[] = useMemo(() => {
    try { return JSON.parse(p.routeSegments ?? "[]"); } catch { return []; }
  }, [p.routeSegments]);
  const measurementUnits: (MeasurementUnit | null)[] = useMemo(() => {
    try { return JSON.parse(p.measurementUnits ?? "[]"); } catch { return []; }
  }, [p.measurementUnits]);
  const serverRouteId = p.serverRouteId ? Number(p.serverRouteId) : null;

  const [loading, setLoading] = useState(true);
  const [resp, setResp] = useState<SlowSegmentsResponse | null>(null);
  const [selected, setSelected] = useState<number | null>(null); // seg_index 또는 NONE_KEY
  const [submitting, setSubmitting] = useState(false);
  const wentNextRef = React.useRef(false);

  const goNext = () => {
    if (wentNextRef.current) return;
    wentNextRef.current = true;
    navigation?.navigate("RouteDetail", { routeId: p.nextRouteId ?? "" });
  };

  useEffect(() => {
    let alive = true;
    if (serverRouteId == null || !Number.isFinite(serverRouteId)) { goNext(); return; }
    getSlowSegments(serverRouteId)
      .then((r) => { if (alive) setResp(r); })
      .catch((e) => { if (alive) { console.log("[FE] slow-segments(hardest-pick) 조회 실패:", e); setResp(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [serverRouteId]);

  const segments: SlowSegment[] = resp?.segments ?? [];
  const eligible = hasSlowSegments(resp);

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

  const selectedSeg = selected != null && selected !== NONE_KEY
    ? segments.find((s) => s.seg_index === selected) ?? null
    : null;

  const highlightCoords = (() => {
    if (!selectedSeg) return [];
    const unit = measurementUnits[selectedSeg.seg_index];
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
    segments: selectedSeg ? [{
      coordinates: highlightCoords,
      color: C.primary,
      slopeMean: selectedSeg.slope_pct,
      zone: selectedSeg.zone || "warning",
    }] : [],
  }];

  const submit = async () => {
    if (submitting || selected == null) return;
    setSubmitting(true);
    try {
      if (serverRouteId != null) {
        await postSegmentHardestPick(serverRouteId, {
          session_id: p.sessionId || null,
          shown_seg_indices: segments.map((s) => s.seg_index),
          picked_seg_index: selected === NONE_KEY ? null : selected,
          picked_none: selected === NONE_KEY,
        });
      }
    } catch (e) {
      console.log("[FE] segment-hardest-pick 저장 실패:", e); // 저장 실패해도 흐름은 계속
    } finally {
      setSubmitting(false);
      goNext();
    }
  };

  return (
    <View style={[ss.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <Text style={ss.title}>이 중 가장 힘들었던 구간은?</Text>
      <Text style={ss.sub}>방금 답하신 구간들 중에서 골라주세요.</Text>

      <View style={ss.inlineMapBox}>
        {hasMap && mapRoutes ? (
          <RouteMapView routes={mapRoutes} selectedRouteId="walked" showSlopeMarkers />
        ) : (
          <View style={ss.mapFallback}>
            <Text style={ss.mapFallbackText}>지도 정보가 없어요</Text>
          </View>
        )}
      </View>

      <ScrollView style={ss.list} contentContainerStyle={ss.listContent}>
        {segments.map((s, i) => {
          const isOn = selected === s.seg_index;
          return (
            <TouchableOpacity
              key={s.seg_index}
              style={[ss.row, isOn && ss.rowOn]}
              activeOpacity={0.8}
              onPress={() => setSelected(s.seg_index)}
            >
              <View style={[ss.radio, isOn && ss.radioOn]}>
                {isOn && <View style={ss.radioDot} />}
              </View>
              <View style={ss.rowBody}>
                <Text style={[ss.rowTitle, isOn && ss.rowTitleOn]}>
                  구간 {i + 1}{s.name ? ` · ${s.name}` : ""}
                </Text>
                <Text style={ss.rowSub}>
                  {s.distance_m.toFixed(0)}m · {fmtPace(s.pace_s_per_m)}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity
          style={[ss.row, selected === NONE_KEY && ss.rowOn]}
          activeOpacity={0.8}
          onPress={() => setSelected(NONE_KEY)}
        >
          <View style={[ss.radio, selected === NONE_KEY && ss.radioOn]}>
            {selected === NONE_KEY && <View style={ss.radioDot} />}
          </View>
          <Text style={[ss.rowTitle, selected === NONE_KEY && ss.rowTitleOn]}>비슷했어요</Text>
        </TouchableOpacity>
      </ScrollView>

      <TouchableOpacity
        style={[ss.cta, (selected == null || submitting) && ss.ctaOff]}
        disabled={selected == null || submitting}
        onPress={submit}
      >
        <Text style={ss.ctaText}>{submitting ? "저장 중…" : "완료"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const ss = StyleSheet.create({
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: C.bg },
  screen: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 18 },

  title: { fontSize: 18, fontWeight: "800", color: C.text, marginTop: 8 },
  sub: { fontSize: 12.5, color: C.textSub, marginTop: 6, lineHeight: 18 },

  inlineMapBox: {
    height: 220, borderRadius: 14, overflow: "hidden",
    marginTop: 14, backgroundColor: C.white,
  },
  mapFallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  mapFallbackText: { fontSize: 13, color: C.textMute, fontWeight: "600" },

  list: { flex: 1, marginTop: 14 },
  listContent: { paddingBottom: 8, gap: 8 },

  row: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.white, borderRadius: 14, padding: 14,
    borderWidth: 1.5, borderColor: C.border,
  },
  rowOn: { borderColor: C.primary, backgroundColor: "#EFEEFF" },

  radio: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: C.border,
    alignItems: "center", justifyContent: "center", marginRight: 12,
  },
  radioOn: { borderColor: C.primary },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.primary },

  rowBody: { flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: "700", color: C.text },
  rowTitleOn: { color: C.primaryDark },
  rowSub: { fontSize: 12, color: C.textSub, marginTop: 2 },

  cta: { marginTop: 12, backgroundColor: C.primary, borderRadius: 14, paddingVertical: 14, alignItems: "center" },
  ctaOff: { backgroundColor: C.primaryLight },
  ctaText: { color: C.white, fontSize: 15, fontWeight: "700" },
});
