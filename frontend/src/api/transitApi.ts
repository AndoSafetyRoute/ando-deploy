// 카카오맵 대중교통 길찾기 REST API
// 문서: https://developers.kakao.com/docs/latest/ko/kakaomap/rest-api#transit-info
const KAKAO_REST_API_KEY = process.env.EXPO_PUBLIC_KAKAO_REST_API_KEY;
const TRANSIT_API_URL = "https://dapi.kakao.com/v2/routing/publictraffic";

export type KakaoTransitStepType = "BUS" | "SUBWAY" | "WALKING";

export interface KakaoTransitStop {
  name: string;
}

export interface KakaoTransitVehicle {
  name: string;
  type: string;
}

export interface KakaoTransitStepProperties {
  guidance: string;
  type: KakaoTransitStepType;
  distance: number;
  time: number;
  stops?: KakaoTransitStop[];
  vehicles?: KakaoTransitVehicle[];
}

export interface KakaoTransitStep {
  properties: KakaoTransitStepProperties;
  path?: { points: [number, number][] };
}

export interface KakaoTransitRouteProperties {
  type: string; // "BUS" | "SUBWAY" | "BUS_SUBWAY" 등
  totalDistance: number;
  totalTime: number;
  transfers: number;
  fare?: { value: number };
}

export interface KakaoTransitRoute {
  properties: KakaoTransitRouteProperties;
  steps: KakaoTransitStep[];
}

export type KakaoTransitStatus =
  | "OK"
  | "STARTNODES_NULL"
  | "ENDNODES_NULL"
  | "EQUAL_POINTS"
  | "INVALID_REQUEST"
  | "NO_RESULTS";

export interface KakaoTransitResponse {
  status: KakaoTransitStatus;
  properties?: {
    total: number;
    bus: number;
    subway: number;
    busAndSubway: number;
    landingURL: string;
  };
  routes?: KakaoTransitRoute[];
}

export type TransitRequest = {
  startX: string | number;
  startY: string | number;
  endX: string | number;
  endY: string | number;
  startName?: string;
  endName?: string;
};

export async function requestTransitDirections({
  startX,
  startY,
  endX,
  endY,
  startName,
  endName,
}: TransitRequest): Promise<KakaoTransitResponse> {
  if (!KAKAO_REST_API_KEY) {
    throw new Error("EXPO_PUBLIC_KAKAO_REST_API_KEY가 설정되어 있지 않습니다.");
  }

  const params = new URLSearchParams({
    start_x: String(startX),
    start_y: String(startY),
    end_x: String(endX),
    end_y: String(endY),
  });
  if (startName) params.set("s_name", startName);
  if (endName) params.set("e_name", endName);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${TRANSIT_API_URL}?${params.toString()}`, {
      headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`카카오 대중교통 길찾기 요청 실패: ${errorText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}
