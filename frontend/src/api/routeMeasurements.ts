// RouteDetailScreen — navigation_measurements(BE 실측, 신뢰 소스) 조회.
// 로컬(storage.ts record.segments)은 서버 동의·전송 성공 여부와 무관하게 항상
// 존재하는 반면, 이 응답은 실제로 GPS 실측이 BE에 저장된 것만 담는다 — 화면은
// 이걸 우선 시도하고, 없거나(동의 안 함/전송 실패) 조회 자체가 실패하면 로컬로
// 폴백한다(RouteDetailScreen.tsx 참고).

import { BASE_URL, getAuthToken } from "../api";
import { ROUTE_MEASUREMENTS_PATH } from "../personalization/config";

export type RouteMeasurementSegment = {
  index:       number;   // unit_index
  distance_m:  number;
  slope_pct:   number;   // 부호 있는 값(양수=오르막)
  elapsed_ms:  number;
  // [lon, lat] — 이 컬럼 추가(2026-09) 이전에 쌓인 행은 null(지도 없이 폴백).
  start_coords: [number, number] | null;
  end_coords:   [number, number] | null;
};

export type RouteMeasurementsResponse = {
  route_id: number;
  segments: RouteMeasurementSegment[];
};

/**
 * GET /navigation/{routeId}/measurements
 * - 200 → segments가 빈 배열이어도 정상(동의 안 함/서버 저장 실패) — 호출측이 로컬 폴백.
 * - 404 → 소유 아님/경로 없음. throw.
 * - 네트워크/5xx → throw (재시도는 호출측 책임 — 이 화면은 실패 즉시 로컬로 폴백하면 됨).
 */
export async function getRouteMeasurements(
  routeId: number | string,
  idToken?: string,
): Promise<RouteMeasurementsResponse> {
  const token = idToken ?? (await getAuthToken());
  if (!token) throw new Error("no-auth-token");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${BASE_URL}${ROUTE_MEASUREMENTS_PATH(routeId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`route-measurements ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as RouteMeasurementsResponse;
  } finally {
    clearTimeout(timer);
  }
}
