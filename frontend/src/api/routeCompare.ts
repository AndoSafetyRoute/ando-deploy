// 3경로 비교(⑬) — /route 를 candidates:"compare" 로 호출 (인계 §3.2)
//
// ⚠️ 이 호출은 "새 3경로 비교 화면"에서만 쓴다. 대중교통 도보 구간(requestWalkLeg 등)이나
//    기존 /route 호출부는 절대 candidates 를 넘기면 안 된다 — 기본값 "single" 유지.
//    (인계 §5, app.py 주석: compare 를 대중교통 도보에 쓰면 쿼리가 폭증해 타임아웃)
//
// 백엔드(ando-BE/gdy/personalization-v2)는 candidateRoutes 에 type + distance 2장을
// 항상 채우고, 로그인 사용자의 개인 metric 캐시가 차면 personal 까지 3장이 된다.
// 동일 노드열은 스킵하므로 실제 길이는 1~3 로 변한다 → FE 는 배열을 그대로 순회한다.

import { BASE_URL, getAuthToken } from "../api";
import type { CandidateRoute } from "../utils/routeChoiceModel";
import {
  ROUTE_PATH,
  ROUTE_CANDIDATES_KEY,
  ROUTE_CANDIDATES_COMPARE,
  CANDIDATE_ROUTES_FIELD,
} from "../personalization/config";

export type RouteCompareResponse = {
  // 기존 /route single 응답 필드도 그대로 옴(단일 경로). 여기선 비교에 필요한 것만 명시.
  coordinates?:   [number, number][];
  routeSegments?: any[];
  candidateRoutes: CandidateRoute[];
};

export async function requestRouteCandidates(params: {
  startLatitude:  string | number;
  startLongitude: string | number;
  endLatitude:    string | number;
  endLongitude:   string | number;
  userType?:      string;
  endStationName?: string;
}): Promise<RouteCompareResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  // 토큰을 실어야 BE 가 로그인 사용자로 인식해 personal(맞춤) 후보를 채운다.
  // 없으면(_optional_verified → decoded=None) type/distance 만 나온다.
  const token = await getAuthToken().catch(() => null);
  try {
    const res = await fetch(`${BASE_URL}${ROUTE_PATH}`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        origin_lat: Number(params.startLatitude),
        origin_lon: Number(params.startLongitude),
        dest_lat:   Number(params.endLatitude),
        dest_lon:   Number(params.endLongitude),
        user_type:  params.userType ?? "manual_wheelchair",
        [ROUTE_CANDIDATES_KEY]: ROUTE_CANDIDATES_COMPARE,

        // 목적지가 지하철역이면 접근 가능한 출구로 스냅하기 위해 전달
        end_station_name: params.endStationName,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${ROUTE_PATH} compare ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const raw = data[CANDIDATE_ROUTES_FIELD];
    // 방어적 정규화 — candidateRoutes 가 없거나 비면 single 응답을 후보 1개로.
    const list: CandidateRoute[] = Array.isArray(raw) && raw.length
      ? raw
      : [{
          kind:          "type",
          coordinates:   data.coordinates ?? [],
          totalDistance: data.total_length_m ?? data.totalDistance ?? 0,
          avgSlope:      data.avg_slope_pct ?? data.avgSlope ?? 0,
          estimatedTimeS: data.estimatedTimeS ?? data.estimated_time_s ?? 0,
          routeSegments: data.routeSegments ?? [],
        }];
    return { ...data, candidateRoutes: list };
  } finally {
    clearTimeout(timer);
  }
}
