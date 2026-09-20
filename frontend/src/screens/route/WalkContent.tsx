import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  ActivityIndicator,
  Dimensions,
  Platform,
} from 'react-native';
import { C } from '../../constants/colors';
import { formatMinutes } from '../../utils/storage';
import RouteMapView from './RouteMapView';
import { useDraggableSheet } from './useDraggableSheet';
import { requestRouteCandidates } from '../../api/routeCompare';
import {
  buildComparison,
  buildRouteChoicePayload,
  primaryKind,
  type ShownCandidate,
} from '../../utils/routeChoiceModel';
import { CollectSession, newSessionId } from '../../utils/collectQueue';
import { getCollectConsent } from '../../personalization/collectConsent';

// 도보 탭 경로 선택에 그대로 노출되는 2개 후보 — 거리우선 / 유형별 경로.
// 순서·색은 routeChoiceModel 의 CANDIDATE_ORDER(distance → type → personal)에 대응.
const LANE_COLORS = [C.primary, C.success, C.warn];

function fmtDistM(m: number | null | undefined) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '거리 정보 없음';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}km` : `${Math.round(n)}m`;
}

function fmtTimeS(s: number | null | undefined) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return formatMinutes(Math.max(1, Math.round(n / 60)));
}

const { height: H } = Dimensions.get('window');

// 하이브리드(서울 안팎) 응답에서 서울 밖 구간(경사 데이터 없음)을 회색 직선으로.
type MapSeg = {
  coordinates: { latitude: number; longitude: number }[];
  color: string;
  zone?: string;
  slopeMean?: number;
};
function buildExternalSegments(routeSegments: any[] | undefined): MapSeg[] {
  if (!Array.isArray(routeSegments)) return [];
  const out: MapSeg[] = [];
  let run: { latitude: number; longitude: number }[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ coordinates: run, color: '#9AA0AE', zone: 'flat', slopeMean: 0 });
    run = [];
  };
  for (const s of routeSegments) {
    if (!s?.outside_seoul) { flush(); continue; }
    const c = Array.isArray(s.coords) ? s.coords : null;
    const a = c?.[0] ?? (s.start ? [s.start.longitude, s.start.latitude] : null);
    const b = c?.[1] ?? (s.end ? [s.end.longitude, s.end.latitude] : null);
    if (a && b && Number.isFinite(a[0]) && Number.isFinite(b[0])) {
      if (run.length === 0) run.push({ latitude: a[1], longitude: a[0] });
      run.push({ latitude: b[1], longitude: b[0] });
    }
  }
  flush();
  return out;
}

function fmtExtLen(m: number | null | undefined) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 1000 ? ` 약 ${(n / 1000).toFixed(1)}km` : ` 약 ${Math.round(n)}m`;
}

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

const StatPill = ({ icon, value }: { icon: string; value: string }) => (
  <View style={ss.statPill}>
    <Text style={ss.statPillIcon}>{icon}</Text>
    <Text style={ss.statPillText}>{value}</Text>
  </View>
);

// 경로 검색 다음 도보 탭에 바로 뜨는 후보 카드 — 거리우선 / 유형별 경로.
const CompareCard = ({
  cand,
  color,
  selected,
  onSelect,
}: {
  cand: ShownCandidate;
  color: string;
  selected: boolean;
  onSelect: (pos: number) => void;
}) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const kind = primaryKind(cand.mergedKinds);
  const desc =
    kind === 'distance'
      ? '이동 거리를 우선해 탐색한 경로예요.'
      : kind === 'personal'
      ? '내 이동 기록을 반영한 맞춤 경로예요.'
      : '경사·유형별 이동 부담을 고려한 경로예요.';

  const handlePress = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.97, duration: 80, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();
    onSelect(cand.shownPos);
  };

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={handlePress}
        style={[ss.routeCard, selected && { borderColor: color, borderWidth: 2 }]}
      >
        <View style={[ss.routeCardBar, { backgroundColor: color }]} />

        <View style={ss.routeCardHeader}>
          <View style={[ss.routeTag, { backgroundColor: color + '18' }]}>
            <Text style={[ss.routeTagText, { color }]}>{cand.label}</Text>
          </View>

          {selected && (
            <View style={ss.selectedBadge}>
              <Text style={ss.selectedBadgeText}>✓ 선택됨</Text>
            </View>
          )}

          <View style={{ flex: 1 }} />
        </View>

        <View style={ss.routeMainRow}>
          <View>
            <View style={ss.timeRow}>
              <Text style={[ss.routeTime, { color }]}>
                {fmtTimeS(cand.route.estimatedTimeS)}
              </Text>
            </View>
            <Text style={ss.routeDesc}>{desc}</Text>
          </View>

          <View style={ss.routeStats}>
            <StatPill icon="📏" value={fmtDistM(cand.route.totalDistance)} />
            <StatPill
              icon="⛰️"
              value={`평균 경사 ${Number(cand.route.avgSlope ?? 0).toFixed(1)}%`}
            />
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
};

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
  const [containerHeight, setContainerHeight] = useState(H);

  // 예전엔 "안내 시작" → 별도 RouteCompare 화면에서 거리우선/유형별을 골랐다.
  // 이제 그 2개 후보를 도보 탭 "경로 선택" 시트에 바로 띄우고, 고르면 곧장 안내로 간다.
  const [shown, setShown] = useState<ShownCandidate[]>([]);
  const [selectedPos, setSelectedPos] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  // 경로 선택 계측 세션(동의 시에만 생성 — 미동의면 전부 no-op).
  const collectRef = useRef<CollectSession | null>(null);

  // 하이브리드(서울 안팎 경계) 응답 — RouteScreen 이 넘겨준 routeData(단일 /route 호출)
  // 에 algorithm:'hybrid' / service_area.partial_coverage 가 있으면 compare 대신 이걸 쓴다.
  // (백엔드는 candidates=compare 일 때 하이브리드를 만들지 않는다.)
  const serviceArea = routeData?.service_area ?? null;
  const isHybrid =
    routeData?.algorithm === 'hybrid' || !!serviceArea?.partial_coverage;

  const hasCoords =
    !!startLatitude && !!startLongitude && !!endLatitude && !!endLongitude;

  useEffect(() => {
    let alive = true;

    (async () => {
      setLoading(true);
      setError('');

      try {
        const consent = await getCollectConsent();
        if (alive && consent === 'granted' && !collectRef.current) {
          collectRef.current = new CollectSession();
        }
      } catch {
        /* 동의 확인 실패 시 수집 안 함(보수적 기본값) */
      }

      if (!hasCoords) {
        if (alive) {
          setError('출발지·도착지 좌표가 없어 경로를 불러올 수 없습니다.');
          setLoading(false);
        }
        return;
      }

      // 하이브리드: compare 재호출 없이 routeData.routes(유형별/최단) 를 카드로 변환.
      if (isHybrid) {
        const hr: any[] = Array.isArray(routeData?.routes) ? routeData.routes : [];
        const src = hr.length ? hr : [routeData];
        const s = src.map((r: any, i: number) => {
          const isDist = r?.id === 'shortest' || r?.tag === '최단 거리';
          return {
            shownPos: i,
            label: isDist ? '거리우선' : '유형별 경로',
            mergedKinds: [isDist ? 'distance' : 'type'] as any,
            route: {
              coordinates: r?.coordinates ?? routeData?.coordinates ?? [],
              routeSegments: r?.routeSegments ?? routeData?.routeSegments ?? [],
              navigation_segments: r?.navigation_segments ?? routeData?.navigation_segments ?? [],
              waypoints: r?.waypoints ?? routeData?.waypoints ?? [],
              measurement_units: r?.measurement_units ?? routeData?.measurement_units ?? [],
              totalDistance: r?.totalDistance ?? routeData?.total_length_m ?? null,
              avgSlope: r?.avgSlope ?? routeData?.avg_slope_pct ?? 0,
              estimatedTimeS: r?.estimatedTimeS ?? routeData?.estimatedTimeS ?? null,
            },
          } as unknown as ShownCandidate;
        });
        if (alive) {
          setShown(s);
          setSelectedPos(0);
          setLoading(false);
        }
        return;
      }

      try {
        const res = await requestRouteCandidates({
          startLatitude: startLatitude!,
          startLongitude: startLongitude!,
          endLatitude: endLatitude!,
          endLongitude: endLongitude!,
          userType: walkerType || 'manual_wheelchair',
        });
        if (!alive) return;
        const { shown: s } = buildComparison(res.candidateRoutes);
        setShown(s);
        setSelectedPos(0);
      } catch (e: any) {
        if (alive) setError(e?.message ?? '경로를 불러오지 못했습니다.');
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [startLatitude, startLongitude, endLatitude, endLongitude, walkerType, reloadKey, isHybrid, routeData]);

  // 화면을 완전히 떠날 때 계측 세션 정리(빈 배치는 안 나감).
  useEffect(
    () => () => {
      void collectRef.current?.flush({ final: true });
      collectRef.current = null;
    },
    []
  );

  const selectedCand = shown[selectedPos] ?? shown[0];
  const selectedId = selectedCand ? String(selectedCand.shownPos) : '';

  // 하이브리드일 때만: 선택된 경로의 서울 밖 구간을 회색 직선으로 지도에 얹는다.
  const externalSegs = useMemo(
    () => (isHybrid ? buildExternalSegments((selectedCand as any)?.route?.routeSegments) : []),
    [isHybrid, selectedCand]
  );

  // routes가 실제로 바뀔 때만 새 배열을 만든다(지도 깜빡임/줌 초기화 방지).
  const mapRoutes = useMemo(
    () =>
      shown.map((s) => ({
        id: String(s.shownPos),
        color: LANE_COLORS[s.shownPos] ?? C.primary,
        coordinates: (s.route.coordinates ?? []).map(([lng, lat]) => ({
          latitude: lat,
          longitude: lng,
        })),
        segments: String(s.shownPos) === selectedId ? externalSegs : undefined,
      })),
    [shown, selectedId, externalSegs]
  );

  const { sheetExpanded, sheetHeight, toggleSheet, panHandlers } = useDraggableSheet(
    containerHeight,
    0.38,
    0.85
  );

  const handleStartNavigation = () => {
    if (!selectedCand) return;

    // 경로 선택 로그(동의 시에만). 후보가 1개뿐이면 "비교 없음"으로 남긴다.
    const cs = collectRef.current;
    if (cs) {
      try {
        cs.setRouteChoice(
          buildRouteChoicePayload(shown, shown.length > 1 ? selectedCand : null)
        );
        // final:true — NavigationScreen이 같은 session_id로 새 CollectSession을
        // 만들 것이므로 이 인스턴스는 여기서 완전히 끝내야 한다. 예전엔 non-final
        // flush 뒤 collectRef만 null로 비웠는데, setInterval 콜백은 여전히 이
        // 인스턴스(this)를 직접 참조해 clearInterval 없이는 안 멎는다 — 화면
        // 전환 후에도 "유령" 2분 타이머가 빈 배치로 계속 돌던 원인(진단 로그로 확인).
        cs.flush({ final: true }).catch(() => {});
      } catch {
        /* 로깅 실패는 안내 흐름을 막지 않는다 */
      }
    }
    const sessionId = cs?.sessionId;
    collectRef.current = null; // 아래 navigate 로 언마운트 → cleanup 의 flush 중복 방지

    const color = LANE_COLORS[selectedCand.shownPos] ?? C.primary;

    navigation?.navigate('Navigation', {
      routeId: primaryKind(selectedCand.mergedKinds),
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

      collectSessionId: sessionId,

      routeData: JSON.stringify({
        coordinates: selectedCand.route.coordinates,
        routeSegments: selectedCand.route.routeSegments,
        navigation_segments: selectedCand.route.navigation_segments ?? [],
        measurement_units: selectedCand.route.measurement_units ?? [],
        waypoints: selectedCand.route.waypoints ?? [],
        totalDistance: selectedCand.route.totalDistance,
        avgSlope: selectedCand.route.avgSlope,
        estimatedTimeS: selectedCand.route.estimatedTimeS,
        selectedRouteId: String(selectedCand.shownPos),
        selectedRouteTag: selectedCand.label,
        selectedRouteTitle: selectedCand.label,
        selectedRouteColor: color,
        // 하이브리드: 서울 밖(경사 데이터 없음) 구간 정보를 그대로 넘겨 NavigationScreen 이
        // 회색 표시 + 소요시간 측정/구간 피드백에서 제외하도록 한다.
        ...(isHybrid
          ? { algorithm: 'hybrid', service_area: serviceArea }
          : {}),
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
        selectedRouteId={selectedId}
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
            <Text style={ss.sheetSubtitle}>
              {loading ? '불러오는 중' : `${shown.length}개 경로 안내`}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={ss.sheetExpandIcon}>{sheetExpanded ? '▼' : '▲'}</Text>
          </View>
        </View>

        {isHybrid && (
          <View style={ss.svcBanner}>
            <Text style={ss.svcBannerIcon}>ℹ️</Text>
            <Text style={ss.svcBannerText}>
              {serviceArea?.origin_in_seoul === false && serviceArea?.dest_in_seoul === false
                ? '출발·도착이 모두 서울 밖이에요. '
                : '경로에 서울 밖 구간이 있어요. '}
              밖 구간{fmtExtLen(serviceArea?.external_length_m)}은 경사 데이터가 없어 최단(직선)
              안내만 제공돼요. 소요시간은 서울 안팎을 합쳐 계산했고, 구간 피드백/측정에서는 밖 구간을 제외해요.
            </Text>
          </View>
        )}

        <ScrollView
          style={ss.sheetScroll}
          contentContainerStyle={ss.sheetScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {loading ? (
            <View style={ss.emptyCard}>
              <ActivityIndicator color={C.primary} />
              <Text style={[ss.emptyText, { marginTop: 12 }]}>
                거리우선·유형별 경로를 불러오는 중이에요.
              </Text>
            </View>
          ) : error || shown.length === 0 ? (
            <View style={ss.emptyCard}>
              <Text style={ss.emptyTitle}>경로를 불러오지 못했습니다</Text>
              <Text style={ss.emptyText}>
                {error || '표시할 경로가 없습니다. 잠시 후 다시 시도해 주세요.'}
              </Text>
              <TouchableOpacity
                style={ss.retryBtn}
                onPress={() => setReloadKey((k) => k + 1)}
              >
                <Text style={ss.retryBtnText}>다시 시도</Text>
              </TouchableOpacity>
            </View>
          ) : (
            shown.map((cand) => (
              <CompareCard
                key={cand.shownPos}
                cand={cand}
                color={LANE_COLORS[cand.shownPos] ?? C.primary}
                selected={selectedPos === cand.shownPos}
                onSelect={setSelectedPos}
              />
            ))
          )}

          <View style={{ height: 20 }} />
        </ScrollView>
      </Animated.View>

      <View style={ss.startBtnWrap}>
        <TouchableOpacity
          style={[ss.startBtn, !selectedCand && ss.startBtnDisabled]}
          activeOpacity={0.85}
          disabled={!selectedCand}
          onPress={handleStartNavigation}
        >
          <Text style={ss.startBtnIcon}>🚶</Text>
          <Text style={ss.startBtnText}>
            {selectedCand
              ? `${selectedCand.label} 안내 시작`
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

  retryBtn: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bg,
  },

  retryBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: C.navy,
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

  svcBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 2,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#FFF4E2',
    borderWidth: 1,
    borderColor: C.warn + '55',
  },
  svcBannerIcon: { fontSize: 13, lineHeight: 18 },
  svcBannerText: { flex: 1, fontSize: 11.5, lineHeight: 17, color: '#7A5B12', fontWeight: '600' },
});