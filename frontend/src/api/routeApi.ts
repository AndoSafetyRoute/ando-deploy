import { stationNameOf } from "../utils/stationName";

// 에뮬레이터: 10.0.2.2 / 실기기(같은 WiFi): .env 에 EXPO_PUBLIC_ROUTE_API_URL=http://192.168.x.x:8000 추가
const API_BASE_URL: string =
  (process.env.EXPO_PUBLIC_ROUTE_API_URL as string | undefined) ?? "http://10.0.2.2:8000";
console.log("[Route] API_BASE_URL:", API_BASE_URL);

export type NavSegment = {
  segment_id:       number;
  length_m:         number;
  slope_mean:       number;
  slope_max:        number;
  slope_stddev:     number;
  zone:             'flat' | 'optimal' | 'warning' | 'forbidden';
  estimated_seconds: number;
  coord_start_idx:  number;
  coord_end_idx:    number;
  start_coords:     [number, number];
  end_coords:       [number, number];
};

// 측정 파이프라인 v2 — GPS 실측(POST /navigation/{route_id}/segment) 제출 단위.
// nav_segs(NavSegment, 교차로 기준·지도색/안내용)와 목적이 다른 별개의 분할 —
// CCH raw edge(5~10m)를 누적거리 30m+ 로 묶은 것으로, GPS 통과판정(15m)보다
// 확실히 커야 하는 실측 단위다. routing/measurement_units.py 참고.
export type MeasurementUnit = {
  unit_index:       number;
  distance_m:       number;
  slope_pct:        number;
  // S6.5 — OSM 원본 highway=='steps' 태그 기반 사실 필드(경사 추정 아님).
  // 차단 여부는 BE cost.FACILITY_POLICY가 결정 — FE는 그대로 표시/전달만.
  is_stairs:        boolean;
  coord_start_idx:  number;
  coord_end_idx:    number;
  start_coords:     [number, number];
  end_coords:       [number, number];
};

export type Waypoint = {
  lat:              number;
  lon:              number;
  turn_direction:   '직진' | '좌회전' | '우회전' | '유턴';
  guidance_text:    string;
  distance_to_next: number;
};

export type RouteResponse = {
  routes: Array<{
    id: string; tag: string; color: string;
    coordinates: [number, number][];
    totalDistance: number; totalCost: number; avgSlope: number;
    routeSegments: any[]; estimatedTimeS: number;
  }>;
  coordinates:          [number, number][];
  routeSegments:        any[];
  algorithm:            string;
  total_length_m:       number;
  total_cost:           number;
  avg_slope_pct:        number;
  user_label:           string;
  segments:             any[];
  estimatedTimeS:       number;
  estimated_time_min:   number;
  navigation_segments:  NavSegment[];
  waypoints:            Waypoint[];
  measurement_units:    MeasurementUnit[];
};

export type RouteRequest = {
  startLatitude: string;
  startLongitude: string;
  endLatitude: string;
  endLongitude: string;
  userType?: string;
  // 목적지가 지하철역이면 역 이름을 같이 보냄. 예: "서울역", "삼각지"
  endStationName?: string;
  // 출발지가 지하철역이면 역 이름 — 서버가 역에서 나오는 보행약자용 출구로 출발점 이동
  startStationName?: string;
  // true면 서버가 navigation_segments/waypoints(GPS 안내용) 생성을 생략하고
  // 거리/시간/경사만 반환 — 아직 사용자가 선택하지 않은 후보 경로들의 도보
  // 구간을 대량으로 미리 조회할 때(대중교통 탭) 써서 응답을 빠르게 한다.
  light?: boolean;
};

export async function requestRoute({
  startLatitude,
  startLongitude,
  endLatitude,
  endLongitude,
  userType = "manual_wheelchair",
  endStationName,
  startStationName,
}: RouteRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  const origin_lat = Number(startLatitude);
  const origin_lon = Number(startLongitude);
  const dest_lat   = Number(endLatitude);
  const dest_lon   = Number(endLongitude);
  const user_type  = userType;

  try {
    console.log("[Route] 요청 URL:", `${API_BASE_URL}/route`);
    console.log("[Route] 요청 body:", JSON.stringify({
      origin_lat, origin_lon, dest_lat, dest_lon, user_type,
    }));

    const response = await fetch(`${API_BASE_URL}/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        origin_lat, origin_lon, dest_lat, dest_lon, user_type,
        // 이름에 "역"/"N호선"이 있을 때만 역으로 보고 보낸다(서버가 보행약자용 출구로 이동)
        end_station_name: stationNameOf(endStationName),
        start_station_name: stationNameOf(startStationName),
      }),
      signal: controller.signal,
    });

    console.log("[Route] 응답 status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.log("[Route] 에러 응답 본문:", errorText);
      throw new Error(errorText);
    }

    const data = await response.json();
    console.log("[Route] 응답 데이터 키:", Object.keys(data));
    return data;
  } catch (err: any) {
    console.log("[Route] 에러:", err?.message ?? err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 대중교통 탭의 승차 전/하차 후 도보 구간 전용. /route와 동일한 CCH 계산이지만
// 백엔드가 FE 호환을 위해 유지 중인 /route/safe 엔드포인트를 쓴다.
export async function requestWalkLeg({
  startLatitude,
  startLongitude,
  endLatitude,
  endLongitude,
  userType = "manual_wheelchair",
  light = false,
  endStationName,
  startStationName,
}: RouteRequest) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(`${API_BASE_URL}/route/safe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        origin_lat:  Number(startLatitude),
        origin_lon:  Number(startLongitude),
        dest_lat:    Number(endLatitude),
        dest_lon:    Number(endLongitude),
        user_type:   userType,
        light,
        // 하차 후 도보의 도착지가 역이면 보행약자용 출구까지 안내(stationExit 응답)
        end_station_name: stationNameOf(endStationName),
        start_station_name: stationNameOf(startStationName),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}
export type SubwayBestExit = {
  type:      'elevator' | 'escalator' | 'lift';
  exit_no:   string;
  lat:       number;
  lon:       number;
  serial?:   string;
  direction?: string;
  message:   string;
  station?:  string;
  facilities?: string[];
};

// 대중교통 탭 승/하차역 접근성 조회. 백엔드 데이터가 없거나 요청 실패 시
// null을 반환하므로, 호출부는 답사 기반 하드코딩 정보로 폴백해야 한다.
export async function requestSubwayBestExit(
  station: string,
  userType: string,
  lat: number,
  lon: number,
  direction: 'entering' | 'exiting' = 'exiting',
): Promise<SubwayBestExit | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const params = new URLSearchParams({
      station, user_type: userType,
      lat: String(lat), lon: String(lon), direction,
    });
    const response = await fetch(`${API_BASE_URL}/subway/best-exit?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type StationCharger = {
  line:     string;
  station:  string;
  floor:    string;
  position: string;
  count:    number;
};

// 지하철역 내 전동휠체어 충전설비 조회 (1~8호선 전역). 전동휠체어 사용자가
// 배차 중 배터리 부족 상황에서 "이 역 안에 충전기가 있는지" 확인하는 용도.
// 데이터 없거나 요청 실패 시 null.
export async function requestStationChargers(station: string): Promise<StationCharger[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const params = new URLSearchParams({ station });
    const response = await fetch(`${API_BASE_URL}/subway/chargers?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type LowfloorBusInfo = {
  route:     string;
  licensed:  number | null;
  lowfloor:  number | null;
  ratio:     number;
};

// 노선별 저상버스 보유율 조회(정적 데이터, 실시간 아님). 카카오 대중교통 API는
// 저상버스 여부를 제공하지 않아, 노선번호로 매칭하는 이 보완 데이터를 쓴다.
// 데이터 없거나 요청 실패 시 null — 호출부는 일반 안내 문구로 폴백해야 한다.
export async function requestLowfloorBusInfo(routeNo: string): Promise<LowfloorBusInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const params = new URLSearchParams({ route_no: routeNo });
    const response = await fetch(`${API_BASE_URL}/bus/lowfloor?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
