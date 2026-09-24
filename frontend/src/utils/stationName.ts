// 도착지가 지하철역인지 — 이름에 독립된 "역"이 있거나 "N호선" 표기가 있을 때 역으로 본다.
// 서버는 이 이름으로 역 편의시설 데이터를 찾아 보행약자용 출구로 도착지를 옮긴다.
// "역" 없이 보내면 "시청"(서울시청 건물) 같은 장소가 시청역 출구로 옮겨질 수 있어
// 여기서 거른다.
//   역으로 봄:   "숙대입구역", "서울역 1호선", "시청역(1호선)", "강남역 2번출구", "숙대입구 4호선"
//   역 아님:     "시청", "스타벅스 강남역점", "역삼동 카페"
const STATION_RE = /역(?=$|[\s(（\d,·])/;
const LINE_RE = /\d+호선/;

// 역명 비교용 정규화 — 서버 subway/facility._normalize_station 과 같은 규칙
// ("숙대입구역 4호선" / "숙대입구(서울시교육청)" / "4호선 숙대입구역" → "숙대입구")
export function normalizeStation(name?: string | null): string {
  let n = (name ?? '').trim().replace(/\s+/g, ' ');
  n = n.replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim();
  n = n.replace(/\s*\d+(?:-\d+)?호선\s*$/, '').trim();
  n = n.replace(/^\s*\d+(?:-\d+)?호선\s*/, '').trim();
  if (n.endsWith('역')) n = n.slice(0, -1).trim();
  return n;
}

export function sameStation(a?: string | null, b?: string | null): boolean {
  const x = normalizeStation(a);
  return !!x && x === normalizeStation(b);
}

export function stationNameOf(name?: string | null): string | undefined {
  const n = (name ?? '').trim();
  return n && (STATION_RE.test(n) || LINE_RE.test(n)) ? n : undefined;
}
