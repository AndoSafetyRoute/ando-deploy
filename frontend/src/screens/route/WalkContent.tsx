import React, { useState, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Dimensions,
  Platform,
} from 'react-native';
import { C, ZONE_COLORS } from '../../constants/colors';
import { formatMinutes } from '../../utils/storage';
import RouteMapView from './RouteMapView';
import { useDraggableSheet } from './useDraggableSheet';
import { goToRouteCompareIfEnabled } from '../../personalization/entry';

const { height: H } = Dimensions.get('window');

type Coordinate = {
  latitude: number;
  longitude: number;
};

type ServerRoute = {
  id: string;
  tag: string;
  color: string;
  coordinates?: Coordinate[];
  coordinateCount?: number;
  totalDistance?: number | null;
  totalCost?: number | null;
  avgSlope?: number | null;
  shortestDistance?: number | null;
  detourRatio?: number | null;
  algorithmAlpha?: number | null;
};

type WalkRoute = {
  id: string;
  tag: string;
  tagColor: string;
  color: string;
  time: number;
  distance: string;
  steps: number;
  badges: string[];
  desc: string;
  warning?: string;
  coordinates: Coordinate[];
  totalDistanceM: number | null;
  avgSlope: number | null;
  detourRatio: number | null;
};

type WalkContentProps = {
  navigation: any;
  walkerType?: string;
  from?: string;
  to?: string;
  showSlopeMarkers?: boolean;
  onToggleSlopeMarkers?: () => void;
  routeData?: any;

  startName?: string;
  startAddress?: string;
  startLatitude?: string;
  startLongitude?: string;

  endName?: string;
  endAddress?: string;
  endLatitude?: string;
  endLongitude?: string;
};

const BADGE_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; icon: string }
> = {
  accessible: {
    label: '교통약자 경로',
    color: C.primary,
    bg: C.primaryBg,
    icon: '♿',
  },
  lowSlope: {
    label: '완만한 경로',
    color: C.success,
    bg: '#E8F8F5',
    icon: '🌿',
  },
  noSlope: {
    label: '급경사 회피',
    color: '#9C27B0',
    bg: '#F3E5F5',
    icon: '📐',
  },
  detour: {
    label: '우회 경로',
    color: C.warn,
    bg: '#FFF3E0',
    icon: '↪️',
  },
  shortest: {
    label: '거리 우선',
    color: C.route3,
    bg: '#FFF8E6',
    icon: '📏',
  },
};

function getNumber(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCoordinates(raw: any): Coordinate[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item: any) => {
      if (Array.isArray(item) && item.length >= 2) {
        return {
          latitude: Number(item[1]),
          longitude: Number(item[0]),
        };
      }

      return {
        latitude: Number(item.latitude ?? item.lat ?? item.y),
        longitude: Number(item.longitude ?? item.lon ?? item.lng ?? item.x),
      };
    })
    .filter(
      (coord: Coordinate) =>
        Number.isFinite(coord.latitude) && Number.isFinite(coord.longitude)
    );
}

// 경사도 zone별 색상 구간 — 미리보기 지도에서 도보 경로를 통짜 단색이 아니라
// navigation_segments(coord_start_idx/coord_end_idx) 기준으로 조각조각 색칠한다.
function buildSlopeSegments(coordinates: Coordinate[], navSegments: any): import('./RouteMapView').MapRouteSegment[] {
  if (!Array.isArray(navSegments) || coordinates.length === 0) return [];

  return navSegments
    .map((s: any) => ({
      coordinates: coordinates.slice(s.coord_start_idx ?? 0, (s.coord_end_idx ?? 0) + 1),
      color: ZONE_COLORS[s.zone] ?? ZONE_COLORS.flat,
      slopeMean: s.slope_mean,
      zone: s.zone,
    }))
    .filter((seg) => seg.coordinates.length >= 2);
}

function formatDistance(distanceM: number | null) {
  if (distanceM === null) return '거리 정보 없음';

  if (distanceM >= 1000) {
    return `${(distanceM / 1000).toFixed(1)}km`;
  }

  return `${Math.round(distanceM)}m`;
}

function estimateTimeMinutes(distanceM: number | null) {
  if (distanceM === null) return 0;

  // 보행약자 기준 약 1m/s 가정
  return Math.max(1, Math.round(distanceM / 60));
}

function estimateSteps(distanceM: number | null) {
  if (distanceM === null) return 0;

  // 평균 보폭 약 0.7m 가정
  return Math.round(distanceM / 0.7);
}

function makeBadges(route: ServerRoute) {
  const id = route.id;
  const avgSlope = getNumber(route.avgSlope);
  const detourRatio = getNumber(route.detourRatio);

  const badges: string[] = ['accessible'];

  if (id === 'safe') {
    badges.push('lowSlope');
  }

  if (id === 'shortest') {
    badges.push('shortest');
  }

  if (avgSlope !== null) {
    badges.push('noSlope');
  }

  if (detourRatio !== null && detourRatio > 1.15) {
    badges.push('detour');
  }

  return Array.from(new Set(badges));
}

function makeDescription(route: ServerRoute) {
  const avgSlope = getNumber(route.avgSlope);
  const detourRatio = getNumber(route.detourRatio);

  const parts: string[] = [];

  if (avgSlope !== null) {
    parts.push(`평균 경사도 ${avgSlope.toFixed(2)}%`);
  }

  if (detourRatio !== null) {
    parts.push(`우회율 ${detourRatio.toFixed(2)}배`);
  }

  if (parts.length > 0) {
    return parts.join(' · ');
  }

  if (route.id === 'safe') {
    return '경사 부담을 줄이는 방향으로 탐색한 경로입니다.';
  }

  if (route.id === 'shortest') {
    return '이동 거리를 우선하여 탐색한 경로입니다.';
  }

  return '교통약자 이동 조건을 고려한 추천 경로입니다.';
}

function convertServerRoute(route: ServerRoute): WalkRoute {
  const totalDistanceM = getNumber(route.totalDistance);
  const avgSlope = getNumber(route.avgSlope);
  const detourRatio = getNumber(route.detourRatio);
  const coordinates = normalizeCoordinates(route.coordinates);

  const distance = formatDistance(totalDistanceM);
  const time = estimateTimeMinutes(totalDistanceM);
  const steps = estimateSteps(totalDistanceM);

  return {
    id: route.id,
    tag: route.tag,
    tagColor: route.color || C.primary,
    color: route.color || C.primary,
    time,
    distance,
    steps,
    badges: makeBadges(route),
    desc: makeDescription(route),
    warning:
      coordinates.length === 0
        ? '경로 좌표가 없어 지도에 경로를 표시할 수 없습니다.'
        : undefined,
    coordinates,
    totalDistanceM,
    avgSlope,
    detourRatio,
  };
}

function getRoutesFromRouteData(routeData: any): WalkRoute[] {
  const serverRoutes = routeData?.routes;

  if (!Array.isArray(serverRoutes)) {
    return [];
  }

  return serverRoutes.map(convertServerRoute);
}

const Badge = ({ type }: { type: string }) => {
  const cfg = BADGE_CONFIG[type];

  if (!cfg) return null;

  return (
    <View style={[ss.badge, { backgroundColor: cfg.bg }]}>
      <Text style={ss.badgeIcon}>{cfg.icon}</Text>
      <Text style={[ss.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
};

const StatPill = ({ icon, value }: { icon: string; value: string }) => (
  <View style={ss.statPill}>
    <Text style={ss.statPillIcon}>{icon}</Text>
    <Text style={ss.statPillText}>{value}</Text>
  </View>
);

const RouteCard = ({
  route,
  selected,
  onSelect,
}: {
  route: WalkRoute;
  selected: boolean;
  onSelect: (id: string) => void;
}) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePress = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, {
        toValue: 0.97,
        duration: 80,
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnim, {
        toValue: 1,
        duration: 80,
        useNativeDriver: true,
      }),
    ]).start();

    onSelect(route.id);
  };

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={handlePress}
        style={[
          ss.routeCard,
          selected && {
            borderColor: route.color,
            borderWidth: 2,
          },
        ]}
      >
        <View style={[ss.routeCardBar, { backgroundColor: route.color }]} />

        <View style={ss.routeCardHeader}>
          <View style={[ss.routeTag, { backgroundColor: route.tagColor + '18' }]}>
            <Text style={[ss.routeTagText, { color: route.tagColor }]}>
              {route.tag}
            </Text>
          </View>

          {selected && (
            <View style={ss.selectedBadge}>
              <Text style={ss.selectedBadgeText}>✓ 선택됨</Text>
            </View>
          )}

          <View style={{ flex: 1 }} />

          {route.warning && (
            <View style={ss.warnChip}>
              <Text style={ss.warnChipText}>⚠ 확인 필요</Text>
            </View>
          )}
        </View>

        <View style={ss.routeMainRow}>
          <View>
            <View style={ss.timeRow}>
              <Text style={[ss.routeTime, { color: route.tagColor }]}>
                {route.time > 0 ? formatMinutes(route.time) : '-'}
              </Text>
            </View>

            <Text style={ss.routeDesc}>{route.desc}</Text>
          </View>

          <View style={ss.routeStats}>
            <StatPill icon="📏" value={route.distance} />
            <StatPill
              icon="👟"
              value={
                route.steps > 0
                  ? `${route.steps.toLocaleString()}걸음`
                  : '걸음 정보 없음'
              }
            />
          </View>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={ss.badgesScroll}
        >
          {route.badges.map((b) => (
            <Badge key={b} type={b} />
          ))}
        </ScrollView>

        {route.warning && (
          <View style={ss.warningBox}>
            <Text style={ss.warningText}>{route.warning}</Text>
          </View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
};

const EmptyRouteCard = () => (
  <View style={ss.emptyCard}>
    <Text style={ss.emptyTitle}>경로 정보를 불러오지 못했습니다</Text>
    <Text style={ss.emptyText}>
      출발지와 도착지를 다시 설정한 뒤 길찾기를 실행해 주세요.
    </Text>
  </View>
);

export default function WalkContent({
  navigation,
  walkerType,
  from = '출발지',
  to = '도착지',
  showSlopeMarkers,
  onToggleSlopeMarkers,
  routeData,
  startName,
  startAddress,
  startLatitude,
  startLongitude,
  endName,
  endAddress,
  endLatitude,
  endLongitude,
}: WalkContentProps) {
  const routes = useMemo(() => getRoutesFromRouteData(routeData), [routeData]);

  const initialRouteId = routes[0]?.id ?? '';
  const [selectedRoute, setSelectedRoute] = useState(initialRouteId);

  const [containerHeight, setContainerHeight] = useState(H);

  const selectedRouteObj =
    routes.find((route) => route.id === selectedRoute) ?? routes[0];

  const selectedRouteId = selectedRouteObj?.id ?? '';

  // 선택된 경로에만 경사도 색상 구간을 붙인다 — routeData 최상위 navigation_segments는
  // BE가 계산한 단일 최적 경로 기준이라 selectedRouteObj와 좌표 배열이 같다.
  const slopeSegments = useMemo(
    () => buildSlopeSegments(selectedRouteObj?.coordinates ?? [], routeData?.navigation_segments),
    [selectedRouteObj, routeData]
  );

  // 매 렌더마다 새 배열을 만들면 RouteMapView의 지도가 계속 재생성되어 깜빡이고
  // 줌 상태가 초기화된다. routes가 실제로 바뀔 때만 새로 만든다.
  const mapRoutes = useMemo(
    () => routes.map((r) => ({
      id: r.id,
      color: r.color,
      coordinates: r.coordinates,
      segments: r.id === selectedRouteId ? slopeSegments : undefined,
    })),
    [routes, selectedRouteId, slopeSegments]
  );

  // 전체 화면 높이(H) 기준으로 잡으면 상단 헤더/카드들 때문에 확대 시 화면 밖으로
  // 넘쳐 "확대가 안 되는" 것처럼 보인다. 실제 렌더된 컨테이너 높이 기준으로, 손잡이를
  // 드래그하면 실시간으로 따라오게 한다.
  const { sheetExpanded, sheetHeight, toggleSheet, panHandlers } = useDraggableSheet(
    containerHeight,
    0.38,
    0.85
  );

  const handleStartNavigation = () => {
    if (!selectedRouteObj) return;

    // ⑬ 3경로 비교 화면이 켜져 있으면(ROUTE_COMPARE_ENABLED) 그쪽으로 보내고 종료.
    // 꺼져 있으면 false 를 돌려주므로 아래 기존 흐름 그대로 (대중교통 도보 무관).
    if (goToRouteCompareIfEnabled(navigation, {
      from, to, walkerType,
      startName, startAddress, startLatitude, startLongitude,
      endName, endAddress, endLatitude, endLongitude,
    })) return;

    navigation?.navigate('Navigation', {
      routeId: selectedRouteObj.id,
      mode: 'walk',
      from,
      to,
      walkerType,

      startName,
      startAddress,
      startLatitude,
      startLongitude,

      endName,
      endAddress,
      endLatitude,
      endLongitude,

      routeData: JSON.stringify({
        ...routeData,
        selectedRouteId: selectedRouteObj.id,
        selectedRouteTag: selectedRouteObj.tag,
        selectedRouteTitle: selectedRouteObj.desc,
        selectedRouteColor: selectedRouteObj.color,
        coordinates: selectedRouteObj.coordinates,

        routeSegments:
          routeData?.routes?.find((r: any) => r.id === selectedRouteObj.id)
            ?.routeSegments ?? [],
        totalDistance: selectedRouteObj.totalDistanceM,
        avgSlope: selectedRouteObj.avgSlope,
        detourRatio: selectedRouteObj.detourRatio,
      }),
    });
  };

  return (
    <View
      style={ss.content}
      onLayout={(e) => setContainerHeight(e.nativeEvent.layout.height)}
    >
      <RouteMapView
        routes={mapRoutes}
        selectedRouteId={selectedRouteId}
        startLabel={from}
        endLabel={to}
        showSlopeMarkers={showSlopeMarkers}
        onToggleSlopeMarkers={onToggleSlopeMarkers}
      />

      <Animated.View style={[ss.bottomSheet, { height: sheetHeight }]}>
        <View style={ss.sheetHandle} {...panHandlers}>
          <View style={ss.sheetHandleBar} />

          <View style={ss.sheetTitleRow}>
            <Text style={ss.sheetTitle}>경로 선택</Text>
            <Text style={ss.sheetSubtitle}>{routes.length}개 경로 안내</Text>
            <View style={{ flex: 1 }} />
            <Text style={ss.sheetExpandIcon}>{sheetExpanded ? '▼' : '▲'}</Text>
          </View>
        </View>

        <ScrollView
          style={ss.sheetScroll}
          contentContainerStyle={ss.sheetScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {routes.length === 0 ? (
            <EmptyRouteCard />
          ) : (
            routes.map((route) => (
              <RouteCard
                key={route.id}
                route={route}
                selected={selectedRouteId === route.id}
                onSelect={setSelectedRoute}
              />
            ))
          )}

          <View style={{ height: 20 }} />
        </ScrollView>
      </Animated.View>

      <View style={ss.startBtnWrap}>
        <TouchableOpacity
          style={[
            ss.startBtn,
            !selectedRouteObj && ss.startBtnDisabled,
          ]}
          activeOpacity={0.85}
          disabled={!selectedRouteObj}
          onPress={handleStartNavigation}
        >
          <Text style={ss.startBtnIcon}>🚶</Text>
          <Text style={ss.startBtnText}>
            {selectedRouteObj
              ? `${selectedRouteObj.tag} 경로로 안내 시작`
              : '경로를 선택할 수 없습니다'}
          </Text>
          <Text style={ss.startBtnArrow}>→</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const ss = StyleSheet.create({
  content: {
    flex: 1,
  },

  mapContainer: {
    flex: 1,
  },

  mapBg: {
    flex: 1,
    backgroundColor: '#E8EBF0',
    position: 'relative',
    overflow: 'hidden',
  },

  mapGridH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(200,204,218,0.5)',
  },

  mapGridV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(200,204,218,0.5)',
  },

  routeLine: {
    position: 'absolute',
    top: '25%',
    left: '15%',
    height: '50%',
    borderRadius: 4,
    transform: [{ rotate: '-20deg' }],
  },

  mapMarker: {
    position: 'absolute',
    alignItems: 'center',
  },

  startMarker: {
    top: '18%',
    left: '18%',
  },

  startMarkerInner: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: C.success,
    borderWidth: 3,
    borderColor: C.white,
    elevation: 4,
  },

  endMarker: {
    bottom: '40%',
    right: '20%',
  },

  endMarkerPin: {
    fontSize: 28,
  },

  markerLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: C.text,
    backgroundColor: C.white,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginTop: 2,
    overflow: 'hidden',
    elevation: 2,
  },

  routeInfoChip: {
    position: 'absolute',
    top: 14,
    left: 14,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.white,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1.5,
    elevation: 4,
    gap: 6,
  },

  routeInfoDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  routeInfoText: {
    fontSize: 13,
    fontWeight: '700',
  },

  mapNoticeChip: {
    position: 'absolute',
    top: 52,
    left: 14,
    backgroundColor: C.white,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    elevation: 3,
  },

  mapNoticeText: {
    fontSize: 12,
    fontWeight: '700',
    color: C.textSub,
  },

  mapControls: {
    position: 'absolute',
    right: 14,
    top: '30%',
    gap: 6,
  },

  mapControlBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: C.white,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },

  mapControlIcon: {
    fontSize: 18,
    color: C.text,
    fontWeight: '600',
  },

  layerBtn: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    backgroundColor: C.white,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 7,
    elevation: 3,
  },

  layerBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: C.text,
  },

  bottomSheet: {
    backgroundColor: C.white,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    overflow: 'hidden',
  },

  sheetHandle: {
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },

  sheetHandleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: 'center',
    marginBottom: 10,
  },

  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  sheetTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: C.text,
  },

  sheetSubtitle: {
    fontSize: 12,
    color: C.textSub,
    backgroundColor: C.primaryBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: 'hidden',
  },

  sheetExpandIcon: {
    fontSize: 14,
    color: C.textMute,
  },

  sheetScroll: {
    flex: 1,
  },

  sheetScrollContent: {
    padding: 14,
    // absolute로 뜬 startBtnWrap 높이만큼 — 마지막 경로 카드가 버튼 뒤에 가리지 않게.
    paddingBottom: 96,
    gap: 12,
  },

  routeCard: {
    backgroundColor: C.white,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: C.border,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: C.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 6,
    marginBottom: 2,
  },

  routeCardBar: {
    height: 4,
  },

  routeCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
    gap: 8,
  },

  routeTag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },

  routeTagText: {
    fontSize: 12,
    fontWeight: '700',
  },

  selectedBadge: {
    backgroundColor: C.success + '20',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },

  selectedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: C.success,
  },

  warnChip: {
    backgroundColor: '#FFF3E0',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },

  warnChipText: {
    fontSize: 10,
    color: C.warn,
    fontWeight: '600',
  },

  routeMainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 12,
  },

  timeRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
  },

  routeTime: {
    fontSize: 32,
    fontWeight: '900',
    lineHeight: 36,
  },

  routeTimeUnit: {
    fontSize: 14,
    fontWeight: '600',
    color: C.textSub,
    marginBottom: 4,
  },

  routeDesc: {
    fontSize: 12,
    color: C.textSub,
    marginTop: 2,
    maxWidth: 130,
  },

  routeStats: {
    flex: 1,
    gap: 5,
    paddingTop: 4,
  },

  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: C.bg,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },

  statPillIcon: {
    fontSize: 11,
  },

  statPillText: {
    fontSize: 11,
    color: C.textSub,
    fontWeight: '500',
  },

  badgesScroll: {
    paddingHorizontal: 14,
    paddingBottom: 10,
  },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 6,
    gap: 4,
  },

  badgeIcon: {
    fontSize: 11,
  },

  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },

  warningBox: {
    marginHorizontal: 14,
    marginBottom: 10,
    backgroundColor: '#FFECEC',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },

  warningText: {
    fontSize: 12,
    color: C.danger,
    fontWeight: '700',
  },

  emptyCard: {
    backgroundColor: C.white,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: C.border,
    padding: 20,
    alignItems: 'center',
  },

  emptyTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: C.text,
  },

  emptyText: {
    marginTop: 8,
    fontSize: 13,
    color: C.textSub,
    textAlign: 'center',
    lineHeight: 19,
  },

  startBtnWrap: {
    // 일반 flex 흐름에 두면 시트가 확장(최대 85%)됐을 때 지도와 합쳐 화면
    // 높이를 넘어서 버튼이 화면 밖으로 밀려난다(실기기에서 "안내 시작 버튼이
    // 없다"로 재현됨). TransitContent와 동일하게 시트 상태와 무관하게 항상
    // 화면 하단에 고정되도록 absolute로 뺀다.
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: C.white,
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 12,
    borderTopWidth: 1,
    borderTopColor: C.border,
    elevation: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },

  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.navy,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 24,
    gap: 10,
    elevation: 4,
    shadowColor: C.navy,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
  },

  startBtnDisabled: {
    backgroundColor: C.textMute,
  },

  startBtnIcon: {
    fontSize: 20,
  },

  startBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: C.white,
    flex: 1,
    textAlign: 'center',
  },

  startBtnArrow: {
    fontSize: 18,
    color: 'rgba(255,255,255,0.7)',
  },
});