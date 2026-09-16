// GPS 경로 추종 판정 — 2단계 개선(2026-09).
//
// 기존 판정(NavigationScreen.tsx)은 "GPS가 구간 끝점 PROXIMITY_THRESHOLD(25m)
// 반경 안에 들어왔는가"만 봤다. 이러면 사용자가 경로를 정확히 따라가도 건물
// 주변 등에서 GPS가 흔들리거나 끝점을 살짝 비껴 찍으면(반경 밖으로) 정상
// 통과가 아닌 것으로 처리될 수 있다.
//
// 이 모듈은 그 반경 판정을 대체하지 않고 OR로 보완하는 두 번째 판정 축이다:
// GPS를 경로 전체 폴리라인에 투영해 "경로 시작점 기준 누적 진행 거리"를 추정하고,
// 그 진행 거리가 어떤 구간의 끝점 위치(같은 폴리라인 기준 누적 거리)를 이미
// 지났으면 그 구간은 통과한 것으로 본다 — GPS가 끝점 근처를 못 찍었어도 경로를
// 따라 그 지점을 실제로 지나왔다면 통과로 인정된다.
//
// routeSegments(raw edge, ~5~10m)와 measurementUnits(≥30m)는 인덱스 체계가
// 서로 다르지만 둘 다 같은 /route 응답의 전체 좌표 배열(coordinates) 위의
// 지점이므로, 좌표(위경도) 기반으로만 동작하는 이 모듈은 두 쪽 모두에 그대로
// 쓸 수 있다(인덱스 정합을 신경 쓸 필요 없음).

export type Coordinate = { latitude: number; longitude: number };

function haversineDistance(a: Coordinate, b: Coordinate): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const sinHLat = Math.sin(dLat / 2);
  const sinHLon = Math.sin(dLon / 2);
  const x =
    sinHLat * sinHLat +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * sinHLon * sinHLon;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * 점 p를 선분 ab에 투영한다. 위경도를 짧은 구간(5~30m)에서 로컬 평면(미터)으로
 * 근사 변환해 벡터 투영으로 계산한다 — 이 스케일에서는 지구 곡률 오차가
 * 무시할 수준(<1cm)이고, GPS 콜백마다 폴리라인 전체를 훑어야 해서(성능상)
 * haversine 반복 호출보다 훨씬 싸다.
 * 반환: 투영점까지의 수직 거리(m), 선분 시작점 기준 진행 거리(along, m).
 */
function projectToSegment(
  p: Coordinate,
  a: Coordinate,
  b: Coordinate
): { distance: number; along: number } {
  const latRad = (a.latitude * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos(latRad);

  const bx = (b.longitude - a.longitude) * mPerDegLon;
  const by = (b.latitude - a.latitude) * mPerDegLat;
  const px = (p.longitude - a.longitude) * mPerDegLon;
  const py = (p.latitude - a.latitude) * mPerDegLat;

  const abLenSq = bx * bx + by * by;
  let t = abLenSq > 0 ? (px * bx + py * by) / abLenSq : 0;
  t = Math.max(0, Math.min(1, t));

  const projX = t * bx;
  const projY = t * by;
  const distance = Math.hypot(px - projX, py - projY);
  const segLen = Math.hypot(bx, by);

  return { distance, along: t * segLen };
}

export type RouteProgressTracker = {
  /** 새 GPS 픽스를 반영한다 — 폴리라인과의 수직 거리가 snapToleranceM 이내일 때만
   *  진행 거리를 갱신한다(엉뚱한 곳에 있는 GPS가 진행률만 튀게 만드는 것 방지). */
  update(point: Coordinate): void;
  /** 지금까지 확인된 최대 진행 거리(경로 시작점 기준 누적 m). 단조증가만 한다 —
   *  GPS가 뒤로 튀어도 진행률은 줄어들지 않는다(왕복/되돌아가는 경로에서 오탐 방지). */
  maxProgressM(): number;
  /** 임의 지점(구간 끝점 등)의 경로상 누적 거리 — 폴리라인에서 가장 가까운
   *  위치 기준. 구간 끝점 좌표는 보통 폴리라인의 정점과 거의 정확히 겹친다. */
  arcLengthOf(point: Coordinate): number;
};

const NOOP_TRACKER: RouteProgressTracker = {
  update() {},
  maxProgressM() { return 0; },
  arcLengthOf() { return 0; },
};

/**
 * coordinates: /route 응답의 전체 경로 폴리라인(시작~끝, 백엔드 path_nodes 순서
 * 그대로 — NavigationScreen.tsx의 `coordinates` useMemo 결과를 그대로 넘기면 됨).
 * snapToleranceM: 이 값보다 폴리라인에서 멀리 떨어진 GPS 픽스는 진행률 갱신에서
 * 제외한다. PROXIMITY_THRESHOLD(구간 끝점 반경)보다 넉넉하게 잡는다 — 이 트래커는
 * 반경 판정을 완화하려는 목적이지 더 빡빡한 두 번째 문턱을 추가하려는 게 아니다.
 */
export function createRouteProgressTracker(
  coordinates: Coordinate[],
  snapToleranceM = 40
): RouteProgressTracker {
  if (coordinates.length < 2) return NOOP_TRACKER;

  const cumDist: number[] = [0];
  for (let i = 1; i < coordinates.length; i++) {
    cumDist.push(cumDist[i - 1] + haversineDistance(coordinates[i - 1], coordinates[i]));
  }

  let maxProgress = 0;

  function projectAll(point: Coordinate): { arcLength: number; distance: number } {
    let bestArcLength = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < coordinates.length - 1; i++) {
      const { distance, along } = projectToSegment(point, coordinates[i], coordinates[i + 1]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestArcLength = cumDist[i] + along;
      }
    }
    return { arcLength: bestArcLength, distance: bestDistance };
  }

  return {
    update(point) {
      const { arcLength, distance } = projectAll(point);
      if (distance <= snapToleranceM && arcLength > maxProgress) {
        maxProgress = arcLength;
      }
    },
    maxProgressM() {
      return maxProgress;
    },
    arcLengthOf(point) {
      return projectAll(point).arcLength;
    },
  };
}
