import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Animated, Dimensions, Platform, Alert,
} from 'react-native';
import { C, ZONE_COLORS } from '../../constants/colors';
import { formatMinutes } from '../../utils/storage';
import {
  requestTransitDirections,
  KakaoTransitRoute,
  KakaoTransitStep,
  KakaoTransitStepType,
} from '../../api/transitApi';
import {
  requestWalkLeg, requestSubwayBestExit, SubwayBestExit,
  requestLowfloorBusInfo, LowfloorBusInfo,
  requestStationChargers, StationCharger,
} from '../../api/routeApi';
import RouteMapView, { MapCoordinate } from './RouteMapView';
import { useDraggableSheet } from './useDraggableSheet';

const { height: H } = Dimensions.get('window');

// ── 필터 탭 ────────────────────────────────────────────────────
const FILTER_TABS = [
  { key: 'all',    label: '전체'        },
  { key: 'bus',    label: '버스'        },
  { key: 'subway', label: '지하철'      },
  { key: 'mixed',  label: '버스+지하철' },
];

const ACCESSIBILITY_WALKER_TYPES = [
  'manual_wheelchair', 'electric_wheelchair', 'walker', 'cane', 'leg_injury', 'elderly',
];

// 카카오 대중교통 API는 출구/엘리베이터 등 접근성 데이터를 제공하지 않는다.
// 아래는 직접 답사해서 확보한 실제 역/버스 접근성 정보(출구 번호, 엘리베이터 위치 등)이며,
// 카카오 API가 돌려주는 실제 경로가 이 역/버스를 지나갈 때 그대로 붙여서 안내한다.
// 답사 데이터가 없는 역/버스는 임의로 지어내지 않고 아래 일반 안내 문구로 대체한다.
const ACCESS_ADVISORY = '엘리베이터·저상버스 등 교통약자 편의시설 이용 가능 여부는 카카오 대중교통 API에서 제공되지 않아 현장에서 확인해 주세요.';

type StationAccessInfo = {
  accessibility: { type: string; text: string; icon: string }[];
  facilities?: { icon: string; label: string }[];
  detail?: string;
};

// 역 이름이든 버스 번호든 한 테이블에서 이름으로 조회한다.
// kind로 지하철역/버스를 구분해서, 같은 글자가 버스 정류장 이름에도 들어있는 경우
// (예: "숙대입구" 버스정류장 vs "숙대입구역" 지하철역) 엉뚱한 교통수단에 안 붙게 한다.
const KNOWN_ACCESSIBILITY: Record<string, StationAccessInfo & { kind: 'subway' | 'bus' }> = {
  '숙대입구역': {
    kind: 'subway',
    accessibility: [
      { type: 'elevator',  text: '2번 출구 엘리베이터 이용 → 4호선 플랫폼', icon: '🛗' },
      { type: 'escalator', text: '지하 1→2층 에스컬레이터 있음',           icon: '🔼' },
    ],
    facilities: [{ icon: '🚻', label: '장애인 화장실' }, { icon: '🦽', label: '휠체어 대여' }],
    detail: '이촌 방향 2번 칸 탑승 시 엘리베이터와 가장 가까움',
  },
  '이촌역': {
    kind: 'subway',
    accessibility: [
      { type: 'elevator', text: '이촌역 1번 출구 → 경의중앙선 엘리베이터', icon: '🛗' },
    ],
    detail: '이촌역 하차 후 1번 출구 방향 엘리베이터 이용, 환승 통로 끝 엘리베이터까지 약 2분 소요',
  },
  '용산04': {
    kind: 'bus',
    accessibility: [{ type: 'lowfloor', text: '저상버스 · 휠체어 슬로프 장착', icon: '♿' }],
    facilities: [{ icon: '🪑', label: '교통약자 우선석' }],
    detail: '저상버스 앞문 탑승, 기사님께 보조 요청 가능',
  },
};

// 카카오 응답의 guidance 문구/정류장 목록/버스 번호에 답사한 이름이 포함돼 있으면 그 실측 정보를 사용한다.
// stepType으로 kind를 대조해서, 지하철역 이름이 버스 정류장 이름에 우연히 겹쳐도 잘못 붙지 않게 한다.
function findKnownAccess(
  stepType: KakaoTransitStepType,
  title: string,
  stops: string[] | undefined,
  busNo: string | undefined,
): StationAccessInfo | null {
  if (stepType === 'BUS' && busNo && KNOWN_ACCESSIBILITY[busNo]?.kind === 'bus') {
    return KNOWN_ACCESSIBILITY[busNo];
  }

  if (stepType !== 'SUBWAY') return null;

  const haystack = `${title} ${(stops ?? []).join(' ')}`;
  for (const key of Object.keys(KNOWN_ACCESSIBILITY)) {
    if (KNOWN_ACCESSIBILITY[key].kind !== 'subway') continue;
    const shortKey = key.replace(/역$/, '');
    if (haystack.includes(key) || (shortKey && haystack.includes(shortKey))) {
      return KNOWN_ACCESSIBILITY[key];
    }
  }
  return null;
}

function stepTypeToUi(type: KakaoTransitStepType) {
  if (type === 'SUBWAY') return { uiType: 'subway', icon: '🚇', color: C.subway, colorBg: C.subwayBg, label: '지하철' };
  if (type === 'BUS')    return { uiType: 'bus',     icon: '🚌', color: C.bus,    colorBg: C.busBg,    label: '버스'   };
  return { uiType: 'walk', icon: '🚶', color: C.walk, colorBg: C.walkBg, label: '도보' };
}

function routeTypeToTag(type: string) {
  if (type === 'SUBWAY') return { tag: '지하철', tagColor: C.subway };
  if (type === 'BUS')    return { tag: '버스',   tagColor: C.bus };
  return { tag: '버스+지하철', tagColor: C.primary };
}

function formatDistanceText(m: number) {
  if (!Number.isFinite(m)) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

function formatClock(date: Date) {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function buildSegments(steps: KakaoTransitStep[]) {
  return steps.map(step => {
    const p = step.properties;
    const { uiType, icon, color, label } = stepTypeToUi(p.type);
    const duration = Math.max(1, Math.round(p.time / 60));
    return { type: uiType, duration, label: `${label} ${formatMinutes(duration)}`, icon, color };
  });
}

function buildSteps(steps: KakaoTransitStep[], apiUserType: string) {
  const showAdvisory = ACCESSIBILITY_WALKER_TYPES.includes(apiUserType);
  return steps.map((step, i) => {
    const p = step.properties;
    const { uiType, icon, color, colorBg, label } = stepTypeToUi(p.type);
    const duration = Math.max(1, Math.round(p.time / 60));
    const distanceText = formatDistanceText(p.distance);
    const vehicle = p.vehicles?.[0];
    const isLast = i === steps.length - 1;
    const stopNames = p.stops?.map(s => s.name);
    const busNo = p.type === 'BUS' && vehicle ? vehicle.name : undefined;

    // 답사한 실측 접근성 데이터가 있으면 그걸 쓰고, 없으면 임의로 지어내지 않고 일반 안내만 붙인다.
    const known = findKnownAccess(p.type, p.guidance, stopNames, busNo);
    const accessibility = showAdvisory ? (known?.accessibility ?? []) : [];
    const facilities = showAdvisory ? (known?.facilities ?? []) : [];
    const detail = !showAdvisory
      ? undefined
      : known?.detail ?? (uiType !== 'walk' ? ACCESS_ADVISORY : undefined);

    return {
      id: `k${i}`,
      type: uiType,
      title: p.guidance,
      subtitle: `${label} ${formatMinutes(duration)}${distanceText ? ` · 약 ${distanceText}` : ''}`,
      icon, color, colorBg,
      lineNo: p.type === 'SUBWAY' && vehicle ? vehicle.name.replace(/호선$/, '') : undefined,
      lineColor: p.type === 'SUBWAY' ? color : undefined,
      busNo,
      busType: busNo && KNOWN_ACCESSIBILITY[busNo]?.kind === 'bus' ? 'lowfloor' : undefined,
      stops: stopNames,
      accessibility,
      facilities,
      detail,
      isDestination: isLast,
    };
  });
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function buildSlopeDetailText(route: any) {
  const slope = Number(route?.avgSlope);
  const detour = Number(route?.detourRatio);
  const parts: string[] = [];
  if (Number.isFinite(slope)) parts.push(`평균 경사도 ${slope.toFixed(1)}%`);
  if (Number.isFinite(detour) && detour > 1) parts.push(`우회율 ${detour.toFixed(2)}배`);
  return parts.length ? `경사도 기반 추천 도보 경로 · ${parts.join(' · ')}` : undefined;
}

// 카카오 대중교통 API는 승차 전/하차 후 도보를 아예 안 주고 바로 버스·지하철 스텝으로 시작/끝난다
// (실측 확인됨). 그래서 항상 우리 쪽에서 "출발지 → 첫 탑승 지점", "마지막 하차 지점 → 목적지"
// 구간을 직접 계산해서 걷는 구간을 만들어 붙인다. 경사도 기반 도보 길찾기(requestWalkLeg, /api/route/leg)를
// 그대로 재사용하고, 백엔드가 응답을 못 주는 경우엔 직선거리로 대략적인 시간만 추정해서 보여준다.
type WalkLeg = {
  distanceM: number | null;
  durationMin: number;
  serverRoute: any | null;
  detailText?: string;
};

// 카카오 경로가 15개면 도보 구간(승차 전/하차 후)만 최대 30개가 동시에 서버로
// 몰린다. 개별 구간 조회는 빨라도(leg 엔드포인트 기준 0.03~0.5초) 이렇게 한꺼번에
// 몰리면 같은 시점에 사용자가 실제 기다리는 "도보 탭 유형 변경 재계산" 요청까지
// 뒤로 밀려서 느려지거나 30초 타임아웃("경로 재탐색 실패")까지 났다. 동시 실행
// 개수를 제한해서 서버 부하를 낮춘다.
function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const attempt = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            const next = queue.shift();
            if (next) next();
          });
      };

      if (active < concurrency) {
        attempt();
      } else {
        queue.push(attempt);
      }
    });
  };
}

type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

// 카카오 경로 하나의 승차 지점/하차 지점 좌표 추출(steps[0]/steps[마지막])이
// 어긋나면(예: 스텝이 사실상 도보 하나뿐이거나 경로 형태가 예상과 다르면)
// "구간"이 실제로는 전체 경로 규모(수 km~십수 km)로 계산되는 경우가 있었다.
// 이런 경우 CCH 우회 계산(추천급 이진탐색, 최대 2~3초)까지 타면서 15개 경로가
// 동시에 걸리면 전체가 느려지거나 사실상 멈춘 것처럼 보였다. 실제 정류장 접근
// 도보 구간은 이보다 훨씬 짧은 게 정상이므로, 넘는 경우 계산을 아예 생략하고
// 직선거리 추정치로 대체한다.
const MAX_LEG_STRAIGHT_M = 2000;

// 15개 경로 중 상당수가 같은 정류장/역에서 타고 내리는 경우가 많아, 같은
// 좌표쌍에 대해 동일한 구간 조회가 여러 번 중복 발생한다. load() 한 번의
// 범위 안에서 캐시로 중복 요청을 없애 서버 부하와 대기 시간을 더 줄인다.
type LegCache = Map<string, Promise<WalkLeg>>;

function legCacheKey(
  fromLat: string, fromLng: string, toLat: string, toLng: string,
  apiUserType: string, light: boolean,
) {
  const round = (v: string) => Number(v).toFixed(5);
  // light 모드 결과는 waypoints/turn-guidance가 비어 있어 실제 GPS 안내에
  // 못 쓰므로, full 조회와 캐시를 공유하면 안 된다 — 모드별로 키를 분리한다.
  return `${round(fromLat)},${round(fromLng)}->${round(toLat)},${round(toLng)}:${apiUserType}:${light ? 'light' : 'full'}`;
}

async function computeWalkLeg(
  fromLat: string, fromLng: string,
  toLat: string, toLng: string,
  apiUserType: string,
  limit: Limiter,
  cache: LegCache,
  light: boolean,
): Promise<WalkLeg> {
  const key = legCacheKey(fromLat, fromLng, toLat, toLng, apiUserType, light);
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = computeWalkLegUncached(fromLat, fromLng, toLat, toLng, apiUserType, limit, light);
  cache.set(key, promise);
  return promise;
}

async function computeWalkLegUncached(
  fromLat: string, fromLng: string,
  toLat: string, toLng: string,
  apiUserType: string,
  limit: Limiter,
  light: boolean,
): Promise<WalkLeg> {
  const straightM = haversineMeters(Number(fromLat), Number(fromLng), Number(toLat), Number(toLng));

  if (straightM > MAX_LEG_STRAIGHT_M) {
    return {
      distanceM: straightM,
      durationMin: Math.max(1, Math.round(straightM / 60)),
      serverRoute: null,
    };
  }

  try {
    const res = await limit(() => requestWalkLeg({
      startLatitude: fromLat, startLongitude: fromLng,
      endLatitude: toLat, endLongitude: toLng,
      userType: apiUserType,
      light,
    }));
    const bestRoute = res?.routes?.[0] ?? null;
    // navigation_segments(구간 색상)/waypoints(음성안내)는 routes[0]이 아니라
    // 응답 최상위 필드라서, NavigationScreen이 그대로 읽을 수 있게 같이 얹어준다.
    const best = bestRoute
      ? { ...bestRoute, navigation_segments: res?.navigation_segments, waypoints: res?.waypoints }
      : null;
    const distanceM = best ? Number(best.totalDistance) : null;
    const finalDistance = Number.isFinite(distanceM) ? (distanceM as number) : straightM;
    // BE가 경사/구간별 실제 속도까지 반영해 계산한 estimated_time_min이 있으면
    // 그걸 쓴다 — distance/60(=1m/s 가정) 근사치는 완만 경사나 고령자 등
    // 실제 보행 속도를 전혀 반영 못 하고, 특히 경로가 우회로 늘어난 경우
    // 체감보다 훨씬 큰 시간으로 튀는 문제가 있었다.
    const serverTimeMin = Number(res?.estimated_time_min);
    const durationMin = serverTimeMin > 0
      ? Math.max(1, Math.round(serverTimeMin))
      : Math.max(1, Math.round(finalDistance / 60));
    return {
      distanceM: finalDistance,
      durationMin,
      serverRoute: best,
      detailText: best ? buildSlopeDetailText(best) : undefined,
    };
  } catch {
    return {
      distanceM: straightM,
      durationMin: Math.max(1, Math.round(straightM / 60)),
      serverRoute: null,
    };
  }
}

// 승/하차역 접근성(엘리베이터/에스컬레이터) 조회 캐시 — LegCache와 동일한 이유로
// 여러 후보 경로가 같은 역을 공유할 때 중복 요청을 없앤다.
type SubwayExitCache = Map<string, Promise<SubwayBestExit | null>>;

function computeSubwayExit(
  station: string, apiUserType: string, lat: number, lon: number,
  cache: SubwayExitCache,
): Promise<SubwayBestExit | null> {
  const key = `${station}:${apiUserType}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = requestSubwayBestExit(station, apiUserType, lat, lon);
  cache.set(key, promise);
  return promise;
}

// 백엔드 실측(서울 열린데이터광장, 5분 갱신) 출구 정보를 스텝에 반영.
// 답사 하드코딩 정보보다 항상 우선 — 고장 여부까지 반영된 실시간 데이터이기 때문.
function applyBestExit(step: any, exit: SubwayBestExit) {
  if (!step) return;
  const icon = exit.type === 'elevator' ? '🛗' : exit.type === 'escalator' ? '🔼' : '🦼';
  step.accessibility = [{ type: exit.type, text: exit.message, icon }];
  step.detail = exit.message;
}

// 전동휠체어 충전소 조회 캐시 — 여러 후보 경로가 같은 역을 공유할 때
// 중복 요청을 없앤다 (SubwayExitCache와 동일한 이유).
type ChargerCache = Map<string, Promise<StationCharger[] | null>>;

function computeStationChargers(station: string, cache: ChargerCache): Promise<StationCharger[] | null> {
  const cached = cache.get(station);
  if (cached) return cached;
  const promise = requestStationChargers(station);
  cache.set(station, promise);
  return promise;
}

// 전동휠체어 사용자에게만 의미 있는 정보라 accessibility 배지에 별도로 추가.
function applyChargerInfo(step: any, chargers: StationCharger[]) {
  if (!step || chargers.length === 0) return;
  const c = chargers[0];
  const posText = c.position ? ` (${c.position})` : '';
  step.accessibility = [
    ...(step.accessibility ?? []),
    { type: 'charger', text: `역 내 전동휠체어 충전기 있음${posText}`, icon: '🔌' },
  ];
}

// 노선별 저상버스 보유율 조회 캐시 — 여러 후보 경로가 같은 노선을 공유할 때
// 중복 조회 방지 (LegCache/SubwayExitCache와 동일한 이유).
type LowfloorCache = Map<string, Promise<LowfloorBusInfo | null>>;

function computeLowfloorInfo(routeNo: string, cache: LowfloorCache): Promise<LowfloorBusInfo | null> {
  const cached = cache.get(routeNo);
  if (cached) return cached;
  const promise = requestLowfloorBusInfo(routeNo);
  cache.set(routeNo, promise);
  return promise;
}

// 정적 데이터(실시간 아님)이므로 "이 노선은 저상버스가 없다"고 단정하지 않고
// 보유율만 안내 — 0%에 가까워도 배차상 저상버스가 올 수 있다.
// busType='lowfloor' 배지는 보유율>0일 때만 (0%는 뱃지 없이 문구만 노출).
function applyLowfloorInfo(step: any, info: LowfloorBusInfo) {
  if (!step) return;
  const pct = Math.round(info.ratio);
  step.accessibility = [
    ...(step.accessibility ?? []),
    { type: 'lowfloor', text: `${info.route}번 노선 저상버스 보유율 약 ${pct}%`, icon: '♿' },
  ];
  if (pct > 0) step.busType = 'lowfloor';
}

function makeWalkStep(id: string, leg: WalkLeg, title: string, isDestination: boolean) {
  const distanceText = leg.distanceM != null ? formatDistanceText(leg.distanceM) : '';
  return {
    id, type: 'walk', title,
    subtitle: `도보 ${formatMinutes(leg.durationMin)}${distanceText ? ` · 약 ${distanceText}` : ''}`,
    icon: isDestination ? '📍' : '🚶',
    color: isDestination ? C.danger : C.walk,
    colorBg: isDestination ? '#FFF0F0' : C.walkBg,
    accessibility: [] as any[],
    facilities: [] as any[],
    detail: leg.detailText,
    isDestination,
  };
}

function makeWalkSegment(leg: WalkLeg) {
  return { type: 'walk', duration: leg.durationMin, label: `도보 ${formatMinutes(leg.durationMin)}`, icon: '🚶', color: C.walk };
}

// 카카오가 준 환승/역 도보 스텝(steps[i].type === 'WALKING')의 시간·거리를
// CCH 경사도 계산 결과로 덮어쓴다. 좌표는 카카오 것을 그대로 쓰되(짧은 실내·인근
// 이동이라 별도 GPS 내비게이션 화면까지는 만들지 않음), 소요시간 추정치와
// 경사 유의사항만 실측 기반으로 정확하게 맞춘다.
function applyCchWalkLeg(uiStep: any, segment: any, leg: WalkLeg) {
  if (!uiStep || !segment) return;
  const distanceText = leg.distanceM != null ? formatDistanceText(leg.distanceM) : '';
  uiStep.subtitle = `도보 ${formatMinutes(leg.durationMin)}${distanceText ? ` · 약 ${distanceText}` : ''}`;
  uiStep.detail = leg.detailText ?? uiStep.detail;
  segment.duration = leg.durationMin;
  segment.label = `도보 ${formatMinutes(leg.durationMin)}`;
}

async function convertKakaoRoute(
  route: KakaoTransitRoute,
  index: number,
  apiUserType: string,
  origin: { lat?: string; lng?: string; name?: string },
  destination: { lat?: string; lng?: string; name?: string },
  limit: Limiter,
  legCache: LegCache,
  subwayCache: SubwayExitCache,
  lowfloorCache: LowfloorCache,
  chargerCache: ChargerCache,
) {
  const steps = route.steps ?? [];
  const { tag, tagColor } = routeTypeToTag(route.properties.type);

  const uiSteps: any[] = buildSteps(steps, apiUserType);
  const segments: any[] = buildSegments(steps);

  // 첫 스텝 시작 좌표 = 승차 지점, 마지막 스텝 끝 좌표 = 하차 지점
  const firstPoint = steps[0]?.path?.points?.[0];
  const lastPoints = steps[steps.length - 1]?.path?.points;
  const lastPoint = lastPoints?.[lastPoints.length - 1];

  let preWalkLeg: WalkLeg | null = null;
  let postWalkLeg: WalkLeg | null = null;

  const walkTasks: Promise<void>[] = [];

  // light: true — 아직 선택 안 된 후보 경로 단계라 GPS 안내용 waypoints는
  // 필요 없다(거리/시간/경사 zone만 있으면 목록·미리보기 지도에 충분). 실제로
  // 이 경로를 선택해 안내를 시작하면 handleStartNavigation에서 선택된 leg만
  // light:false로 다시 조회해 waypoints를 채운다.
  if (firstPoint && origin.lat && origin.lng) {
    walkTasks.push(
      computeWalkLeg(origin.lat, origin.lng, String(firstPoint[1]), String(firstPoint[0]), apiUserType, limit, legCache, true)
        .then(leg => { preWalkLeg = leg; })
    );
  }
  if (lastPoint && destination.lat && destination.lng) {
    walkTasks.push(
      computeWalkLeg(String(lastPoint[1]), String(lastPoint[0]), destination.lat, destination.lng, apiUserType, limit, legCache, true)
        .then(leg => { postWalkLeg = leg; })
    );
  }

  // 실제 승/하차 지점(도보 구간과 맞닿는 곳)이 지하철역이면, 그 지점 기준
  // 최적 출구(엘리베이터/에스컬레이터)를 백엔드에서 조회해 답사 하드코딩보다 우선 사용한다.
  // 중간 환승역은 대상에서 제외 — 실제 도보 이동이 발생하는 첫/마지막 역만 사용자 편의에 직결된다.
  const firstStep = steps[0];
  const lastStep  = steps[steps.length - 1];

  if (firstStep?.properties.type === 'SUBWAY' && origin.lat && origin.lng) {
    const stationName = firstStep.properties.stops?.[0]?.name;
    if (stationName) {
      walkTasks.push(
        computeSubwayExit(stationName, apiUserType, Number(origin.lat), Number(origin.lng), subwayCache)
          .then(exit => { if (exit) applyBestExit(uiSteps[0], exit); })
      );
      if (apiUserType === 'electric_wheelchair') {
        walkTasks.push(
          computeStationChargers(stationName, chargerCache)
            .then(chargers => { if (chargers) applyChargerInfo(uiSteps[0], chargers); })
        );
      }
    }
  }
  if (lastStep?.properties.type === 'SUBWAY' && destination.lat && destination.lng) {
    const stops = lastStep.properties.stops;
    const stationName = stops?.[stops.length - 1]?.name;
    if (stationName) {
      const idx = uiSteps.length - 1;
      walkTasks.push(
        computeSubwayExit(stationName, apiUserType, Number(destination.lat), Number(destination.lng), subwayCache)
          .then(exit => { if (exit) applyBestExit(uiSteps[idx], exit); })
      );
      if (apiUserType === 'electric_wheelchair') {
        walkTasks.push(
          computeStationChargers(stationName, chargerCache)
            .then(chargers => { if (chargers) applyChargerInfo(uiSteps[idx], chargers); })
        );
      }
    }
  }

  // 카카오가 준 환승/역 도보 스텝(승하차 지점과 무관한, 경로 중간의 WALKING
  // 스텝) — 좌표는 카카오 것을 그대로 쓰되, 소요시간·경사 유의사항만 CCH로
  // 재계산해 덮어쓴다. 실제 GPS 내비게이션 화면까지 만들지는 않는다(대부분
  // 100~300m의 역 구내/인근 이동이라 별도 안내보다 정확한 시간이 더 중요).
  steps.forEach((step, i) => {
    if (step.properties.type !== 'WALKING') return;
    const pts = step.path?.points;
    if (!pts || pts.length < 2) return;
    const [sLng, sLat] = pts[0];
    const [eLng, eLat] = pts[pts.length - 1];
    walkTasks.push(
      // 이 중간 환승 도보 스텝은 표시용 시간·거리 텍스트로만 쓰이고 별도 GPS
      // 안내 화면을 만들지 않으므로 항상 light 조회로 충분하다.
      computeWalkLeg(String(sLat), String(sLng), String(eLat), String(eLng), apiUserType, limit, legCache, true)
        .then(leg => applyCchWalkLeg(uiSteps[i], segments[i], leg))
    );
  });

  // 버스 구간이면 노선번호로 저상버스 보유율 조회(정적 데이터) — 한 스텝에
  // 여러 노선(예: "간선 402외 2대")이 묶인 경우 전부 조회해서 합쳐 보여준다.
  steps.forEach((step, i) => {
    if (step.properties.type !== 'BUS') return;
    for (const v of step.properties.vehicles ?? []) {
      walkTasks.push(
        computeLowfloorInfo(v.name, lowfloorCache)
          .then(info => { if (info) applyLowfloorInfo(uiSteps[i], info); })
      );
    }
  });

  await Promise.all(walkTasks);

  // 미리보기 지도용 구간별 색상 — 도보는 경사도 zone 색, 탑승 구간은 그 스텝의
  // 노선 브랜드 색(지하철/버스 색)을 써서 경사도 팔레트와 안 겹치게 분리한다.
  // uiSteps.unshift/push로 배열이 밀리기 전, steps와 uiSteps가 아직 1:1로
  // 대응할 때 만들어야 인덱스가 어긋나지 않는다.
  const mapSegments: import('./RouteMapView').MapRouteSegment[] = [];

  const walkLegToMapSegments = (leg: WalkLeg | null): import('./RouteMapView').MapRouteSegment[] => {
    const navSegs = leg?.serverRoute?.navigation_segments;
    const coords = pointsToCoordinates(leg?.serverRoute?.coordinates);
    if (Array.isArray(navSegs) && navSegs.length > 0 && coords.length > 0) {
      return navSegs
        .map((s: any) => ({
          coordinates: coords.slice(s.coord_start_idx ?? 0, (s.coord_end_idx ?? 0) + 1),
          color: ZONE_COLORS[s.zone] ?? ZONE_COLORS.flat,
          slopeMean: s.slope_mean,
          zone: s.zone,
        }))
        .filter((seg) => seg.coordinates.length >= 2);
    }
    return [];
  };

  if (preWalkLeg) {
    const preSegs = walkLegToMapSegments(preWalkLeg);
    if (preSegs.length > 0) {
      mapSegments.push(...preSegs);
    } else if (origin.lat && origin.lng && firstPoint) {
      mapSegments.push({
        coordinates: [
          { latitude: Number(origin.lat), longitude: Number(origin.lng) },
          { latitude: firstPoint[1], longitude: firstPoint[0] },
        ],
        color: C.walk,
      });
    }
  }

  steps.forEach((step, i) => {
    const pts = step.path?.points;
    if (!pts || pts.length < 2) return;
    const coords = pointsToCoordinates(pts);
    if (step.properties.type === 'WALKING') {
      mapSegments.push({ coordinates: coords, color: C.walk });
    } else {
      // 지도 선은 노선 브랜드색 대신 무채색으로 통일 — 도보 구간의 경사도
      // zone 색(특히 flat 초록)과 버스 브랜드색이 겹쳐 보이는 문제 때문.
      const transitLineColor = step.properties.type === 'BUS' ? C.transitLineBus : C.transitLineSubway;
      mapSegments.push({ coordinates: coords, color: transitLineColor });
    }
  });

  if (postWalkLeg) {
    const postSegs = walkLegToMapSegments(postWalkLeg);
    if (postSegs.length > 0) {
      mapSegments.push(...postSegs);
    } else if (destination.lat && destination.lng && lastPoint) {
      mapSegments.push({
        coordinates: [
          { latitude: lastPoint[1], longitude: lastPoint[0] },
          { latitude: Number(destination.lat), longitude: Number(destination.lng) },
        ],
        color: C.walk,
      });
    }
  }

  // 마지막 카카오 스텝이 목적지 도착으로 잘못 표시되지 않도록,
  // 도보 구간이 뒤에 붙으면 isDestination 플래그를 옮긴다.
  if (postWalkLeg && uiSteps.length > 0) {
    uiSteps[uiSteps.length - 1].isDestination = false;
  }

  if (preWalkLeg) {
    uiSteps.unshift(makeWalkStep('walk-pre', preWalkLeg, `${origin.name ?? '출발지'}에서 승차 지점까지 이동`, false));
    segments.unshift(makeWalkSegment(preWalkLeg));
  }
  if (postWalkLeg) {
    uiSteps.push(makeWalkStep('walk-post', postWalkLeg, `${destination.name ?? '목적지'} 도착`, true));
    segments.push(makeWalkSegment(postWalkLeg));
  }

  // 노선번호/버스번호가 있으면 라벨에 반영 — segments를 그 자리에서 보강해서
  // 경로 목록 카드(segmentLegend)와 안내 화면 스테퍼(journeySteps) 둘 다
  // 같은 개선된 라벨을 쓰게 한다. segments/uiSteps는 항상 같은 순서로
  // unshift/push되므로 인덱스가 계속 맞는다.
  segments.forEach((seg: any, i: number) => {
    const step: any = uiSteps[i];
    if (seg.type === 'subway' && step?.lineNo) seg.label = `${step.lineNo}호선 ${formatMinutes(seg.duration)}`;
    else if (seg.type === 'bus' && step?.busNo) seg.label = `${step.busNo} ${formatMinutes(seg.duration)}`;
  });

  // 안내(NavigationScreen) 화면 상단 스테퍼용 — 전체 여정을 도보/버스/지하철
  // 조각으로 요약한다.
  const journeySteps = segments.map((seg) => ({ type: seg.type, icon: seg.icon, label: seg.label }));

  // 도보 구간(환승/승하차 전후 전부 CCH로 대체됐을 수 있음)이 반영된
  // segments 합산 — 카카오 원본 totalTime을 그대로 안 쓰는 이유.
  const totalTimeMin = Math.max(1, segments.reduce((sum, s) => sum + (s.duration ?? 0), 0));
  const fareValue = route.properties.fare?.value;
  const now = new Date();
  const arr = new Date(now.getTime() + totalTimeMin * 60 * 1000);

  // 이 경로가 답사 데이터가 있는 역/버스를 지나가면 실측 기반으로 "이용 가능"을 표시하고,
  // 그렇지 않으면(카카오 API만으로는 확인 불가) 임의로 단정하지 않는다.
  const hasKnownAccessibleLeg = uiSteps.some(s => (s.accessibility?.length ?? 0) > 0);

  // 탑승 구간(버스/지하철) 안내 — 도보1 끝난 뒤 ~ 도보2 시작 전 사이에 보여줄 카카오 원본 안내
  const ridingGuidance = steps.map(s => s.properties.guidance);

  // 하차 정류장/역명 — 반복 음성안내("OO역에서 내리세요")에 사용.
  // 마지막 탑승 스텝의 마지막 정류장이 실제 하차 지점이다.
  const lastRideStops = lastStep?.properties.type !== 'WALKING' ? lastStep?.properties.stops : undefined;
  const alightStationName = lastRideStops?.[lastRideStops.length - 1]?.name;

  return {
    id: `r${index}`,
    tag, tagColor,
    totalTime: totalTimeMin,
    cost: fareValue != null ? `${fareValue.toLocaleString()}원` : '요금 정보 없음',
    depTime: formatClock(now),
    arrTime: formatClock(arr),
    accessible: hasKnownAccessibleLeg,
    accessNote: hasKnownAccessibleLeg
      ? '답사 확인된 구간(엘리베이터/저상버스) 포함'
      : ACCESS_ADVISORY,
    segments,
    steps: uiSteps,
    // NavigationScreen에 그대로 넘겨서 실제 GPS+경사도 안내를 태울 원본 도보 경로
    preWalkRoute: (preWalkLeg as WalkLeg | null)?.serverRoute ?? null,
    postWalkRoute: (postWalkLeg as WalkLeg | null)?.serverRoute ?? null,
    // 출발지가 이미 승차 지점 바로 앞이면(역 정문에서 검색 등) 도보 거리가 0에 가까워
    // 출발/도착 마커가 겹치는 의미 없는 내비게이션 화면이 뜬다 — 그 판단에 쓸 거리값.
    preWalkDistanceM:  (preWalkLeg as WalkLeg | null)?.distanceM ?? null,
    postWalkDistanceM: (postWalkLeg as WalkLeg | null)?.distanceM ?? null,
    ridingGuidance,
    alightStationName,
    // 미리보기 지도용 — 도보(경사도 zone 색)/탑승(노선 색) 구간별 색상 폴리라인
    mapSegments,
    // NavigationScreen 상단 여정 스테퍼용 — 전체 여정 요약
    journeySteps,
    // 지도 표시용: 각 스텝의 실제 좌표 경로 (도보 구간은 아직 직선; 지도에서 폴리라인으로 사용)
    mapPath: {
      preWalk: preWalkLeg && origin.lat && origin.lng && firstPoint
        ? [[Number(origin.lng), Number(origin.lat)], firstPoint]
        : null,
      transit: steps.flatMap(s => s.path?.points ?? []),
      postWalk: postWalkLeg && destination.lat && destination.lng && lastPoint
        ? [lastPoint, [Number(destination.lng), Number(destination.lat)]]
        : null,
    },
  };
}

// ── 서브 컴포넌트 ───────────────────────────────────────────────
const AccessRow = ({ item }: { item: any }) => {
  const bgMap: Record<string, string> = { elevator: C.elevatorBg, escalator: C.escalatorBg, lowfloor: C.lowFloorBg };
  const colorMap: Record<string, string> = { elevator: C.elevator, escalator: C.escalator, lowfloor: C.lowFloor };
  return (
    <View style={[ss.accessRow, { backgroundColor: bgMap[item.type] || C.facilityBg }]}>
      <Text style={ss.accessIcon}>{item.icon}</Text>
      <Text style={[ss.accessText, { color: colorMap[item.type] || C.facility }]}>{item.text}</Text>
    </View>
  );
};

const FacilityBadge = ({ item }: { item: any }) => (
  <View style={ss.facilityBadge}>
    <Text style={ss.facilityIcon}>{item.icon}</Text>
    <Text style={ss.facilityLabel}>{item.label}</Text>
  </View>
);

const SegmentBar = ({ segments }: { segments: any[] }) => {
  const total = segments.reduce((s: number, g: any) => s + g.duration, 0);
  return (
    <View style={ss.segmentBar}>
      {segments.map((seg, i) => (
        <View
          key={i}
          style={[ss.segmentPiece, {
            flex: seg.duration / total,
            backgroundColor: seg.color,
            borderTopLeftRadius:     i === 0 ? 6 : 0,
            borderBottomLeftRadius:  i === 0 ? 6 : 0,
            borderTopRightRadius:    i === segments.length - 1 ? 6 : 0,
            borderBottomRightRadius: i === segments.length - 1 ? 6 : 0,
          }]}
        >
          {seg.duration >= 5 && <Text style={ss.segmentPieceText}>{seg.icon}</Text>}
        </View>
      ))}
    </View>
  );
};

const StepItem = ({ step, isLast }: { step: any; isLast: boolean }) => {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = step.accessibility?.length > 0 || step.facilities?.length > 0 || step.detail || step.stops;

  return (
    <View style={ss.stepItem}>
      {!isLast && <View style={[ss.stepLine, { backgroundColor: step.color + '40' }]} />}
      <View style={[ss.stepIconWrap, { backgroundColor: step.colorBg, borderColor: step.color }]}>
        <Text style={ss.stepIcon}>{step.icon}</Text>
      </View>
      <View style={ss.stepContent}>
        <TouchableOpacity onPress={() => hasDetail && setExpanded(e => !e)} activeOpacity={hasDetail ? 0.7 : 1}>
          <View style={ss.stepHeader}>
            <View style={{ flex: 1 }}>
              <View style={ss.stepTitleRow}>
                <Text style={[ss.stepTitle, step.isDestination && { color: C.danger }]}>{step.title}</Text>
                {step.lineNo && (
                  <View style={[ss.lineBadge, { backgroundColor: step.lineColor || step.color }]}>
                    <Text style={ss.lineBadgeText}>{step.lineNo}호선</Text>
                  </View>
                )}
                {step.busNo && (
                  <View style={[ss.busBadge, { backgroundColor: step.busType === 'lowfloor' ? C.lowFloor : C.bus }]}>
                    {step.busType === 'lowfloor' && <Text style={ss.lowFloorIcon}>♿</Text>}
                    <Text style={ss.busBadgeText}>{step.busNo}</Text>
                  </View>
                )}
              </View>
              <Text style={ss.stepSubtitle}>{step.subtitle}</Text>
              {step.nextBus && (
                <View style={ss.nextBusPill}>
                  <View style={ss.nextBusDot} />
                  <Text style={ss.nextBusText}>{step.nextBus}</Text>
                </View>
              )}
              {step.stops && (
                <View style={ss.stopsRow}>
                  {step.stops.map((s: string, i: number) => (
                    <React.Fragment key={i}>
                      <Text style={ss.stopName}>{s}</Text>
                      {i < step.stops.length - 1 && <Text style={ss.stopArrow}>›</Text>}
                    </React.Fragment>
                  ))}
                </View>
              )}
            </View>
            {hasDetail && <Text style={ss.stepExpandIcon}>{expanded ? '▲' : '▼'}</Text>}
          </View>
        </TouchableOpacity>
        {expanded && (
          <View style={ss.stepExpanded}>
            {step.detail && (
              <View style={ss.detailBox}>
                <Text style={ss.detailIcon}>💡</Text>
                <Text style={ss.detailText}>{step.detail}</Text>
              </View>
            )}
            {step.accessibility?.map((a: any, i: number) => <AccessRow key={i} item={a} />)}
            {step.facilities?.length > 0 && (
              <View style={ss.facilitiesRow}>
                {step.facilities.map((f: any, i: number) => <FacilityBadge key={i} item={f} />)}
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
};

const RouteCard = ({ route, selected, onSelect }: any) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const hasLowfloorBus = route.steps?.some((s: any) => s.busType === 'lowfloor');
  const handlePress = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.97, duration: 70, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1,    duration: 70, useNativeDriver: true }),
    ]).start();
    onSelect(route.id);
  };

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        activeOpacity={0.88} onPress={handlePress}
        style={[ss.routeCard, selected && { borderColor: route.tagColor, borderWidth: 2 }]}
      >
        <View style={[ss.routeCardBar, { backgroundColor: route.tagColor }]} />
        <View style={ss.routeCardBody}>
          <View style={ss.routeCardTop}>
            <View style={[ss.routeTag, { backgroundColor: route.tagColor + '18' }]}>
              <Text style={[ss.routeTagText, { color: route.tagColor }]}>{route.tag}</Text>
            </View>
            {route.accessible ? (
              <View style={ss.accessibleBadge}><Text style={ss.accessibleBadgeText}>♿ 교통약자 가능</Text></View>
            ) : (
              <View style={ss.notAccessibleBadge}><Text style={ss.notAccessibleBadgeText}>⚠ 일부 제한</Text></View>
            )}
            {hasLowfloorBus && (
              <View style={ss.lowFloorListBadge}><Text style={ss.lowFloorListBadgeText}>♿ 저상버스</Text></View>
            )}
            {selected && (
              <View style={ss.selectedBadge}><Text style={ss.selectedText}>✓ 선택</Text></View>
            )}
          </View>
          <View style={ss.routeCardMid}>
            <View>
              <View style={ss.timeRow}>
                <Text style={[ss.routeTime, { color: route.tagColor }]}>{formatMinutes(route.totalTime)}</Text>
              </View>
              <Text style={ss.routeDepArr}>{route.depTime} → {route.arrTime}</Text>
            </View>
            <View style={ss.costBox}>
              <Text style={ss.costIcon}>💳</Text>
              <Text style={ss.costText}>{route.cost}</Text>
            </View>
          </View>
          <SegmentBar segments={route.segments} />
          <View style={ss.segmentLegend}>
            {route.segments.filter((s: any) => s.type !== 'walk').map((s: any, i: number) => (
              <View key={i} style={ss.legendItem}>
                <View style={[ss.legendDot, { backgroundColor: s.color }]} />
                <Text style={ss.legendText}>{s.label}</Text>
              </View>
            ))}
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
};

function pointsToCoordinates(points?: [number, number][] | null): MapCoordinate[] {
  if (!points) return [];
  return points
    .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2)
    .map((p) => ({ latitude: Number(p[1]), longitude: Number(p[0]) }));
}

function routeToMapCoordinates(route: any): MapCoordinate[] {
  if (!route?.mapPath) return [];
  return [
    ...pointsToCoordinates(route.mapPath.preWalk),
    ...pointsToCoordinates(route.mapPath.transit),
    ...pointsToCoordinates(route.mapPath.postWalk),
  ];
}

// ── 대중교통 경로 조회 훅 ─────────────────────────────────────────
// RouteScreen이 탭 전환과 무관하게 항상 호출해서, 대중교통 탭을 열지 않아도
// 소요시간이 미리 계산되고(요구사항 1), 보행약자 유형을 바꾸면 지금 어떤 탭을
// 보고 있든 즉시 재계산이 시작되도록 한다(요구사항 2). TransitContent는 이 훅의
// 결과를 그대로 props로 받아서 화면(지도 WebView 포함)만 그린다.
export type TransitRoutesState = {
  routes: any[];
  loading: boolean;
  errorMessage: string | null;
  selectedRoute: string;
  setSelectedRoute: (id: string) => void;
};

export function useTransitRoutes({
  startLatitude,
  startLongitude,
  endLatitude,
  endLongitude,
  startName,
  endName,
  walkerType,
}: {
  startLatitude?: string;
  startLongitude?: string;
  endLatitude?: string;
  endLongitude?: string;
  startName?: string;
  endName?: string;
  walkerType?: string;
}): TransitRoutesState {
  const [routes, setRoutes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedRoute, setSelectedRoute] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!startLatitude || !startLongitude || !endLatitude || !endLongitude) {
        setLoading(false);
        setErrorMessage('출발지/도착지 좌표가 없어 대중교통 경로를 조회할 수 없습니다.');
        return;
      }

      setLoading(true);
      setErrorMessage(null);

      // RouteScreen이 설정값을 읽어 walkerType으로 내려주고, 사용자가 길안내 화면에서
      // 유형을 바꾸면 이 값이 즉시 갱신된다. 여기서 다시 저장소를 읽으면 그 변경이
      // 무시되고 항상 최초 저장값으로 되돌아가므로, 넘겨받은 값을 그대로 사용한다.
      const apiUserType = walkerType || 'manual_wheelchair';

      try {
        const res = await requestTransitDirections({
          startX: startLongitude,
          startY: startLatitude,
          endX: endLongitude,
          endY: endLatitude,
          startName,
          endName,
        });

        if (cancelled) return;

        const kakaoRoutes = res.routes ?? [];
        if (res.status !== 'OK' || kakaoRoutes.length === 0) {
          setRoutes([]);
          setErrorMessage('대중교통 경로를 찾을 수 없습니다.');
          return;
        }

        const limit = createLimiter(4);
        const legCache: LegCache = new Map();
        const subwayCache: SubwayExitCache = new Map();
        const lowfloorCache: LowfloorCache = new Map();
        const chargerCache: ChargerCache = new Map();
        const converted = await Promise.all(
          kakaoRoutes.map((r, i) =>
            convertKakaoRoute(
              r, i, apiUserType,
              { lat: startLatitude, lng: startLongitude, name: startName },
              { lat: endLatitude, lng: endLongitude, name: endName },
              limit,
              legCache,
              subwayCache,
              lowfloorCache,
              chargerCache,
            )
          )
        );

        if (cancelled) return;
        setRoutes(converted);
        setSelectedRoute(converted[0]?.id ?? '');
      } catch (e) {
        if (!cancelled) {
          setRoutes([]);
          setErrorMessage('대중교통 경로 조회 중 오류가 발생했습니다.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [startLatitude, startLongitude, endLatitude, endLongitude, startName, endName, walkerType]);

  return { routes, loading, errorMessage, selectedRoute, setSelectedRoute };
}

// ── 메인 ───────────────────────────────────────────────────────
interface Props {
  navigation: any;
  walkerType?: string;
  startLatitude?: string;
  startLongitude?: string;
  endLatitude?: string;
  endLongitude?: string;
  startName?: string;
  endName?: string;
  showSlopeMarkers?: boolean;
  onToggleSlopeMarkers?: () => void;
  transitState: TransitRoutesState;
}

export default function TransitContent({
  navigation,
  walkerType,
  startLatitude,
  startLongitude,
  endLatitude,
  endLongitude,
  startName,
  endName,
  showSlopeMarkers,
  onToggleSlopeMarkers,
  transitState,
}: Props) {
  const { routes, loading, errorMessage, selectedRoute, setSelectedRoute } = transitState;
  const [activeFilter, setActiveFilter]   = useState('all');
  const [view, setView]                   = useState<'routes' | 'steps'>('routes');
  const [containerHeight, setContainerHeight] = useState(H);

  // 대중교통 탭은 헤더/상단 카드들 아래 남는 공간(containerHeight)에서만 렌더되므로
  // 전체 화면 높이(H) 기준으로 시트 높이를 잡으면 확대 시 화면 밖으로 넘쳐 "확대가 안 되는" 것처럼 보인다.
  // 실제 렌더된 컨테이너 높이를 측정해 그 안에서 비율을 잡는다.
  // RouteScreen 상단 패널이 펼쳐진 상태에서는 containerHeight 자체가 320px 안팎으로 작아서,
  // 예전 40%~88% 비율을 쓰면 필터바+지도에 남는 공간이 지도 렌더가 사실상 불가능한
  // 수십 px 밖에 안 남아 지도가 최대 축소(한반도 전체)로 보이는 문제가 있었다.
  // 지도가 항상 최소한의 공간을 보장받도록 비율을 낮춘다.
  const { sheetExpanded, sheetHeight, toggleSheet, panHandlers } = useDraggableSheet(
    containerHeight,
    0.28,
    0.62
  );

  const filteredRoutes = routes.filter(r => {
    const types = r.segments.map((s: any) => s.type);
    const hasBus    = types.some((t: string) => t === 'bus' || t === 'lowfloor');
    const hasSubway = types.includes('subway');
    if (activeFilter === 'bus')    return hasBus && !hasSubway;
    if (activeFilter === 'subway') return hasSubway && !hasBus;
    if (activeFilter === 'mixed')  return hasBus && hasSubway;
    return true;
  });

  const currentRoute = routes.find(r => r.id === selectedRoute);

  // 매 렌더마다 새 배열/객체를 만들면 RouteMapView의 지도 HTML이 계속 재생성되어
  // 지도가 반복적으로 리로드되고(줌 초기화 포함) 깜빡인다. 실제로 바뀔 때만 새로 만든다.
  const mapRoutes = useMemo(
    () =>
      currentRoute
        ? [{
            id: currentRoute.id,
            color: C.primary,
            coordinates: routeToMapCoordinates(currentRoute),
            segments: currentRoute.mapSegments,
          }]
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentRoute?.id]
  );

  // 실제 경사도 엔진(coordinates/routeSegments)을 NavigationScreen에 그대로 넘겨서
  // 승차 전/하차 후 도보 구간을 우리가 설계한 GPS+경사도 안내로 진행시킨다.
  // 연타 방지 — 짧은 시간에 두 번 눌리면 NavigationScreen이 중복으로 push되어
  // GPS 구독·안내 상태가 겹치고, 리스트 렌더에서 key 충돌 경고까지 발생한다.
  const navigatingRef = useRef(false);

  const handleStartNavigation = async () => {
    if (!currentRoute || navigatingRef.current) return;
    navigatingRef.current = true;
    setTimeout(() => { navigatingRef.current = false; }, 1500);

    // 후보 목록 단계에서는 light:true로 조회해서 이 도보 구간들에 GPS 회전
    // 안내(waypoints)가 비어 있다 — 실제로 안내를 시작하는 지금, 사용자가
    // 고른 이 경로의 pre/post walk 구간 딱 2개만 light:false로 다시 조회해
    // 채운다(실패해도 좌표/경사 데이터는 이미 있으니 안내 자체는 진행).
    const apiUserType = walkerType || 'manual_wheelchair';
    let preWalkRoute  = currentRoute.preWalkRoute;
    let postWalkRoute = currentRoute.postWalkRoute;
    const fullLimit = createLimiter(2);
    const refetchTasks: Promise<void>[] = [];

    if (preWalkRoute && startLatitude && startLongitude) {
      const boardPt = preWalkRoute.coordinates?.[preWalkRoute.coordinates.length - 1];
      if (boardPt) {
        refetchTasks.push(
          computeWalkLegUncached(
            startLatitude, startLongitude, String(boardPt[1]), String(boardPt[0]),
            apiUserType, fullLimit, false,
          ).then(leg => { if (leg.serverRoute) preWalkRoute = leg.serverRoute; })
        );
      }
    }
    if (postWalkRoute && endLatitude && endLongitude) {
      const alightPt = postWalkRoute.coordinates?.[0];
      if (alightPt) {
        refetchTasks.push(
          computeWalkLegUncached(
            String(alightPt[1]), String(alightPt[0]), endLatitude, endLongitude,
            apiUserType, fullLimit, false,
          ).then(leg => { if (leg.serverRoute) postWalkRoute = leg.serverRoute; })
        );
      }
    }
    if (refetchTasks.length > 0) await Promise.all(refetchTasks);

    const toWalkRouteData = (r: any) => JSON.stringify({
      coordinates: r.coordinates,
      routeSegments: r.routeSegments,
      totalDistance: r.totalDistance,
      avgSlope: r.avgSlope,
      detourRatio: r.detourRatio,
      navigation_segments: r.navigation_segments,
      waypoints: r.waypoints,
    });

    // 출발지가 승차 지점과 (좌표상) 사실상 같은 지점일 때만 걸러낸다 — 20m
    // 기준이었을 때는 정상적인 짧은 도보 구간(승강장 진입 등)까지 안내가
    // 통째로 생략되는 부작용이 있었다. 진짜 같은 지점(역 정문 검색 등)일
    // 때만, 즉 출발/도착 마커가 겹쳐서 화면이 의미 없어지는 경우만 거른다.
    const MIN_WALK_LEG_M = 5;
    const hasRealPreWalk  = !!currentRoute.preWalkRoute  && (currentRoute.preWalkDistanceM  ?? 0) >= MIN_WALK_LEG_M;
    const hasRealPostWalk = !!currentRoute.postWalkRoute && (currentRoute.postWalkDistanceM ?? 0) >= MIN_WALK_LEG_M;

    // NavigationScreen 상단 여정 스테퍼용 — 전체 구간 요약 + 지금 안내 중인 구간의 인덱스.
    const journeySteps: any[] = currentRoute.journeySteps ?? [];
    const journeyStepsJson = JSON.stringify(journeySteps);

    // NavigationScreen 지도에 "지금 GPS로 안내 중이 아닌 나머지 구간"도 옅은
    // 참고선으로 같이 그리기 위한 전체 여정 좌표 — 미리보기 지도(mapRoutes)에서
    // 쓰던 것과 동일한 값을 재사용한다.
    const journeyMapPathJson = JSON.stringify(routeToMapCoordinates(currentRoute));
    // 구간별로 화면을 나눠 안내받고 싶지 않다는 요청 반영 — 참고선 대신 미리보기
    // 지도와 똑같이 색칠된(경사도 zone / 노선색) 전체 여정을 그대로 그린다.
    // GPS 추적·다음 구간 전환 로직 자체는 그대로 두고, 시각적으로만 전체가
    // 항상 보이게 한다.
    const journeyMapSegmentsJson = JSON.stringify(currentRoute.mapSegments ?? []);

    // 헤더에는 항상 "진짜 최종 목적지"를 보여주기 위한 필드. 도보 leg의 to는
    // (승차 지점/환승 지점 등) 그 구간의 GPS 목적지일 뿐 실제 여행의 끝이 아니다.
    console.log('[TransitContent] handleStartNavigation: endName(최종 목적지)=', endName,
      '| hasRealPreWalk=', hasRealPreWalk, 'hasRealPostWalk=', hasRealPostWalk);

    const postWalkParams = hasRealPostWalk ? {
      routeId: currentRoute.id,
      mode: 'transit',
      from: '환승 지점',
      to: endName,
      walkerType,
      endName, endLatitude, endLongitude,
      routeData: toWalkRouteData(postWalkRoute),
      journeySteps: journeyStepsJson,
      legIndex: String(journeySteps.length - 1),
      journeyMapPath: journeyMapPathJson,
      journeyMapSegments: journeyMapSegmentsJson,
      finalDestinationName: endName,
      finalOriginName: startName,
    } : null;

    const preWalkParams = hasRealPreWalk ? {
      routeId: currentRoute.id,
      mode: 'transit',
      from: startName,
      to: '승차 지점',
      walkerType,
      startName, startLatitude, startLongitude,
      routeData: toWalkRouteData(preWalkRoute),
      journeySteps: journeyStepsJson,
      legIndex: '0',
      journeyMapPath: journeyMapPathJson,
      journeyMapSegments: journeyMapSegmentsJson,
      finalDestinationName: endName,
      finalOriginName: startName,
      ...(postWalkParams ? {
        transitNextLeg: JSON.stringify({
          ridingGuidance: currentRoute.ridingGuidance,
          alightStationName: currentRoute.alightStationName,
          nextLegParams: postWalkParams,
        }),
      } : {}),
    } : null;

    if (preWalkParams) {
      navigation?.navigate('Navigation', preWalkParams);
    } else if (postWalkParams) {
      // 카카오가 승차 전 도보 스텝을 안 줬거나, 도보 거리가 너무 짧아 생략된 경로
      // — 원래 preWalkParams에 실려갔을 탑승 안내를 놓치지 않도록 알림으로 띄운다.
      if (currentRoute.ridingGuidance?.length) {
        Alert.alert('탑승 안내', currentRoute.ridingGuidance.filter(Boolean).join('\n'));
      }
      navigation?.navigate('Navigation', postWalkParams);
    } else {
      // 도보 구간 자체가 없는 경로(버스/지하철만) — 안내할 도보 구간이 없어 스텁 이동.
      // 그래도 탑승 안내(몇 호선/몇 번 버스 타고 어디서 내리는지)는 놓치면 안 되니 알림으로.
      if (currentRoute.ridingGuidance?.length) {
        Alert.alert('탑승 안내', currentRoute.ridingGuidance.filter(Boolean).join('\n'));
      }
      navigation?.navigate('Navigation', {
        routeId: currentRoute.id, mode: 'transit',
        journeySteps: journeyStepsJson, legIndex: '-1',
        journeyMapPath: journeyMapPathJson,
        journeyMapSegments: journeyMapSegmentsJson,
        finalDestinationName: endName,
        finalOriginName: startName,
      });
    }
  };

  return (
    <View
      style={ss.content}
      onLayout={(e) => setContainerHeight(e.nativeEvent.layout.height)}
    >
      {/* 필터 탭 */}
      <View style={ss.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={ss.filterBarScroll}>
          {FILTER_TABS.map(f => (
            <TouchableOpacity
              key={f.key}
              style={[ss.filterTab, activeFilter === f.key && ss.filterTabActive]}
              onPress={() => setActiveFilter(f.key)}
            >
              <Text style={[ss.filterTabText, activeFilter === f.key && ss.filterTabTextActive]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={ss.accessFilterTab}>
            <Text style={ss.accessFilterText}>♿ 교통약자 우선</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      <RouteMapView
        routes={mapRoutes}
        selectedRouteId={currentRoute?.id ?? ''}
        startLabel={startName}
        endLabel={endName}
        showSlopeMarkers={showSlopeMarkers}
        onToggleSlopeMarkers={onToggleSlopeMarkers}
      />

      <Animated.View style={[ss.bottomSheet, { height: sheetHeight }]}>
        <View style={ss.sheetHandle}>
          <View style={ss.sheetDragStrip} {...panHandlers}>
            <View style={ss.sheetHandleBar} />
          </View>
          <View style={ss.sheetTitleRow}>
            <Text style={ss.sheetTitle}>
              {view === 'routes' ? '경로 선택' : `${currentRoute?.tag} 상세 안내`}
            </Text>
            <Text style={ss.sheetSub}>
              {view === 'routes' ? `${routes.length}개 경로` : `${currentRoute?.steps.length}단계`}
            </Text>
            <View style={{ flex: 1 }} />
            {view === 'steps' && (
              <TouchableOpacity style={ss.viewSwitchBtn} onPress={() => setView('routes')}>
                <Text style={ss.viewSwitchText}>← 경로 목록</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={toggleSheet} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={ss.sheetExpandIcon}>{sheetExpanded ? '▼' : '▲'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {view === 'routes' && loading && (
          <View style={ss.noSteps}>
            <Text style={ss.noStepsText}>대중교통 경로를 불러오는 중...</Text>
          </View>
        )}

        {view === 'routes' && !loading && errorMessage && (
          <View style={ss.noSteps}>
            <Text style={ss.noStepsText}>{errorMessage}</Text>
          </View>
        )}

        {view === 'routes' && !loading && !errorMessage && (
          <ScrollView style={ss.sheetScroll} contentContainerStyle={ss.sheetScrollContent} showsVerticalScrollIndicator={false}>
            {filteredRoutes.map(route => (
              <RouteCard
                key={route.id} route={route}
                selected={selectedRoute === route.id}
                onSelect={(id: string) => {
                  setSelectedRoute(id);
                  setView('steps');
                  if (!sheetExpanded) toggleSheet();
                }}
              />
            ))}
            <View style={{ height: 16 }} />
          </ScrollView>
        )}

        {view === 'steps' && currentRoute && currentRoute.steps.length > 0 && (
          <ScrollView style={ss.sheetScroll} contentContainerStyle={[ss.sheetScrollContent, { paddingHorizontal: 16 }]} showsVerticalScrollIndicator={false}>
            <View style={ss.summaryChip}>
              <Text style={ss.summaryTime}>{formatMinutes(currentRoute.totalTime)}</Text>
              <Text style={ss.summarySep}>·</Text>
              <Text style={ss.summaryCost}>{currentRoute.cost}</Text>
              <Text style={ss.summarySep}>·</Text>
              <Text style={ss.summaryAccess}>{currentRoute.accessNote}</Text>
            </View>
            {(() => {
              const knownBusStep = currentRoute.steps.find((s: any) => s.busNo && s.busType === 'lowfloor');
              if (knownBusStep) {
                const lowfloorText = knownBusStep.accessibility?.find((a: any) => a.type === 'lowfloor')?.text
                  ?? `${knownBusStep.busNo} 저상버스 운행 확인됨`;
                return (
                  <View style={ss.lowFloorAlert}>
                    <Text style={ss.lowFloorAlertIcon}>♿</Text>
                    <Text style={ss.lowFloorAlertText}>{lowfloorText}</Text>
                  </View>
                );
              }
              const hasBus = currentRoute.segments.some((s: any) => s.type === 'bus' || s.type === 'lowfloor');
              if (!hasBus) return null;
              return (
                <View style={ss.lowFloorAlert}>
                  <Text style={ss.lowFloorAlertIcon}>♿</Text>
                  <Text style={ss.lowFloorAlertText}>버스 탑승 시 저상버스 여부는 현장에서 확인해 주세요</Text>
                </View>
              );
            })()}
            {currentRoute.steps.map((step, i) => (
              <StepItem key={step.id} step={step} isLast={i === currentRoute.steps.length - 1} />
            ))}
            <View style={{ height: 20 }} />
          </ScrollView>
        )}

        {view === 'steps' && currentRoute?.steps.length === 0 && (
          <View style={ss.noSteps}>
            <Text style={ss.noStepsText}>해당 경로의 상세 정보를 불러오는 중...</Text>
          </View>
        )}
      </Animated.View>

      <View style={ss.startBtnWrap}>
        <TouchableOpacity
          style={[ss.startBtn, { backgroundColor: C.subway }]}
          activeOpacity={0.85}
          onPress={handleStartNavigation}
        >
          <Text style={ss.startBtnIcon}>🚌</Text>
          <Text style={ss.startBtnText}>{currentRoute?.tag} 경로로 대중교통 안내 시작</Text>
          <Text style={ss.startBtnArrow}>→</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const ss = StyleSheet.create({
  content: { flex: 1 },

  filterBar: { backgroundColor: C.white, borderBottomWidth: 1, borderBottomColor: C.border },
  filterBarScroll: { paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  filterTab: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
  },
  filterTabActive: { backgroundColor: C.primary, borderColor: C.primary },
  filterTabText: { fontSize: 12, color: C.textSub, fontWeight: '500' },
  filterTabTextActive: { color: C.white, fontWeight: '700' },
  accessFilterTab: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
    backgroundColor: C.primaryBg, borderWidth: 1.5, borderColor: C.primary,
  },
  accessFilterText: { fontSize: 12, color: C.primary, fontWeight: '700' },

  mapContainer: { flex: 1 },
  mapBg: { flex: 1, backgroundColor: '#E8EBF0', position: 'relative', overflow: 'hidden' },
  mapGridH: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(200,204,218,0.5)' },
  mapGridV: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(200,204,218,0.5)' },
  mapMarker: { position: 'absolute', alignItems: 'center' },
  markerCircle: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: C.white, elevation: 4 },
  markerLabel: {
    fontSize: 10, fontWeight: '700', color: C.text,
    backgroundColor: C.white, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 8, marginTop: 2, overflow: 'hidden', elevation: 2,
  },
  elevChip: {
    position: 'absolute', backgroundColor: C.elevatorBg, borderRadius: 14,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: C.elevator, elevation: 3,
  },
  elevChipText: { fontSize: 11, color: C.elevator, fontWeight: '600' },
  busChip: {
    position: 'absolute', backgroundColor: C.lowFloorBg, borderRadius: 14,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: C.lowFloor, elevation: 3,
  },
  busChipText: { fontSize: 11, color: C.lowFloor, fontWeight: '600' },
  mapControls: { position: 'absolute', right: 14, top: '25%', gap: 6 },
  mapControlBtn: {
    width: 38, height: 38, borderRadius: 10, backgroundColor: C.white,
    alignItems: 'center', justifyContent: 'center', elevation: 3,
  },
  mapControlIcon: { fontSize: 18, color: C.text, fontWeight: '600' },

  bottomSheet: {
    backgroundColor: C.white, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    elevation: 14, shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.12, shadowRadius: 12, overflow: 'hidden',
  },
  sheetHandle: {
    paddingHorizontal: 16, paddingBottom: 8,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  sheetDragStrip: {
    width: '100%', paddingVertical: 10, alignItems: 'center',
  },
  sheetHandleBar: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: C.border,
  },
  sheetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: C.text },
  sheetSub: {
    fontSize: 12, color: C.textSub, backgroundColor: C.primaryBg,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, overflow: 'hidden',
  },
  viewSwitchBtn: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: C.primaryBg, borderRadius: 12 },
  viewSwitchText: { fontSize: 12, color: C.primary, fontWeight: '600' },
  sheetExpandIcon: { fontSize: 14, color: C.textMute },
  sheetScroll: { flex: 1 },
  // 하단 96px은 이제 absolute로 뜬 startBtnWrap 높이만큼 — 마지막 스텝이 버튼 뒤에 가리지 않게.
  sheetScrollContent: { padding: 14, paddingBottom: 96, gap: 10 },
  noSteps: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  noStepsText: { color: C.textMute, fontSize: 14 },

  routeCard: {
    backgroundColor: C.white, borderRadius: 16, borderWidth: 1.5, borderColor: C.border, overflow: 'hidden',
    elevation: 2, shadowColor: C.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 1, shadowRadius: 6,
  },
  routeCardBar: { height: 4 },
  routeCardBody: { padding: 14, gap: 10 },
  routeCardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  routeTag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  routeTagText: { fontSize: 12, fontWeight: '700' },
  accessibleBadge: { backgroundColor: C.lowFloorBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  accessibleBadgeText: { fontSize: 11, color: C.lowFloor, fontWeight: '600' },
  notAccessibleBadge: { backgroundColor: '#FFF3E0', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  notAccessibleBadgeText: { fontSize: 11, color: C.warn, fontWeight: '600' },
  lowFloorListBadge: { backgroundColor: C.lowFloorBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  lowFloorListBadgeText: { fontSize: 11, color: C.lowFloor, fontWeight: '600' },
  selectedBadge: { backgroundColor: C.success + '22', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  selectedText: { fontSize: 11, color: C.success, fontWeight: '700' },
  routeCardMid: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  timeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  routeTime: { fontSize: 34, fontWeight: '900', lineHeight: 38 },
  routeTimeUnit: { fontSize: 14, fontWeight: '600', color: C.textSub, marginBottom: 5 },
  routeDepArr: { fontSize: 12, color: C.textSub, marginTop: 2 },
  costBox: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.bg,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, gap: 5,
  },
  costIcon: { fontSize: 14 },
  costText: { fontSize: 14, fontWeight: '700', color: C.text },
  segmentBar: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', gap: 2 },
  segmentPiece: { alignItems: 'center', justifyContent: 'center' },
  segmentPieceText: { fontSize: 8, color: C.white },
  segmentLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11, color: C.textSub },

  summaryChip: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.primaryBg,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, gap: 8, marginBottom: 8,
  },
  summaryTime: { fontSize: 16, fontWeight: '800', color: C.primary },
  summarySep: { fontSize: 14, color: C.textMute },
  summaryCost: { fontSize: 13, fontWeight: '600', color: C.text },
  summaryAccess: { fontSize: 12, color: C.textSub, flex: 1 },
  lowFloorAlert: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.lowFloorBg,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, gap: 8, marginBottom: 12,
    borderWidth: 1, borderColor: C.lowFloor + '60',
  },
  lowFloorAlertIcon: { fontSize: 16 },
  lowFloorAlertText: { flex: 1, fontSize: 12, color: C.lowFloor, fontWeight: '600' },
  realTimeBadge: { backgroundColor: C.lowFloor, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  realTimeText: { fontSize: 10, color: C.white, fontWeight: '700' },

  stepItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 4, position: 'relative' },
  stepLine: { position: 'absolute', left: 19, top: 40, width: 2, bottom: -8, zIndex: 0 },
  stepIconWrap: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, zIndex: 1, elevation: 2,
  },
  stepIcon: { fontSize: 18 },
  stepContent: { flex: 1, paddingBottom: 16 },
  stepHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  stepTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 },
  stepTitle: { fontSize: 15, fontWeight: '700', color: C.text },
  stepSubtitle: { fontSize: 12, color: C.textSub, lineHeight: 18 },
  stepExpandIcon: { fontSize: 12, color: C.textMute, marginLeft: 8, marginTop: 4 },
  lineBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  lineBadgeText: { fontSize: 11, color: C.white, fontWeight: '700' },
  busBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, gap: 4 },
  lowFloorIcon: { fontSize: 10, color: C.white },
  busBadgeText: { fontSize: 11, color: C.white, fontWeight: '700' },
  nextBusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.lowFloorBg,
    borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start', marginTop: 4,
  },
  nextBusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.lowFloor },
  nextBusText: { fontSize: 11, color: C.lowFloor, fontWeight: '600' },
  stopsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 2, marginTop: 4 },
  stopName: { fontSize: 11, color: C.textSub, fontWeight: '500' },
  stopArrow: { fontSize: 11, color: C.textMute },
  stepExpanded: { marginTop: 8, gap: 6 },
  detailBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: '#FFFBF0', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8,
    borderWidth: 1, borderColor: '#FFE8A3',
  },
  detailIcon: { fontSize: 14 },
  detailText: { flex: 1, fontSize: 12, color: '#7A6000', lineHeight: 18 },
  accessRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  accessIcon: { fontSize: 14 },
  accessText: { fontSize: 12, fontWeight: '600', flex: 1 },
  facilitiesRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  facilityBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.facilityBg,
    borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4,
  },
  facilityIcon: { fontSize: 12 },
  facilityLabel: { fontSize: 11, color: C.facility, fontWeight: '600' },

  startBtnWrap: {
    // 일반 flex 흐름에 두면 시트가 확장(최대 62%)됐을 때 지도 minHeight(180)와
    // 합쳐 화면 높이를 넘어서 버튼이 화면 밖으로 밀려난다. 시트 상태와 무관하게
    // 항상 화면 하단에 고정되도록 absolute로 뺀다.
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: C.white, paddingHorizontal: 16, paddingVertical: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 12,
    borderTopWidth: 1, borderTopColor: C.border,
    elevation: 16, shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.1, shadowRadius: 8,
  },
  startBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 16, paddingVertical: 16, paddingHorizontal: 24, gap: 10,
    elevation: 4, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8,
  },
  startBtnIcon: { fontSize: 20 },
  startBtnText: { fontSize: 15, fontWeight: '800', color: C.white, flex: 1, textAlign: 'center' },
  startBtnArrow: { fontSize: 18, color: 'rgba(255,255,255,0.7)' },
});
