// 서울시 지하철 실시간 도착 — GET /subway/arrival (인증 불필요, 키는 서버에만).
// 키 미설정/역명 미매칭/운행열차 없음 등은 available:false + reason 으로 내려오므로,
// FE 는 그 경우 실시간 배지를 그냥 숨긴다(정적 카카오 시간 유지 — graceful degradation).

import { BASE_URL } from "../api";

export type SubwayArrivalItem = {
  seconds:      number | null; // 도착까지 초. null 이면 arriving 등으로만 판단
  text:         string | null; // "2분 후 (당산)" 같은 원문
  current_pos:  string | null; // 열차 현재 위치역
  line_no:      string | null; // "4" 같은 노선번호(안 매칭되면 null)
  // 종착지 방면("OO행"). 방향(상행/하행)은 서버가 노선 위상 없이는 확정 못 해서
  // 추측하지 않고 이 텍스트를 그대로 준다 — 맞는 방향인지 사용자가 직접 확인.
  direction:    string | null;
  updn_line:    string | null; // "상행"/"하행" 원문(있을 때만)
  train_type:   string | null; // "일반"/"급행" 등
  arriving:     boolean;
  // 초(seconds)를 안 주는 노선(1호선·경의중앙·공항철도·신분당 등)은 "[N]번째 전역"의 N
  stations_away?: number | null;
  data_age_s:   number | null;
};

export type SubwayArrival = {
  available:  boolean;
  station:    string;
  line_no:    string | null;
  trains:     SubwayArrivalItem[];
  data_age_s: number | null;
  reason?:    "key_unset" | "api_unavailable" | "no_active_train" | string;
};

/**
 * @param station 승차역명 (카카오 step.stops[0].name, 예 "서울역")
 * @param lineNo  노선번호 (카카오 step.lineNo, 예 "4") — 있으면 그 노선만 우선 필터
 */
export async function getSubwayArrival(args: {
  station: string;
  lineNo?: string;
}): Promise<SubwayArrival> {
  const q = new URLSearchParams({ station: args.station });
  if (args.lineNo) q.set("line_no", args.lineNo);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${BASE_URL}/subway/arrival?${q.toString()}`, { signal: controller.signal });
    if (!res.ok) {
      return { available: false, station: args.station, line_no: args.lineNo ?? null,
               trains: [], data_age_s: null, reason: `http_${res.status}` };
    }
    return (await res.json()) as SubwayArrival;
  } finally {
    clearTimeout(timer);
  }
}
