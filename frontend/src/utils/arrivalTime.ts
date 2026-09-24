// 버스·지하철 실시간 배지 공통 — 남은 시간을 "약 N분"으로 (30초 기준 반올림).
//   0~29초 → "곧 도착", 30~89초 → "약 1분", 90~149초 → "약 2분" …
// 초를 안 주는 노선(지하철 1호선 등)은 "N정거장 전".
export function fmtArrivalApprox(
  sec: number | null,
  arriving: boolean,
  stationsAway?: number | null,
): string {
  if (arriving || (sec != null && sec < 30)) return '곧 도착';
  if (sec == null) return stationsAway != null ? `${stationsAway}정거장 전` : '';
  return `약 ${Math.round(sec / 60)}분`;
}
