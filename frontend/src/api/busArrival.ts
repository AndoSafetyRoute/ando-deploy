// 서울시 버스도착 실시간 — GET /bus/arrival (인증 불필요, 키는 서버에만).
// 키 미설정/노선ID 미해결/정류소 미매칭/운행버스 없음 등은 available:false + reason
// 으로 내려오므로, FE 는 그 경우 실시간 배지를 숨기고 정적(카카오) 시간을 유지한다.

import { BASE_URL } from "../api";

export type BusArrivalItem = {
  seconds:    number | null;   // 도착까지 초. null 이면 text 만 (곧 도착 등)
  text:       string | null;   // "3분 12초 후 [2번째 전]" 같은 원문
  vehicle_no: string | null;
  congestion: string | null;   // "여유" | "보통" | "혼잡" | null
  arriving:   boolean;         // 곧 도착
  last_bus:   boolean;
};

export type BusArrival = {
  available:    boolean;
  route_name:   string;
  bus_route_id: string | null;
  stop:         string | null;
  buses:        BusArrivalItem[];
  next_bus_s:   number | null;
  will_miss:    boolean | null;   // walk_remaining_s 대비 (넘겨줬을 때만)
  margin_s:     number | null;
  data_age_s:   number | null;
  reason?:      "route_id_unresolved" | "api_unavailable" | "stop_not_matched" | "no_active_bus" | string;
};

/**
 * @param route  버스 번호 (카카오 vehicle.name, 예 "402")
 * @param stop   승차 정류소명 (카카오 step.stops[0].name)
 * @param arsId  정류소 고유번호(5자리) — 있으면 이름보다 우선
 * @param walkRemainingS  승차 정류소까지 남은 도보 시간(초) — 놓칠 위험 계산용(선택)
 */
export async function getBusArrival(args: {
  route: string;
  stop?: string;
  arsId?: string;
  busRouteId?: string;
  walkRemainingS?: number;
}): Promise<BusArrival> {
  const q = new URLSearchParams({ route: args.route });
  if (args.stop) q.set("stop", args.stop);
  if (args.arsId) q.set("ars_id", args.arsId);
  if (args.busRouteId) q.set("bus_route_id", args.busRouteId);
  if (args.walkRemainingS != null && Number.isFinite(args.walkRemainingS)) {
    q.set("walk_remaining_s", String(Math.round(args.walkRemainingS)));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${BASE_URL}/bus/arrival?${q.toString()}`, { signal: controller.signal });
    if (!res.ok) {
      // 서버는 항상 200+dict 를 주지만, 프록시/게이트웨이 오류 등은 available:false 로 취급
      return { available: false, route_name: args.route, bus_route_id: null, stop: args.stop ?? null,
               buses: [], next_bus_s: null, will_miss: null, margin_s: null, data_age_s: null,
               reason: `http_${res.status}` };
    }
    return (await res.json()) as BusArrival;
  } finally {
    clearTimeout(timer);
  }
}
