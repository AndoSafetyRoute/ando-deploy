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

export const SLOPE_DATA_WARNING = "❗서울 이외의 지역에는 경사도 반영이 되지 않습니다.";
