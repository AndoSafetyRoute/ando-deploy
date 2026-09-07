// 경사도 데이터(road_10m_slope_seoul.geojson)는 서울 전역 DEM(dem-seoul.tif) 기준으로 구축됨.
// 실제 DEM 좌표 범위를 기준으로 한 바운딩 박스 (EPSG:5174 -> WGS84 변환 결과).
const SLOPE_DATA_BOUNDS = {
  minLat: 37.428,
  maxLat: 37.702,
  minLng: 126.766,
  maxLng: 127.185,
};

export function isWithinSlopeDataCoverage(
  lat: string | number | undefined,
  lng: string | number | undefined
): boolean {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return true;

  return (
    latNum >= SLOPE_DATA_BOUNDS.minLat &&
    latNum <= SLOPE_DATA_BOUNDS.maxLat &&
    lngNum >= SLOPE_DATA_BOUNDS.minLng &&
    lngNum <= SLOPE_DATA_BOUNDS.maxLng
  );
}

// 서울 밖은 경사도뿐 아니라 라우팅 그래프 자체가 없어(경사도가 그래프 GeoJSON에
// 함께 구워져 있음) 거리 우선 경로도 계산할 수 없다 — 그래서 "경사도 미반영"이
// 아니라 아예 미지원 지역으로 안내하고 길찾기를 막는다. (BE도 out_of_service_area
// 코드로 같은 취지를 응답한다.)
export const OUT_OF_SERVICE_AREA_MESSAGE =
  "현재 서울 지역만 경로 안내를 제공합니다.\n서울 안의 출발지·도착지를 선택해 주세요.";
