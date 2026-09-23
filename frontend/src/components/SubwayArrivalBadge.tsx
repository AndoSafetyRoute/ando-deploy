// 대중교통 지하철 스텝에 붙는 실시간 도착 배지.
// GET /subway/arrival 을 마운트 시 + 20초마다 호출. available:false 면 아무것도 안 그린다
// (정적 카카오 시간 유지 — graceful degradation). 서버 키 미설정이면 항상 이 상태.
// 방향(상행/하행)은 서버도 확정 못 하므로 항상 종착지 방면("OO행") 텍스트를 같이
// 보여준다 — 사용자가 맞는 방향인지 직접 확인할 수 있게(실제 역 전자게시판과 동일).
// 20초 폴링 사이에도 화면이 멈춰 있지 않도록, 매초 로컬에서 남은 시간을 깎아 보여준다
// (서버가 준 값 + data_age_s + 우리가 마지막으로 받아온 뒤 흐른 시간) — 0 밑으론 안 내려간다.

import React, { useEffect, useRef, useState, useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { C } from "../constants/colors";
import { getSubwayArrival, type SubwayArrival } from "../api/subwayArrival";

const REFRESH_MS = 20_000;
const TICK_MS = 1_000;

/** 초 → "3분 20초", "45초", "곧 도착" — 매초 그대로(반올림 없이) */
function fmtEta(sec: number | null, arriving: boolean): string {
  if (arriving || (sec != null && sec <= 0)) return "곧 도착";
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분 ${String(s).padStart(2, "0")}초` : `${s}초`;
}

type Props = {
  station: string;   // 승차역명
  lineNo?: string;    // 노선번호 ("4" 등, "호선" 뗀 값)
};

// 같은 역명을 여러 노선(operator)이 같이 쓰는 경우(예: 서울역 = 1호선/4호선/
// 경의중앙선), 실시간 API가 요청한 노선이 아닌 다른 노선 데이터만 줄 때가
// 있다(실측 확인됨). 그 노선이 우리가 기대한 것과 다르면 노선명을 같이 보여줘서
// "이건 4호선이 아니라 경의중앙선 실시간이에요"를 사용자가 바로 알 수 있게 한다.

export default function SubwayArrivalBadge({ station, lineNo }: Props) {
  const [data, setData] = useState<SubwayArrival | null>(null);
  const [loading, setLoading] = useState(false);
  const [, forceTick] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchedAtRef = useRef<number>(0);

  const load = useCallback(() => {
    setLoading(true);
    getSubwayArrival({ station, lineNo })
      .then((d) => {
        setData(d);
        fetchedAtRef.current = Date.now();
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [station, lineNo]);

  useEffect(() => {
    load();
    pollTimer.current = setInterval(load, REFRESH_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [load]);

  useEffect(() => {
    tickTimer.current = setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => {
      if (tickTimer.current) clearInterval(tickTimer.current);
    };
  }, []);

  if (!data || !data.available || data.trains.length === 0) return null;

  const totalElapsedS = (data.data_age_s ?? 0) + Math.floor((Date.now() - fetchedAtRef.current) / 1000);
  const liveSeconds = (raw: number | null) => (raw == null ? null : Math.max(0, raw - totalElapsedS));

  const t0 = data.trains[0];
  const t0Seconds = liveSeconds(t0.seconds);
  const eta = fmtEta(t0Seconds, t0.arriving);
  const stale = (data.data_age_s ?? 0) > 90;
  const lineMismatch = !!(lineNo && t0.line_no && t0.line_no !== lineNo);

  return (
    <View style={ss.wrap}>
      <View style={[ss.pill, ss.pillOk]}>
        <View style={[ss.dot, { backgroundColor: C.success }]} />
        <Text style={ss.pillText}>
          {lineMismatch ? `${t0.line_no}호선(!) · ` : ""}
          실시간 · 다음 열차 {eta}
          {t0.direction ? ` · ${t0.direction}행` : ""}
          {t0.train_type && t0.train_type !== "일반" ? ` · ${t0.train_type}` : ""}
        </Text>
        <TouchableOpacity onPress={load} disabled={loading} hitSlop={8} style={ss.refreshBtn}>
          <Text style={[ss.refreshIcon, loading && ss.refreshIconBusy]}>↻</Text>
        </TouchableOpacity>
      </View>
      {data.trains[1] && (data.trains[1].seconds != null || data.trains[1].arriving) && (
        <Text style={ss.subText}>
          다음 {fmtEta(liveSeconds(data.trains[1].seconds), data.trains[1].arriving)}
          {data.trains[1].direction ? ` · ${data.trains[1].direction}행` : ""}
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
  pillOk: { backgroundColor: C.subwayBg, borderColor: C.subway + "55" },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  pillText: { fontSize: 11.5, fontWeight: "700", color: C.subway },
  refreshBtn: { marginLeft: 6, paddingHorizontal: 2 },
  refreshIcon: { fontSize: 13, fontWeight: "700", color: C.subway },
  refreshIconBusy: { opacity: 0.4 },
  subText: { fontSize: 10.5, color: C.textMute },
});
