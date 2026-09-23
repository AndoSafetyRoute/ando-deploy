// 대중교통 지하철 스텝에 붙는 실시간 도착 배지.
// GET /subway/arrival 을 마운트 시 + 20초마다 호출. available:false 면 아무것도 안 그린다
// (정적 카카오 시간 유지 — graceful degradation). 서버 키 미설정이면 항상 이 상태.
// 방향(상행/하행)은 서버도 확정 못 하므로 항상 종착지 방면("OO행 - OO방면") 텍스트를
// 같이 보여준다 — 사용자가 맞는 방향인지 직접 확인할 수 있게(실제 역 전자게시판과 동일).

import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { C } from "../constants/colors";
import { getSubwayArrival, type SubwayArrival } from "../api/subwayArrival";

const REFRESH_MS = 20_000;  // 서버 재조회 주기
const TICK_MS = 1_000;      // 화면 카운트다운 갱신 주기

/** 초 → "3분", "3분 20초", "곧 도착" */
function fmtEta(sec: number | null, arriving: boolean): string {
  if (arriving || (sec != null && sec <= 0)) return "곧 도착";
  if (sec == null) return "";
  if (sec < 60) return "1분 미만";
  const m = Math.floor(sec / 60);
  const s = Math.round((sec - m * 60) / 10) * 10;
  return s === 0 || s === 60 ? `${m + (s === 60 ? 1 : 0)}분` : `${m}분 ${s}초`;
}

type Props = {
  station: string;   // 승차역명
  lineNo?: string;    // 노선번호 ("2" 등, "호선" 뗀 값)
};

export default function SubwayArrivalBadge({ station, lineNo }: Props) {
  const [data, setData] = useState<SubwayArrival | null>(null);
  const [loading, setLoading] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const fetchedAtRef = useRef<number>(Date.now());
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    setLoading(true);
    getSubwayArrival({ station, lineNo })
      .then((d) => {
        if (!aliveRef.current) return;
        fetchedAtRef.current = Date.now();
        setData(d);
      })
      .catch(() => { if (aliveRef.current) setData(null); })
      .finally(() => { if (aliveRef.current) setLoading(false); });
  }, [station, lineNo]);

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

  if (!data || !data.available || data.trains.length === 0) return null;

  const elapsedS = Math.max(0, (nowMs - fetchedAtRef.current) / 1000);
  const liveSec = (s: number | null | undefined) =>
    s == null ? null : Math.max(0, Math.round(s - elapsedS));

  const t0 = data.trains[0];
  const t0live = liveSec(t0.seconds);
  const eta = fmtEta(t0live, t0.arriving || (t0live != null && t0live <= 0));
  const stale = (data.data_age_s ?? 0) + elapsedS > 90;
  // 같은 역명을 여러 노선이 같이 쓰는 경우(예: 서울역 = 1/4호선, 경의중앙선),
  // 요청한 호선 열차가 없어 다른 노선으로 폴백됐을 수 있다 — 그 경우 알려준다.
  const lineMismatch = !!(lineNo && t0.line_no && t0.line_no !== lineNo);

  const t1live = liveSec(data.trains[1]?.seconds);

  return (
    <View style={ss.wrap}>
      <TouchableOpacity
        style={ss.pill}
        activeOpacity={0.7}
        onPress={load}
        accessibilityLabel="지하철 도착정보 새로고침"
      >
        <View style={[ss.dot, { backgroundColor: C.success }]} />
        <Text style={ss.pillText}>
          실시간 · 다음 열차 {eta}
          {t0.train_type && t0.train_type !== '일반' ? ` · ${t0.train_type}` : ''}
        </Text>
        <Text style={ss.refreshIcon}>{loading ? '…' : ' ↻'}</Text>
      </TouchableOpacity>
      {t0.direction && (
        <Text style={ss.subText}>{t0.direction}{t0.updn_line ? ` · ${t0.updn_line}` : ''}</Text>
      )}
      {lineMismatch && (
        <Text style={ss.warnText}>
          요청한 {lineNo}호선 열차 정보가 없어 {t0.line_no}호선 실시간을 보여드려요
        </Text>
      )}
      {t1live != null && (
        <Text style={ss.subText}>다다음 {fmtEta(t1live, data.trains[1].arriving || t1live <= 0)}</Text>
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
    backgroundColor: C.subwayBg, borderColor: C.subway + "55",
  },
  dot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  pillText: { fontSize: 11.5, fontWeight: "700", color: C.subway },
  refreshIcon: { fontSize: 11, fontWeight: "700", color: C.subway, opacity: 0.7 },
  warnText:  { fontSize: 11, color: C.warn, fontWeight: "600" },
  subText:   { fontSize: 10.5, color: C.textMute },
});
