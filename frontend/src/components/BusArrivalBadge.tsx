// 대중교통 버스 스텝에 붙는 실시간 도착 배지.
// GET /bus/arrival 을 마운트 시 + 20초마다 호출. available:false 면 아무것도 안 그린다
// (정적 카카오 시간 유지 — graceful degradation). 서버 키 미설정이면 항상 이 상태.
// 20초 폴링 사이에도 화면이 멈춰 있지 않도록, 매초 로컬에서 남은 시간을 깎아
// 보여준다(서버가 준 값 + 그 값이 이미 얼마나 오래됐는지(data_age_s) + 우리가
// 마지막으로 받아온 뒤 흐른 시간을 합쳐서 뺀다) — 0 밑으로는 절대 안 내려간다.

import React, { useEffect, useRef, useState, useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { C } from "../constants/colors";
import { fmtArrivalApprox } from "../utils/arrivalTime";
import { getBusArrival, type BusArrival } from "../api/busArrival";

const REFRESH_MS = 20_000;
const TICK_MS = 1_000;

/** 초 → "약 N분"(30초 기준 반올림) / "곧 도착" */
function fmtEta(sec: number | null, arriving: boolean): string {
  return fmtArrivalApprox(sec, arriving);
}

type Props = {
  routeName: string;          // 버스 번호
  stopName?: string;          // 승차 정류소명
  arsId?: string;
  walkRemainingS?: number;    // 승차 정류소까지 남은 도보 시간(초) — 놓칠 위험 계산용
};

export default function BusArrivalBadge({ routeName, stopName, arsId, walkRemainingS }: Props) {
  const [data, setData] = useState<BusArrival | null>(null);
  const [loading, setLoading] = useState(false);
  const [, forceTick] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // 서버 응답을 실제로 받은 시각(로컬 시계) — 매초 다시 그릴 때 이 시각부터
  // 얼마나 흘렀는지 계산해서 표시 초를 깎는 데 쓴다.
  const fetchedAtRef = useRef<number>(0);
  // 경로 목록이 바뀌어 배지가 사라진 뒤 늦게 도착한 응답으로 setState 하지 않게.
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    setLoading(true);
    getBusArrival({ route: routeName, stop: stopName, arsId, walkRemainingS })
      .then((d) => {
        if (!aliveRef.current) return;
        setData(d);
        fetchedAtRef.current = Date.now();
      })
      .catch(() => { if (aliveRef.current) setData(null); })
      .finally(() => { if (aliveRef.current) setLoading(false); });
  }, [routeName, stopName, arsId, walkRemainingS]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    pollTimer.current = setInterval(load, REFRESH_MS);
    return () => {
      aliveRef.current = false;
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [load]);

  // 20초 폴링과 별개로 매초 리렌더만 트리거 — 실제 값 계산은 렌더 시점에
  // Date.now()로 직접 하므로 이 state 값 자체는 쓰지 않는다.
  useEffect(() => {
    tickTimer.current = setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => {
      if (tickTimer.current) clearInterval(tickTimer.current);
    };
  }, []);

  if (!data || !data.available || data.buses.length === 0) return null;

  // 서버가 이 값을 낸 시점(mkTm) 이후 흐른 시간(data_age_s) + 우리가 그 응답을
  // 받은 뒤 흐른 시간을 합쳐서 뺀다. Math.max(0, ...)로 음수는 절대 안 나온다.
  const totalElapsedS = (data.data_age_s ?? 0) + Math.floor((Date.now() - fetchedAtRef.current) / 1000);
  const liveSeconds = (raw: number | null) => (raw == null ? null : Math.max(0, raw - totalElapsedS));

  const b0 = data.buses[0];
  const b0Seconds = liveSeconds(b0.seconds);
  const eta = fmtEta(b0Seconds, b0.arriving);
  const stale = (data.data_age_s ?? 0) > 90;

  return (
    <View style={ss.wrap}>
      <View style={[ss.pill, data.will_miss ? ss.pillWarn : (b0.is_lowfloor ? ss.pillLowfloor : ss.pillOk)]}>
        <View style={[ss.dot, { backgroundColor: data.will_miss ? C.danger : C.success }]} />
        <Text style={[ss.pillText, data.will_miss && { color: C.danger }]}>
          {b0.is_lowfloor ? "♿ 저상 · " : ""}
          실시간 · 다음 버스 {eta}
          {b0.congestion ? ` · ${b0.congestion}` : ""}
          {b0.last_bus ? " · 막차" : ""}
        </Text>
        <TouchableOpacity onPress={load} disabled={loading} hitSlop={8} style={ss.refreshBtn}>
          <Text style={[ss.refreshIcon, loading && ss.refreshIconBusy]}>↻</Text>
        </TouchableOpacity>
      </View>
      {data.will_miss && data.margin_s != null && (
        <Text style={ss.missText}>도보보다 {Math.abs(Math.round(data.margin_s / 60))}분 빨라요 — 다음 차를 노려보세요</Text>
      )}
      {!data.will_miss && data.margin_s != null && data.margin_s < 120 && (
        <Text style={ss.tightText}>여유 {Math.max(0, Math.round(data.margin_s / 60))}분 — 서두르면 탈 수 있어요</Text>
      )}
      {data.buses[1]?.seconds != null && (
        <Text style={ss.subText}>
          {data.buses[1].is_lowfloor ? "♿ 저상 · " : ""}
          다다음 {fmtEta(liveSeconds(data.buses[1].seconds), data.buses[1].arriving)}
        </Text>
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
  pillOk:       { backgroundColor: C.busBg, borderColor: C.bus + "55" },
  pillLowfloor: { backgroundColor: C.lowFloor + "22", borderColor: C.lowFloor + "77" },
  pillWarn:     { backgroundColor: "#FFECEC", borderColor: C.danger + "55" },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  pillText: { fontSize: 11.5, fontWeight: "700", color: C.bus },
  refreshBtn: { marginLeft: 6, paddingHorizontal: 2 },
  refreshIcon: { fontSize: 13, fontWeight: "700", color: C.bus },
  refreshIconBusy: { opacity: 0.4 },
  missText:  { fontSize: 11, color: C.danger, fontWeight: "600" },
  tightText: { fontSize: 11, color: C.warn, fontWeight: "600" },
  subText:   { fontSize: 10.5, color: C.textMute },
});
