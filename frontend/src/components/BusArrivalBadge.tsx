// 대중교통 버스 스텝에 붙는 실시간 도착 배지.
// GET /bus/arrival 을 마운트 시 + 20초마다 호출. available:false 면 아무것도 안 그린다
// (정적 카카오 시간 유지 — graceful degradation). 서버 키 미설정이면 항상 이 상태.

import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { C } from "../constants/colors";
import { getBusArrival, type BusArrival } from "../api/busArrival";

const REFRESH_MS = 20_000;

/** 초 → "3분", "3분 20초", "곧 도착", "1분 미만" */
function fmtEta(sec: number | null, arriving: boolean): string {
  if (arriving) return "곧 도착";
  if (sec == null) return "";
  if (sec < 60) return "1분 미만";
  const m = Math.floor(sec / 60);
  const s = Math.round((sec - m * 60) / 10) * 10;
  return s === 0 || s === 60 ? `${m + (s === 60 ? 1 : 0)}분` : `${m}분 ${s}초`;
}

type Props = {
  routeName: string;          // 버스 번호
  stopName?: string;          // 승차 정류소명
  arsId?: string;
  walkRemainingS?: number;    // 승차 정류소까지 남은 도보 시간(초) — 놓칠 위험 계산용
};

export default function BusArrivalBadge({ routeName, stopName, arsId, walkRemainingS }: Props) {
  const [data, setData] = useState<BusArrival | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getBusArrival({ route: routeName, stop: stopName, arsId, walkRemainingS })
        .then((d) => { if (alive) setData(d); })
        .catch(() => { if (alive) setData(null); });
    };
    load();
    timer.current = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, [routeName, stopName, arsId, walkRemainingS]);

  if (!data || !data.available || data.buses.length === 0) return null;

  const b0 = data.buses[0];
  const eta = fmtEta(b0.seconds, b0.arriving);
  const stale = (data.data_age_s ?? 0) > 90;

  return (
    <View style={ss.wrap}>
      <View style={[ss.pill, data.will_miss ? ss.pillWarn : ss.pillOk]}>
        <View style={[ss.dot, { backgroundColor: data.will_miss ? C.danger : C.success }]} />
        <Text style={[ss.pillText, data.will_miss && { color: C.danger }]}>
          실시간 · 다음 버스 {eta}
          {b0.congestion ? ` · ${b0.congestion}` : ""}
          {b0.last_bus ? " · 막차" : ""}
        </Text>
      </View>
      {data.will_miss && data.margin_s != null && (
        <Text style={ss.missText}>도보보다 {Math.abs(Math.round(data.margin_s / 60))}분 빨라요 — 다음 차를 노려보세요</Text>
      )}
      {!data.will_miss && data.margin_s != null && data.margin_s < 120 && (
        <Text style={ss.tightText}>여유 {Math.max(0, Math.round(data.margin_s / 60))}분 — 서두르면 탈 수 있어요</Text>
      )}
      {data.buses[1]?.seconds != null && (
        <Text style={ss.subText}>다다음 {fmtEta(data.buses[1].seconds, data.buses[1].arriving)}</Text>
      )}
      {stale && <Text style={ss.subText}>{Math.round((data.data_age_s ?? 0) / 60)}분 전 기준</Text>}
    </View>
  );
}

const ss = StyleSheet.create({
  wrap: { marginTop: 6, gap: 3 },
  pill: {
    flexDirection: "row", alignItems: "center", alignSelf: "flex-start",
    paddingVertical: 4, paddingHorizontal: 9, borderRadius: 11, borderWidth: 1,
  },
  pillOk:   { backgroundColor: C.busBg, borderColor: C.bus + "55" },
  pillWarn: { backgroundColor: "#FFECEC", borderColor: C.danger + "55" },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  pillText: { fontSize: 11.5, fontWeight: "700", color: C.bus },
  missText:  { fontSize: 11, color: C.danger, fontWeight: "600" },
  tightText: { fontSize: 11, color: C.warn, fontWeight: "600" },
  subText:   { fontSize: 10.5, color: C.textMute },
});
