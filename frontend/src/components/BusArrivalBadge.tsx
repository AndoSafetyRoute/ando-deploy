// 대중교통 버스 스텝에 붙는 실시간 도착 배지.
// GET /bus/arrival 을 마운트 시 + 20초마다 호출. available:false 면 아무것도 안 그린다
// (정적 카카오 시간 유지 — graceful degradation). 서버 키 미설정이면 항상 이 상태.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { C } from "../constants/colors";
import { getBusArrival, type BusArrival } from "../api/busArrival";

const REFRESH_MS = 20_000;  // 서버 재조회 주기
const TICK_MS = 1_000;      // 화면 카운트다운 갱신 주기

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
  const [loading, setLoading] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());     // 1초마다 갱신 → 카운트다운
  const fetchedAtRef = useRef<number>(Date.now());    // 마지막 서버 응답 시각
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    setLoading(true);
    getBusArrival({ route: routeName, stop: stopName, arsId, walkRemainingS })
      .then((d) => {
        if (!aliveRef.current) return;
        fetchedAtRef.current = Date.now();
        setData(d);
      })
      .catch(() => { if (aliveRef.current) setData(null); })
      .finally(() => { if (aliveRef.current) setLoading(false); });
  }, [routeName, stopName, arsId, walkRemainingS]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    const poll = setInterval(load, REFRESH_MS);
    const tick = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  if (!data || !data.available || data.buses.length === 0) return null;

  // 서버 응답 이후 흐른 시간만큼 남은 초에서 뺀다 → 폴링 사이에도 1초씩 줄어든다.
  const elapsedS = Math.max(0, (nowMs - fetchedAtRef.current) / 1000);
  const liveSec = (s: number | null | undefined) =>
    s == null ? null : Math.max(0, Math.round(s - elapsedS));

  const b0 = data.buses[0];
  const b0live = liveSec(b0.seconds);
  const eta = fmtEta(b0live, b0.arriving || (b0live != null && b0live <= 0));
  const stale = (data.data_age_s ?? 0) + elapsedS > 90;

  const b1live = liveSec(data.buses[1]?.seconds);

  return (
    <View style={ss.wrap}>
      <TouchableOpacity
        style={[ss.pill, data.will_miss ? ss.pillWarn : (b0.is_lowfloor ? ss.pillLowfloor : ss.pillOk)]}
        activeOpacity={0.7}
        onPress={load}
        accessibilityLabel="버스 도착정보 새로고침"
      >
        <View style={[ss.dot, { backgroundColor: data.will_miss ? C.danger : C.success }]} />
        <Text style={[ss.pillText, data.will_miss && { color: C.danger }]}>
          {b0.is_lowfloor ? "♿ 저상 · " : ""}
          실시간 · 다음 버스 {eta}
          {b0.congestion ? ` · ${b0.congestion}` : ""}
          {b0.last_bus ? " · 막차" : ""}
        </Text>
        <Text style={ss.refreshIcon}>{loading ? "…" : " ↻"}</Text>
      </TouchableOpacity>
      {data.will_miss && data.margin_s != null && (
        <Text style={ss.missText}>도보보다 {Math.abs(Math.round(data.margin_s / 60))}분 빨라요 — 다음 차를 노려보세요</Text>
      )}
      {!data.will_miss && data.margin_s != null && data.margin_s < 120 && (
        <Text style={ss.tightText}>여유 {Math.max(0, Math.round(data.margin_s / 60))}분 — 서두르면 탈 수 있어요</Text>
      )}
      {b1live != null && (
        <Text style={ss.subText}>
          {data.buses[1].is_lowfloor ? "♿ 저상 · " : ""}
          다다음 {fmtEta(b1live, data.buses[1].arriving || b1live <= 0)}
        </Text>
      )}
      {stale && <Text style={ss.subText}>{Math.round(((data.data_age_s ?? 0) + elapsedS) / 60)}분 전 기준 · 눌러서 새로고침</Text>}
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
  refreshIcon: { fontSize: 11, fontWeight: "700", color: C.bus, opacity: 0.7 },
  missText:  { fontSize: 11, color: C.danger, fontWeight: "600" },
  tightText: { fontSize: 11, color: C.warn, fontWeight: "600" },
  subText:   { fontSize: 10.5, color: C.textMute },
});
