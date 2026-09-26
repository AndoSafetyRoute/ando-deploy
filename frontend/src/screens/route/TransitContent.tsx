import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Animated, Dimensions, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { C, ZONE_COLORS, busTypeColor, subwayLineColor } from '../../constants/colors';
import { formatMinutes } from '../../utils/storage';
import {
  requestTransitDirections,
  KakaoTransitRoute,
  KakaoTransitStep,
  KakaoTransitStepType,
} from '../../api/transitApi';
import {
  requestWalkLeg, requestSubwayBestExit, SubwayBestExit,
  requestStationChargers, StationCharger,
  createWalkLegBatcher, WalkLegRequest, WalkLegsMeta, WalkRouteKind,
} from '../../api/routeApi';
import { getAuthToken } from '../../api';
import RouteMapView, { MapCoordinate } from './RouteMapView';
import { useDraggableSheet } from './useDraggableSheet';
import BusArrivalBadge from '../../components/BusArrivalBadge';
import SubwayArrivalBadge from '../../components/SubwayArrivalBadge';
import { stationNameOf, sameStation } from '../../utils/stationName';

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
// 답사 데이터가 없는 역/버스는 임의로 지어내지 않는다(출구 안내는 서버 역 데이터로 — destExitNote).

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

// 카카오 환승 도보 안내는 역명이 앞에 한 번 더 붙어 온다("사당사당역 환승",
// "신사신사역까지 도보로 이동") — 반복된 앞쪽 역명만 뗀다.
function dedupeStationPrefix(text: string) {
  return (text ?? '').replace(/^(.{2,}?)\1(?=역)/, '$1');
}

// "4" → "4호선", "신분당선"·"경의중앙선"·"공항철도"는 그대로
function lineLabel(lineNo: string) {
  return /^\d+$/.test(lineNo) ? `${lineNo}호선` : lineNo;
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
    const detail = showAdvisory ? known?.detail : undefined;

    return {
      id: `k${i}`,
      type: uiType,
      title: p.type === 'WALKING' ? dedupeStationPrefix(p.guidance) : p.guidance,
      subtitle: `${label} ${formatMinutes(duration)}${distanceText ? ` · 약 ${distanceText}` : ''}`,
      icon, color, colorBg,
      lineNo: p.type === 'SUBWAY' && vehicle ? vehicle.name.replace(/호선$/, '') : undefined,
      lineColor: p.type === 'SUBWAY' ? (subwayLineColor(vehicle?.name) ?? color) : undefined,
      busNo,
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

// 도보 구간 1개를 서버에 물어보는 방법 — 응답은 /route/safe 형태로 통일.
// 유형별(초기 화면)은 기존대로 구간마다 요청(동시 제한 limit), 최단/맞춤형 토글은
// 묶음 요청(/route/legs)으로 왕복 수를 줄인다.
type LegFetcher = (req: WalkLegRequest, light: boolean) => Promise<any>;

function singleLegFetcher(apiUserType: string, limit: Limiter, routeKind: WalkRouteKind = 'type'): LegFetcher {
  return (req, light) => limit(() => requestWalkLeg({
    startLatitude: req.fromLat, startLongitude: req.fromLng,
    endLatitude: req.toLat, endLongitude: req.toLng,
    userType: apiUserType,
    light,
    endStationName: req.endStationName,
    startStationName: req.startStationName,
    routeKind,
  }));
}

// 묶음 요청은 후보 목록용(light)만 — 안내 시작 시 full 재조회는 singleLegFetcher 로.
function batchLegFetcher(
  apiUserType: string, routeKind: WalkRouteKind, onMeta?: (m: WalkLegsMeta) => void,
): LegFetcher {
  const batch = createWalkLegBatcher(apiUserType, routeKind, onMeta);
  return (req) => batch(req);
}

// 카카오 경로 하나의 승차 지점/하차 지점 좌표 추출(steps[0]/steps[마지막])이
// 어긋나면(예: 스텝이 사실상 도보 하나뿐이거나 경로 형태가 예상과 다르면)
// "구간"이 실제로는 전체 경로 규모(수 km~십수 km)로 계산되는 경우가 있었다.
// 이런 경우 CCH 우회 계산(추천급 이진탐색, 최대 2~3초)까지 타면서 15개 경로가
// 동시에 걸리면 전체가 느려지거나 사실상 멈춘 것처럼 보였다. 실제 정류장 접근
// 도보 구간은 이보다 훨씬 짧은 게 정상이므로, 넘는 경우 계산을 아예 생략하고
// 직선거리 추정치로 대체한다.
const MAX_LEG_STRAIGHT_M = 2000;

// 대중교통 탭 "경로 선택" 헤더의 도보 구간 경로 종류 토글.
const WALK_KIND_TABS: { key: WalkRouteKind; label: string }[] = [
  { key: 'type',     label: '유형별' },
  { key: 'distance', label: '최단' },
  { key: 'personal', label: '맞춤형' },
];

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
  fetchLeg: LegFetcher,
  cache: LegCache,
  light: boolean,
  endStationName?: string,
  startStationName?: string,
): Promise<WalkLeg> {
  const key = `${legCacheKey(fromLat, fromLng, toLat, toLng, apiUserType, light)}|${startStationName ?? ''}|${endStationName ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = computeWalkLegUncached(fromLat, fromLng, toLat, toLng, apiUserType, fetchLeg, light, endStationName, startStationName);
  cache.set(key, promise);
  return promise;
}

async function computeWalkLegUncached(
  fromLat: string, fromLng: string,
  toLat: string, toLng: string,
  apiUserType: string,
  fetchLeg: LegFetcher,
  light: boolean,
  endStationName?: string,
  startStationName?: string,
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
    const res = await fetchLeg(
      { fromLat, fromLng, toLat, toLng, endStationName, startStationName },
      light,
    );
    const bestRoute = res?.routes?.[0] ?? null;
    // navigation_segments(구간 색상)/waypoints(음성안내)/measurement_units(GPS 실측
    // 제출 단위)는 routes[0]이 아니라 응답 최상위 필드라서, NavigationScreen이
    // 그대로 읽을 수 있게 같이 얹어준다.
    const best = bestRoute
      ? {
          ...bestRoute,
          navigation_segments: res?.navigation_segments,
          waypoints:           res?.waypoints,
          measurement_units:   res?.measurement_units,
          // 도착지가 역이면 서버가 고른 보행약자용 출구(역·출구번호·문구)
          stationExit:         res?.stationExit,
          startStationExit:    res?.startStationExit,
        }
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
  direction: 'entering' | 'exiting',
  cache: SubwayExitCache,
): Promise<SubwayBestExit | null> {
  // 환승역은 기준점(직전/다음 정류장)에 따라 가까운 출구가 달라지므로 좌표도 키에 넣는다.
  const key = `${station}:${apiUserType}:${direction}:${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = requestSubwayBestExit(station, apiUserType, lat, lon, direction);
  cache.set(key, promise);
  return promise;
}

// 백엔드 실측(서울 열린데이터광장, 5분 갱신) 출구 정보를 스텝에 반영.
// 답사 하드코딩 정보보다 항상 우선 — 고장 여부까지 반영된 실시간 데이터이기 때문.
function bestExitRow(exit: SubwayBestExit) {
  const icon = exit.type === 'elevator' ? '🛗' : exit.type === 'escalator' ? '🔼' : '🦼';
  return { type: exit.type, text: exit.message, icon, exit: true };
}

// 카카오 환승 도보 안내의 "(4번 출구)"는 일반 출구 기준 — 보행약자용 출구 번호로 바꾼다.
function withExitNo(title: string | undefined, exitNo: string) {
  const t = title ?? '';
  const re = /\(\s*[\d-]+번\s*출구\s*\)/;
  return re.test(t) ? t.replace(re, `(${exitNo}번 출구)`) : `${t} (${exitNo}번 출구)`.trim();
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

type ExitInfo = { station: string; exitNo: string; facilities: string[]; message: string; lat?: number; lon?: number };

const FACILITY_LABELS: Record<string, string> = { elevator: '엘리베이터', escalator: '에스컬레이터', lift: '휠체어리프트' };

// /subway/best-exit 응답 → 공통 출구 정보
function bestExitToInfo(exit: SubwayBestExit | null): ExitInfo | null {
  if (!exit) return null;
  return {
    station: exit.station ?? '',
    exitNo: exit.exit_no,
    facilities: exit.facilities ?? [exit.type],
    message: exit.message,
    lat: exit.lat, lon: exit.lon,
  };
}

// 출구 행(접힘과 무관하게 항상 표시)
function exitAccessRow(exit: ExitInfo) {
  const hasElev = (exit.facilities ?? []).includes('elevator');
  return { type: hasElev ? 'elevator' : 'escalator', text: exit.message, icon: hasElev ? '🛗' : '🔼', exit: true };
}

function exitPhrase(exit: ExitInfo): string {
  const fac = (exit.facilities ?? []).map((f) => FACILITY_LABELS[f] ?? f).join('·');
  return `${exit.station} ${exit.exitNo}번 출구${fac ? `(${fac})` : ''}`;
}

// 상세 안내 상단 문구. 출발/도착이 역이면 보행약자용 출구 안내, 둘 다 아니면 도보 안내 원칙.
function destExitNote(destExit: ExitInfo | null, startExit: ExitInfo | null = null): string {
  const lines: string[] = [];
  if (startExit?.station && startExit?.exitNo) lines.push(`출발: ${exitPhrase(startExit)}로 안내합니다.`);
  if (destExit?.station && destExit?.exitNo) lines.push(`${startExit ? '도착: ' : ''}${exitPhrase(destExit)}로 안내합니다.`);
  return lines.length ? lines.join('\n') : '도보 구간은 계단을 피하고 경사가 완만한 길로 안내합니다.';
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
  fetchLeg: LegFetcher,
  legCache: LegCache,
  subwayCache: SubwayExitCache,
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

  // 거리 ↔ 승강장을 오가는 지하철역의 출구 — 첫 승차역, 마지막 하차역, 버스↔지하철 환승역.
  // 지하철끼리 갈아타는 역은 밖으로 나가지 않으므로 제외한다. 도보는 그 역의 보행약자용
  // 출구까지로 맞추고, 지도에선 출구 ↔ 역(탑승 구간 끝점)을 점선으로 이어 거리 도보와 구분한다.
  //  - 출발역 = 첫 탑승역이면: 도보 없이 그 역 출구에서 출발(핀도 출구)
  //  - 도착역 = 마지막 하차역이면: 도보 없이 그 역 출구에서 도착(핀도 출구)
  //  - 그 외(버스로 가거나 다른 역에서 타고 내림): 도보 구간을 서버가 출발/도착 역 출구로 맞춘다
  //    (start/end_station_name → startStationExit/stationExit)
  // light: true — 아직 선택 안 된 후보 경로 단계라 GPS 안내용 waypoints는
  // 필요 없다(거리/시간/경사 zone만 있으면 목록·미리보기 지도에 충분). 실제로
  // 이 경로를 선택해 안내를 시작하면 handleStartNavigation에서 선택된 leg만
  // light:false로 다시 조회해 waypoints를 채운다.
  const firstStep = steps[0];
  const lastStep  = steps[steps.length - 1];
  const lastIdx   = steps.length - 1;
  const originStation = stationNameOf(origin.name);
  const destStation   = stationNameOf(destination.name);
  const boardStation  = firstStep?.properties.type === 'SUBWAY' ? firstStep.properties.stops?.[0]?.name : undefined;
  const alightStops   = lastStep?.properties.type === 'SUBWAY' ? lastStep.properties.stops : undefined;
  const alightStation = alightStops?.[alightStops.length - 1]?.name;
  const originIsBoard = sameStation(originStation, boardStation);
  const destIsAlight  = sameStation(destStation, alightStation);

  const rideBefore = (i: number) => steps.slice(0, i).reverse().find(s => s.properties.type !== 'WALKING');
  const rideAfter  = (i: number) => steps.slice(i + 1).find(s => s.properties.type !== 'WALKING');
  const lastPointOf  = (s?: KakaoTransitStep) => s?.path?.points?.[s.path.points.length - 1];
  const originRef = origin.lat && origin.lng ? { lat: Number(origin.lat), lon: Number(origin.lng) } : null;
  const destRef   = destination.lat && destination.lng ? { lat: Number(destination.lat), lon: Number(destination.lng) } : null;
  const toRef = (p?: [number, number]) => (p ? { lat: p[1], lon: p[0] } : null);

  // SUBWAY 스텝 인덱스 → 그 스텝의 승차역(들어가는) / 하차역(나오는) 출구.
  // 출구 기준점은 그 역으로 오는 쪽(출발지·직전 정류장) / 가는 쪽(목적지·다음 정류장).
  const boardExitPs  = new Map<number, Promise<SubwayBestExit | null>>();
  const alightExitPs = new Map<number, Promise<SubwayBestExit | null>>();
  steps.forEach((step, i) => {
    if (step.properties.type !== 'SUBWAY') return;
    const stops = step.properties.stops ?? [];
    if (rideBefore(i)?.properties.type !== 'SUBWAY') {
      const prev = steps[i - 1];
      const ref = i === 0 ? originRef
        : toRef(prev?.properties.type === 'WALKING' ? prev.path?.points?.[0] : lastPointOf(prev));
      if (stops[0]?.name && ref) {
        boardExitPs.set(i, computeSubwayExit(stops[0].name, apiUserType, ref.lat, ref.lon, 'entering', subwayCache));
      }
    }
    if (rideAfter(i)?.properties.type !== 'SUBWAY') {
      const next = steps[i + 1];
      const ref = i === lastIdx ? destRef
        : toRef(next?.properties.type === 'WALKING' ? lastPointOf(next) : next?.path?.points?.[0]);
      const name = stops[stops.length - 1]?.name;
      if (name && ref) {
        alightExitPs.set(i, computeSubwayExit(name, apiUserType, ref.lat, ref.lon, 'exiting', subwayCache));
      }
    }
  });
  const noExit: Promise<SubwayBestExit | null> = Promise.resolve(null);
  const boardExitP  = boardExitPs.get(0) ?? noExit;
  const alightExitP = alightExitPs.get(lastIdx) ?? noExit;

  const boardExits  = new Map<number, SubwayBestExit | null>();
  const alightExits = new Map<number, SubwayBestExit | null>();
  boardExitPs.forEach((p, i) => walkTasks.push(p.then(ex => { boardExits.set(i, ex); })));
  alightExitPs.forEach((p, i) => walkTasks.push(p.then(ex => { alightExits.set(i, ex); })));

  let boardChargers: StationCharger[] | null = null;
  let alightChargers: StationCharger[] | null = null;
  if (apiUserType === 'electric_wheelchair') {
    if (boardStation) {
      walkTasks.push(computeStationChargers(boardStation, chargerCache).then(c => { boardChargers = c; }));
    }
    if (alightStation) {
      walkTasks.push(computeStationChargers(alightStation, chargerCache).then(c => { alightChargers = c; }));
    }
  }

  if (firstPoint && origin.lat && origin.lng) {
    walkTasks.push((async () => {
      const ex = await boardExitP;
      // 첫 탑승이 지하철이면 그 역 출구까지, 아니면(버스) 승차 지점까지.
      // 출발지(역) = 첫 탑승역이어도 출발 칸·안내용으로 역 → 출구 도보는 계산한다(지도엔 안 그림).
      const [tLat, tLng] = ex ? [String(ex.lat), String(ex.lon)] : [String(firstPoint[1]), String(firstPoint[0])];
      preWalkLeg = await computeWalkLeg(origin.lat!, origin.lng!, tLat, tLng,
        apiUserType, fetchLeg, legCache, true, undefined, originIsBoard ? undefined : originStation);
    })());
  }
  if (lastPoint && destination.lat && destination.lng) {
    walkTasks.push((async () => {
      const ex = await alightExitP;
      if (destIsAlight) {
        // 도착지(역) = 마지막 하차역: 도착 칸·안내용으로 하차 지점 → 그 역의 나오는 출구 도보
        // (지도엔 안 그림). 출구를 못 찾으면 목적지 좌표까지.
        const [tLat, tLng] = ex ? [String(ex.lat), String(ex.lon)] : [destination.lat!, destination.lng!];
        postWalkLeg = await computeWalkLeg(String(lastPoint[1]), String(lastPoint[0]), tLat, tLng, apiUserType, fetchLeg, legCache, true);
        return;
      }
      // 마지막 하차가 지하철이면 그 역 출구에서, 아니면(버스) 하차 지점에서.
      const [fLat, fLng] = ex ? [String(ex.lat), String(ex.lon)] : [String(lastPoint[1]), String(lastPoint[0])];
      postWalkLeg = await computeWalkLeg(fLat, fLng, destination.lat!, destination.lng!,
        apiUserType, fetchLeg, legCache, true, destStation);
    })());
  }

  // 카카오가 준 환승/역 도보 스텝(승하차 지점과 무관한, 경로 중간의 WALKING
  // 스텝) — 소요시간·경사 유의사항을 CCH로 재계산해 덮어쓴다. 실제 GPS 내비게이션
  // 화면까지 만들지는 않는다(대부분 100~300m의 역 구내/인근 이동). 버스↔지하철
  // 환승이면 카카오의 일반 출구 대신 보행약자용 출구까지로 다시 계산해 지도에도
  // 그 경로를 그린다.
  const midWalks = new Map<number, { leg: WalkLeg; from: MapCoordinate; to: MapCoordinate }>();
  // 지하철 → 지하철 환승 도보는 역 안(지하) 이동 — 거리 도보로 재계산하지 않고 카카오
  // 시간을 그대로 쓰며, 지도에선 점선으로 그린다(지상 도보만 경사도색 실선).
  const isInStationTransfer = (i: number) =>
    steps[i]?.properties.type === 'WALKING'
    && steps[i - 1]?.properties.type === 'SUBWAY'
    && steps[i + 1]?.properties.type === 'SUBWAY';
  steps.forEach((step, i) => {
    if (step.properties.type !== 'WALKING') return;
    if (isInStationTransfer(i)) return;
    const pts = step.path?.points;
    if (!pts || pts.length < 2) return;
    const toExitP   = steps[i + 1]?.properties.type === 'SUBWAY' ? boardExitPs.get(i + 1) : undefined;
    const fromExitP = steps[i - 1]?.properties.type === 'SUBWAY' ? alightExitPs.get(i - 1) : undefined;
    walkTasks.push((async () => {
      const [toEx, fromEx] = await Promise.all([toExitP ?? noExit, fromExitP ?? noExit]);
      const [sLng, sLat] = fromEx ? [fromEx.lon, fromEx.lat] : pts[0];
      const [eLng, eLat] = toEx ? [toEx.lon, toEx.lat] : pts[pts.length - 1];
      // 이 중간 환승 도보 스텝은 표시용 시간·거리 텍스트로만 쓰이고 별도 GPS
      // 안내 화면을 만들지 않으므로 항상 light 조회로 충분하다.
      const leg = await computeWalkLeg(String(sLat), String(sLng), String(eLat), String(eLng), apiUserType, fetchLeg, legCache, true);
      applyCchWalkLeg(uiSteps[i], segments[i], leg);
      const ex = toEx ?? fromEx;
      if (ex) {
        midWalks.set(i, {
          leg,
          from: { latitude: Number(sLat), longitude: Number(sLng) },
          to:   { latitude: Number(eLat), longitude: Number(eLng) },
        });
        uiSteps[i].title = withExitNo(uiSteps[i].title, ex.exit_no);
      }
    })());
  });

  await Promise.all(walkTasks);

  // 출구 문구 — 한 지하철 스텝이 승차·하차 출구를 둘 다 가질 수 있어(지하철 한 번만
  // 타는 경로 등) 비동기로 따로 덮어쓰지 않고 여기서 순서대로(들어감 → 나옴) 모은다.
  // 답사 하드코딩보다 우선하고, 충전기 정보는 그 뒤에 붙인다.
  steps.forEach((_, i) => {
    const rows = [boardExits.get(i), alightExits.get(i)]
      .filter((ex): ex is SubwayBestExit => !!ex)
      .map(bestExitRow);
    if (rows.length > 0) uiSteps[i].accessibility = rows;
  });
  if (boardChargers) applyChargerInfo(uiSteps[0], boardChargers);
  if (alightChargers) applyChargerInfo(uiSteps[lastIdx], alightChargers);
  const boardExit  = boardExits.get(0) ?? null;
  const alightExit = alightExits.get(lastIdx) ?? null;

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

  const pushWalk = (leg: WalkLeg | null, from: MapCoordinate, to: MapCoordinate) => {
    const segs = walkLegToMapSegments(leg);
    if (segs.length > 0) mapSegments.push(...segs);
    else mapSegments.push({ coordinates: [from, to], color: C.walk });
  };

  // 출구 ↔ 역 연결선(역 안 이동). 출구에 핀이 이미 있으면(출발/도착 = 그 역) 라벨은 생략.
  const exitCoord = (ex: SubwayBestExit): MapCoordinate => ({ latitude: Number(ex.lat), longitude: Number(ex.lon) });
  const ptCoord = (p: [number, number]): MapCoordinate => ({ latitude: p[1], longitude: p[0] });
  const pushConnector = (from: MapCoordinate, to: MapCoordinate, ex: SubwayBestExit, pinned: boolean) => {
    mapSegments.push({
      coordinates: [from, to],
      color: C.exitConnector,
      dashed: true,
      ...(pinned ? {} : { label: `${ex.exit_no}번 출구`, labelPoint: exitCoord(ex) }),
    });
  };
  // 출발역 = 첫 탑승역 / 도착역 = 마지막 하차역이면 지도엔 역 ↔ 출구 거리 도보를 그리지 않고
  // (점선과 겹쳐 되돌아가는 모양이 됨) 핀을 출구에 찍는다. 출발·도착 칸과 안내는 그대로.
  const startPinnedAtExit = originIsBoard && !!boardExit;
  const endPinnedAtExit   = destIsAlight && !!alightExit;

  if (preWalkLeg && !startPinnedAtExit && origin.lat && origin.lng && firstPoint) {
    const to = boardExit ? exitCoord(boardExit) : ptCoord(firstPoint);
    pushWalk(preWalkLeg, { latitude: Number(origin.lat), longitude: Number(origin.lng) }, to);
  }

  steps.forEach((step, i) => {
    const pts = step.path?.points;
    if (!pts || pts.length < 2) return;
    const coords = pointsToCoordinates(pts);
    if (step.properties.type === 'WALKING') {
      const mid = midWalks.get(i);
      if (isInStationTransfer(i)) mapSegments.push({ coordinates: coords, color: C.exitConnector, dashed: true });
      else if (mid) pushWalk(mid.leg, mid.from, mid.to);
      else mapSegments.push({ coordinates: coords, color: C.walk });
    } else if (step.properties.type === 'BUS') {
      const vehicle = step.properties.vehicles?.[0];
      const busNo = vehicle?.name;
      // 노선유형색(간선/지선/순환/광역/마을)으로 지하철 호선색과 대칭되게 칠한다.
      // 저상 여부는 "이번에 오는 차" 기준이라 노선 단위 선 색으론 표현하지 않고
      // 실시간 배지(BusArrivalBadge, is_lowfloor)로만 보여준다.
      mapSegments.push({ coordinates: coords, color: busTypeColor(busNo) });
    } else {
      const inEx = boardExits.get(i);
      if (inEx) pushConnector(exitCoord(inEx), ptCoord(pts[0]), inEx, i === 0 && startPinnedAtExit);
      const vehicle = step.properties.vehicles?.[0];
      mapSegments.push({ coordinates: coords, color: subwayLineColor(vehicle?.name) || C.transitLineSubway });
      const outEx = alightExits.get(i);
      if (outEx) pushConnector(ptCoord(pts[pts.length - 1]), exitCoord(outEx), outEx, i === lastIdx && endPinnedAtExit);
    }
  });

  if (postWalkLeg && !endPinnedAtExit && destination.lat && destination.lng && lastPoint) {
    const from = alightExit ? exitCoord(alightExit) : ptCoord(lastPoint);
    pushWalk(postWalkLeg, from, { latitude: Number(destination.lat), longitude: Number(destination.lng) });
  }

  // 출발/도착이 역이면 그 출구를 출발 칸·도착 칸에 항상 보이게 표시한다.
  const destExit: ExitInfo | null = destIsAlight
    ? bestExitToInfo(alightExit)
    : ((postWalkLeg as WalkLeg | null)?.serverRoute?.stationExit ?? null);
  const startExit: ExitInfo | null = originIsBoard
    ? bestExitToInfo(boardExit)
    : ((preWalkLeg as WalkLeg | null)?.serverRoute?.startStationExit ?? null);

  // 마지막 카카오 스텝이 목적지 도착으로 잘못 표시되지 않도록,
  // 도보 구간이 뒤에 붙으면 isDestination 플래그를 옮긴다.
  if (postWalkLeg && uiSteps.length > 0) {
    uiSteps[uiSteps.length - 1].isDestination = false;
  }

  if (preWalkLeg) {
    const preStep: any = makeWalkStep('walk-pre', preWalkLeg, `${origin.name ?? '출발지'}에서 승차 지점까지 이동`, false);
    // 출발역 = 첫 탑승역이면 같은 출구 문구가 지하철 칸에 이미 있으므로 출발 칸엔 붙이지 않는다.
    if (startExit?.message && !originIsBoard) preStep.accessibility = [exitAccessRow(startExit)];
    uiSteps.unshift(preStep);
    segments.unshift(makeWalkSegment(preWalkLeg));
  }
  if (postWalkLeg) {
    const destStep: any = makeWalkStep('walk-post', postWalkLeg, `${destination.name ?? '목적지'} 도착`, true);
    // 도착역 = 마지막 하차역이면 같은 출구 문구가 지하철 칸에 이미 있으므로 도착 칸엔 붙이지 않는다.
    if (destExit?.message && !destIsAlight) destStep.accessibility = [exitAccessRow(destExit)];
    uiSteps.push(destStep);
    segments.push(makeWalkSegment(postWalkLeg));
  }

  // 노선번호/버스번호가 있으면 라벨에 반영 — segments를 그 자리에서 보강해서
  // 경로 목록 카드(segmentLegend)와 안내 화면 스테퍼(journeySteps) 둘 다
  // 같은 개선된 라벨을 쓰게 한다. segments/uiSteps는 항상 같은 순서로
  // unshift/push되므로 인덱스가 계속 맞는다.
  segments.forEach((seg: any, i: number) => {
    const step: any = uiSteps[i];
    if (seg.type === 'subway' && step?.lineNo) {
      seg.label = `${lineLabel(step.lineNo)} ${formatMinutes(seg.duration)}`;
      // 경로 카드의 구간 막대·범례 점도 호선 색으로(지하철끼리 같은 색으로 뭉치지 않게)
      if (step.lineColor) seg.color = step.lineColor;
    }
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
  const ridingGuidance = steps.map(s => s.properties.type === 'WALKING' ? dedupeStationPrefix(s.properties.guidance) : s.properties.guidance);

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
    accessNote: destExitNote(destExit, startExit),
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
    // 목적지가 역일 때 안내 화면 상단에 띄울 출구 문구
    stationExitMessage: destExit?.message as string | undefined,
    startExitMessage: startExit?.message as string | undefined,
    // 지도 출발/도착 라벨 — 역이면 "숙대입구역 10번 출구"
    startExitLabel: startExit ? `${startExit.station} ${startExit.exitNo}번 출구` : undefined,
    originIsBoard,
    destIsAlight,
    // 출발/도착 = 그 역: 지도에서 출구 ↔ 역은 점선으로만 보이므로 안내 화면에서도
    // 역 ↔ 출구 도보를 GPS 안내 구간(굵은 실선)으로 띄우지 않는다.
    startPinnedAtExit,
    endPinnedAtExit,
    endExitLabel: destExit ? `${destExit.station} ${destExit.exitNo}번 출구` : undefined,
    // 미리보기 지도용 — 도보(경사도 zone 색)/탑승(노선 색) 구간별 색상 폴리라인
    mapSegments,
    // NavigationScreen 상단 여정 스테퍼용 — 전체 여정 요약
    journeySteps,
    // 지도 표시용: 각 스텝의 실제 좌표 경로 (도보 구간은 아직 직선; 지도에서 폴리라인으로 사용)
    mapPath: {
      // 출발역 = 첫 탑승역: 출구 → 역 점선이 여정의 시작이라 출발 핀이 출구에 찍힌다
      preWalk: startPinnedAtExit && boardExit && firstPoint
        ? [[Number(boardExit.lon), Number(boardExit.lat)], firstPoint]
        : (preWalkLeg as WalkLeg | null)?.serverRoute?.coordinates?.length
        ? (preWalkLeg as WalkLeg | null)!.serverRoute.coordinates
        : preWalkLeg && origin.lat && origin.lng && firstPoint
        ? [[Number(origin.lng), Number(origin.lat)], firstPoint]
        : null,
      transit: steps.flatMap(s => s.path?.points ?? []),
      postWalk: endPinnedAtExit && alightExit && lastPoint
        ? [lastPoint, [Number(alightExit.lon), Number(alightExit.lat)]]
        : (postWalkLeg as WalkLeg | null)?.serverRoute?.coordinates?.length
        ? (postWalkLeg as WalkLeg | null)!.serverRoute.coordinates
        : postWalkLeg && destination.lat && destination.lng && lastPoint
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
                    <Text style={ss.lineBadgeText}>{lineLabel(step.lineNo)}</Text>
                  </View>
                )}
                {step.busNo && (
                  <View style={[ss.busBadge, { backgroundColor: C.bus }]}>
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
              {step.type === 'bus' && step.busNo && (
                <BusArrivalBadge routeName={step.busNo} stopName={step.stops?.[0]} />
              )}
              {step.type === 'subway' && step.lineNo && step.stops?.[0] && (
                <SubwayArrivalBadge station={step.stops[0]} lineNo={step.lineNo} />
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
        {/* 보행약자용 출구 안내는 접지 않고 항상 보여준다 */}
        {step.accessibility?.some((a: any) => a.exit) && (
          <View style={ss.stepExpanded}>
            {step.accessibility.filter((a: any) => a.exit).map((a: any, i: number) => <AccessRow key={`x${i}`} item={a} />)}
          </View>
        )}
        {expanded && (
          <View style={ss.stepExpanded}>
            {step.detail && (
              <View style={ss.detailBox}>
                <Text style={ss.detailIcon}>💡</Text>
                <Text style={ss.detailText}>{step.detail}</Text>
              </View>
            )}
            {step.accessibility?.filter((a: any) => !a.exit).map((a: any, i: number) => <AccessRow key={i} item={a} />)}
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
  // 지도 위 출발/도착 라벨 전용 — startName/endName(검색창 입력, 즉시 바뀜)과 분리해서
  // 실제 경로 데이터(routes)가 갱신될 때만 같이 바뀌게 한다. 그래야 재검색 중
  // "지도는 그대로인데 이름표만 먼저 바뀌는" 어색한 과도상태가 안 생긴다.
  mapStartLabel: string;
  mapEndLabel: string;
  // 도보 구간 경로 종류 토글 — 초기 화면은 항상 유형별. 최단/맞춤형은 초기 화면 직후
  // 백그라운드로 미리 계산해 두고(종류별 캐시), 끝나기 전에 누르면 kindLoading.
  routeKind: WalkRouteKind;
  selectRouteKind: (kind: WalkRouteKind) => void;
  kindLoading: boolean;
  // 맞춤형 사용 가능 여부 — null=아직 모름(계산 중), false 면 reason 표시·토글 비활성.
  personalInfo: { available: boolean | null; reason?: string };
};

type TransitKindContext = {
  gen: number;
  kakao: KakaoTransitRoute[];
  apiUserType: string;
  origin: { lat?: string; lng?: string; name?: string };
  destination: { lat?: string; lng?: string; name?: string };
  subwayCache: SubwayExitCache;
  chargerCache: ChargerCache;
  typeRoutes: any[];
  kinds: Map<WalkRouteKind, Promise<any[]>>;
};

const PERSONAL_LOGIN_REASON = '로그인하면 내 이동 기록을 반영한 맞춤 경로를 볼 수 있어요.';

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
  const [mapStartLabel, setMapStartLabel] = useState('');
  const [mapEndLabel, setMapEndLabel] = useState('');
  const [routeKind, setRouteKind] = useState<WalkRouteKind>('type');
  const [kindLoading, setKindLoading] = useState(false);
  const [personalInfo, setPersonalInfoState] = useState<{ available: boolean | null; reason?: string }>({ available: null });
  const personalInfoRef = useRef(personalInfo);
  const setPersonalInfo = (v: { available: boolean | null; reason?: string }) => {
    personalInfoRef.current = v;
    setPersonalInfoState(v);
  };
  // 검색이 새로 시작될 때마다 gen 이 올라가 이전 검색의 늦은 응답을 버린다.
  const genRef = useRef(0);
  const kindRef = useRef<WalkRouteKind>('type');
  const ctxRef = useRef<TransitKindContext | null>(null);

  // 종류별 후보 경로 계산(종류당 1회, 결과 promise 캐시). 출구/충전기 조회 캐시는
  // 유형별 계산 때 채운 것을 그대로 재사용하므로(승강기 출구 로직 동일), 새로
  // 나가는 요청은 도보 구간 묶음(/route/legs)뿐이다.
  const ensureKind = (kind: WalkRouteKind): Promise<any[]> => {
    const ctx = ctxRef.current;
    if (!ctx) return Promise.reject(new Error('no transit context'));
    if (kind === 'type') return Promise.resolve(ctx.typeRoutes);
    const hit = ctx.kinds.get(kind);
    if (hit) return hit;
    const onMeta = kind === 'personal'
      ? (m: WalkLegsMeta) => {
          if (genRef.current !== ctx.gen) return;
          setPersonalInfo(m.personalized ? { available: true } : { available: false, reason: m.reason });
        }
      : undefined;
    const fetchLeg = batchLegFetcher(ctx.apiUserType, kind, onMeta);
    const legCache: LegCache = new Map();
    const promise = Promise.all(
      ctx.kakao.map((r, i) =>
        convertKakaoRoute(r, i, ctx.apiUserType, ctx.origin, ctx.destination,
          fetchLeg, legCache, ctx.subwayCache, ctx.chargerCache)
      )
    );
    ctx.kinds.set(kind, promise);
    promise.catch(() => { ctx.kinds.delete(kind); });
    return promise;
  };

  const selectRouteKind = (kind: WalkRouteKind) => {
    const ctx = ctxRef.current;
    if (!ctx || kind === kindRef.current) return;
    if (kind === 'personal' && personalInfoRef.current.available === false) return;
    kindRef.current = kind;
    setRouteKind(kind);
    if (kind === 'type') {
      setKindLoading(false);
      setRoutes(ctx.typeRoutes);
      return;
    }
    setKindLoading(true);
    ensureKind(kind)
      .then((next) => {
        if (genRef.current !== ctx.gen || kindRef.current !== kind) return;
        // 맞춤형이 fallback(데이터 부족 등)이면 결과가 유형별과 같으므로 보여주지 않고 되돌린다.
        if (kind === 'personal' && personalInfoRef.current.available === false) {
          kindRef.current = 'type';
          setRouteKind('type');
          setRoutes(ctx.typeRoutes);
          return;
        }
        setRoutes(next);
      })
      .catch(() => {
        if (genRef.current !== ctx.gen || kindRef.current !== kind) return;
        kindRef.current = 'type';
        setRouteKind('type');
        setRoutes(ctx.typeRoutes);
      })
      .finally(() => {
        // 그 사이 다른 종류(아직 계산 중)로 바꿨으면 그쪽 로딩 표시는 건드리지 않는다.
        const current = kindRef.current;
        if (genRef.current === ctx.gen && (current === kind || current === 'type')) setKindLoading(false);
      });
  };

  useEffect(() => {
    let cancelled = false;
    const gen = ++genRef.current;
    kindRef.current = 'type';
    ctxRef.current = null;
    setRouteKind('type');
    setKindLoading(false);
    setPersonalInfo({ available: null });

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
        const chargerCache: ChargerCache = new Map();
        const origin = { lat: startLatitude, lng: startLongitude, name: startName };
        const destination = { lat: endLatitude, lng: endLongitude, name: endName };
        const converted = await Promise.all(
          kakaoRoutes.map((r, i) =>
            convertKakaoRoute(
              r, i, apiUserType,
              origin,
              destination,
              singleLegFetcher(apiUserType, limit),
              legCache,
              subwayCache,
              chargerCache,
            )
          )
        );

        if (cancelled) return;
        ctxRef.current = {
          gen, kakao: kakaoRoutes, apiUserType, origin, destination,
          subwayCache, chargerCache, typeRoutes: converted, kinds: new Map(),
        };
        // 미리 계산(백그라운드) — 초기 화면(유형별)을 먼저 띄운 뒤 시작해 첫 화면을
        // 늦추지 않는다. 맞춤형은 로그인 사용자만(비로그인은 바로 비활성 + 사유).
        setTimeout(() => {
          if (genRef.current !== gen) return;
          ensureKind('distance').catch(() => {});
          getAuthToken().catch(() => null).then((token) => {
            if (genRef.current !== gen) return;
            if (!token) {
              setPersonalInfo({ available: false, reason: PERSONAL_LOGIN_REASON });
              return;
            }
            ensureKind('personal').catch(() => {});
          });
        }, 0);
        setRoutes(converted);
        setSelectedRoute(converted[0]?.id ?? '');
        setMapStartLabel(startName || '');
        setMapEndLabel(endName || '');
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

  return {
    routes, loading, errorMessage, selectedRoute, setSelectedRoute, mapStartLabel, mapEndLabel,
    routeKind, selectRouteKind, kindLoading, personalInfo,
  };
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
  const {
    routes, loading, errorMessage, selectedRoute, setSelectedRoute, mapStartLabel, mapEndLabel,
    routeKind, selectRouteKind, kindLoading, personalInfo,
  } = transitState;
  // 비활성 맞춤형 칩을 눌렀을 때만 사유 한 줄을 보여준다.
  const [showPersonalHint, setShowPersonalHint] = useState(false);
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

  const filterRoutes = (list: any[], filter: string) => list.filter(r => {
    const types = r.segments.map((s: any) => s.type);
    const hasBus    = types.some((t: string) => t === 'bus' || t === 'lowfloor');
    const hasSubway = types.includes('subway');
    if (filter === 'bus')    return hasBus && !hasSubway;
    if (filter === 'subway') return hasSubway && !hasBus;
    if (filter === 'mixed')  return hasBus && hasSubway;
    return true;
  });

  const filteredRoutes = filterRoutes(routes, activeFilter);

  // 카테고리(전체/버스/지하철/버스+지하철) 탭을 누르면, 필터링만 하고 선택은
  // 그대로 두던 예전 방식 대신 — 그 필터로 걸러진 목록의 1위 경로로 지도/선택을
  // 즉시 맞춘다(선택돼있던 경로가 필터에서 빠져도 지도가 안 따라오는 문제 방지).
  const applyFilter = (key: string) => {
    setActiveFilter(key);
    const next = filterRoutes(routes, key);
    setSelectedRoute(next[0]?.id ?? '');
  };

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
    // currentRoute.id는 "r0","r1"... 인덱스 기반이라 재검색해도 1위 후보 id가
    // 그대로 "r0"인 경우가 많다 — id만 의존성으로 두면 좌표가 바뀐 새 경로인데도
    // 지도가 재계산을 안 해서 이전 경로가 그대로 남아있는 버그가 있었다. routes가
    // 새로 fetch될 때마다 배열/객체가 통째로 새로 만들어지므로, currentRoute
    // 객체 자체를 의존성으로 둬서 내용이 바뀌면 항상 다시 그리게 한다.
    [currentRoute]
  );

  // 실제 경사도 엔진(coordinates/routeSegments)을 NavigationScreen에 그대로 넘겨서
  // 승차 전/하차 후 도보 구간을 우리가 설계한 GPS+경사도 안내로 진행시킨다.
  // 연타 방지 — 짧은 시간에 두 번 눌리면 NavigationScreen이 중복으로 push되어
  // GPS 구독·안내 상태가 겹치고, 리스트 렌더에서 key 충돌 경고까지 발생한다.
  const navigatingRef = useRef(false);

  const handleStartNavigation = async () => {
    // 토글 계산 중엔 목록(currentRoute)은 이전 종류, routeKind 는 새 종류라 안내 경로가
    // 섞인다 — 계산이 끝날 때까지 시작하지 않는다(버튼도 비활성).
    if (!currentRoute || navigatingRef.current || kindLoading) return;
    navigatingRef.current = true;
    setTimeout(() => { navigatingRef.current = false; }, 1500);

    // 후보 목록 단계에서는 light:true로 조회해서 이 도보 구간들에 GPS 회전
    // 안내(waypoints)가 비어 있다 — 실제로 안내를 시작하는 지금, 사용자가
    // 고른 이 경로의 pre/post walk 구간 딱 2개만 light:false로 다시 조회해
    // 채운다(실패해도 좌표/경사 데이터는 이미 있으니 안내 자체는 진행).
    const apiUserType = walkerType || 'manual_wheelchair';
    let preWalkRoute  = currentRoute.preWalkRoute;
    let postWalkRoute = currentRoute.postWalkRoute;
    // 목록에서 보던 경로 종류(유형별/최단/맞춤형) 그대로 full 조회해야 안내 경로가
    // 카드와 같다.
    const fullFetch = singleLegFetcher(apiUserType, createLimiter(2), routeKind);
    const refetchTasks: Promise<void>[] = [];

    if (preWalkRoute && startLatitude && startLongitude) {
      const boardPt = preWalkRoute.coordinates?.[preWalkRoute.coordinates.length - 1];
      if (boardPt) {
        refetchTasks.push(
          computeWalkLegUncached(
            startLatitude, startLongitude, String(boardPt[1]), String(boardPt[0]),
            apiUserType, fullFetch, false, undefined,
            currentRoute.startExitMessage && !currentRoute.originIsBoard ? stationNameOf(startName) : undefined,
          ).then(leg => { if (leg.serverRoute) preWalkRoute = leg.serverRoute; })
        );
      }
    }
    if (postWalkRoute && endLatitude && endLongitude) {
      const alightPt = postWalkRoute.coordinates?.[0];
      if (alightPt) {
        refetchTasks.push(
          computeWalkLegUncached(
            String(alightPt[1]), String(alightPt[0]),
            ...(currentRoute.destIsAlight && postWalkRoute.coordinates?.length
              ? [String(postWalkRoute.coordinates[postWalkRoute.coordinates.length - 1][1]),
                 String(postWalkRoute.coordinates[postWalkRoute.coordinates.length - 1][0])] as [string, string]
              : [endLatitude, endLongitude] as [string, string]),
            apiUserType, fullFetch, false,
            currentRoute.destIsAlight ? undefined : stationNameOf(endName),
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
      measurement_units: r.measurement_units,
    });

    // 출발지가 승차 지점과 (좌표상) 사실상 같은 지점일 때만 걸러낸다 — 20m
    // 기준이었을 때는 정상적인 짧은 도보 구간(승강장 진입 등)까지 안내가
    // 통째로 생략되는 부작용이 있었다. 진짜 같은 지점(역 정문 검색 등)일
    // 때만, 즉 출발/도착 마커가 겹쳐서 화면이 의미 없어지는 경우만 거른다.
    const MIN_WALK_LEG_M = 5;
    const hasRealPreWalk  = !!currentRoute.preWalkRoute  && (currentRoute.preWalkDistanceM  ?? 0) >= MIN_WALK_LEG_M
      && !currentRoute.startPinnedAtExit;
    const hasRealPostWalk = !!currentRoute.postWalkRoute && (currentRoute.postWalkDistanceM ?? 0) >= MIN_WALK_LEG_M
      && !currentRoute.endPinnedAtExit;
    // 도보 안내 구간을 건너뛰면 그 출구 문구는 탑승 안내 알림에 함께 띄운다.
    const alertLines = [
      currentRoute.startExitMessage,
      ...(currentRoute.ridingGuidance ?? []),
      ...(hasRealPostWalk ? [] : [currentRoute.stationExitMessage]),
    ].filter(Boolean);

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
      ...(currentRoute.stationExitMessage ? { stationExitMessage: currentRoute.stationExitMessage } : {}),
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
      ...(currentRoute.startExitMessage ? { startExitMessage: currentRoute.startExitMessage } : {}),
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
      // 출발역 = 첫 탑승역이면 승차 전 도보가 없으니, 들어갈 출구 안내를 탑승 안내 앞에 붙인다.
      if (currentRoute.ridingGuidance?.length) {
        Alert.alert('탑승 안내', alertLines.join('\n'));
      }
      navigation?.navigate('Navigation', postWalkParams);
    } else {
      // 도보 구간 자체가 없는 경로(버스/지하철만) — 안내할 도보 구간이 없어 스텁 이동.
      // 그래도 탑승 안내(몇 호선/몇 번 버스 타고 어디서 내리는지)는 놓치면 안 되니 알림으로.
      if (currentRoute.ridingGuidance?.length) {
        Alert.alert('탑승 안내', alertLines.join('\n'));
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
              onPress={() => applyFilter(f.key)}
            >
              <Text style={[ss.filterTabText, activeFilter === f.key && ss.filterTabTextActive]}>
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <RouteMapView
        routes={mapRoutes}
        selectedRouteId={currentRoute?.id ?? ''}
        startLabel={currentRoute?.startExitLabel || mapStartLabel || startName}
        endLabel={currentRoute?.endExitLabel || mapEndLabel || endName}
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
            {view === 'routes' && !loading && !errorMessage && (
              <View style={ss.kindToggle}>
                {WALK_KIND_TABS.map((k) => {
                  const disabled = k.key === 'personal' && personalInfo.available === false;
                  const active = routeKind === k.key;
                  return (
                    <TouchableOpacity
                      key={k.key}
                      style={[ss.kindChip, active && ss.kindChipActive, disabled && ss.kindChipDisabled]}
                      activeOpacity={0.8}
                      onPress={() => {
                        if (disabled) { setShowPersonalHint((v) => !v); return; }
                        setShowPersonalHint(false);
                        selectRouteKind(k.key);
                      }}
                    >
                      <Text style={[ss.kindChipText, active && ss.kindChipTextActive, disabled && ss.kindChipTextDisabled]}>
                        {k.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
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

        {view === 'routes' && !loading && !errorMessage && showPersonalHint && personalInfo.available === false && (
          <Text style={ss.kindHint}>{personalInfo.reason ?? '맞춤 경로를 아직 사용할 수 없어요.'}</Text>
        )}

        {view === 'routes' && !loading && !errorMessage && kindLoading && (
          <View style={ss.kindLoadingRow}>
            <ActivityIndicator size="small" color={C.primary} />
            <Text style={ss.kindLoadingText}>
              {WALK_KIND_TABS.find((k) => k.key === routeKind)?.label} 기준으로 도보 구간을 계산하는 중...
            </Text>
          </View>
        )}

        {view === 'routes' && !loading && !errorMessage && (
          <ScrollView
            style={[ss.sheetScroll, kindLoading && { opacity: 0.4 }]}
            contentContainerStyle={ss.sheetScrollContent}
            showsVerticalScrollIndicator={false}
          >
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
          style={[ss.startBtn, { backgroundColor: C.subway }, kindLoading && { opacity: 0.5 }]}
          activeOpacity={0.85}
          disabled={kindLoading}
          onPress={handleStartNavigation}
        >
          <Text style={ss.startBtnIcon}>🚌</Text>
          <Text style={ss.startBtnText}>
            {kindLoading ? '도보 구간 계산 중...' : `${currentRoute?.tag} 경로로 대중교통 안내 시작`}
          </Text>
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
  kindToggle: { flexDirection: 'row', gap: 4 },
  kindChip: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12,
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
  },
  kindChipActive: { backgroundColor: C.primary, borderColor: C.primary },
  kindChipDisabled: { opacity: 0.45 },
  kindChipText: { fontSize: 11, color: C.textSub, fontWeight: '600' },
  kindChipTextActive: { color: C.white, fontWeight: '700' },
  kindChipTextDisabled: { color: C.textMute },
  kindHint: { fontSize: 12, color: C.textSub, paddingHorizontal: 16, paddingBottom: 6 },
  kindLoadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  kindLoadingText: { fontSize: 12, color: C.textSub },
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
