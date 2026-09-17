// 경사 bin 유틸리티 — S3 이전엔 신호 A 행 자체를 이 bin 변화로 방출했으나
// (SlopeBinTracker, 제거됨 — utils/distanceRowTracker.ts가 대체), 신호 C
// (routeChoiceModel.ts, 후보 경로 경사 히스토그램)가 여전히 이 binCenter()를
// 쓰고 있어 유틸리티만 남긴다. 신호 A는 이제 연속값(slope_mean 등)을 쓰고
// bin은 학습 시점에 계산 — distanceRowTracker.ts 참고.

export const SLOPE_BIN_WIDTH = 0.5;

/** 부호를 유지한 0.5% bin 중심값. 곡선 c_u(g) 가 부호 있는 경사 위에서 정의되므로 오르막/내리막 구분. */
export function binCenter(slopePct: number): number {
  const c = Math.round((Number(slopePct) || 0) / SLOPE_BIN_WIDTH) * SLOPE_BIN_WIDTH;
  return c === 0 ? 0 : c; // -0 정규화
}
