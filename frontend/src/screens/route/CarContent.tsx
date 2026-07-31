import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Animated, Dimensions, Platform,
} from 'react-native';
import { C } from '../../constants/colors';
import { formatMinutes } from '../../utils/storage';

const { height: H } = Dimensions.get('window');

// ── 경로 데이터 (추후 API로 교체) ──────────────────────────────
const ROUTES = [
  {
    id: 'c1', tag: '실시간 추천', tagColor: C.primary,
    time: 7, distance: '2.3km', taxiEstimate: '6,440원', via: '한강로 경유',
    features: ['noToll'],
    traffic: [
      { label: '원활', color: C.trafficGood, ratio: 0.5 },
      { label: '서행', color: C.trafficMid,  ratio: 0.3 },
      { label: '정체', color: C.trafficBad,  ratio: 0.2 },
    ],
    parking: {
      type: 'disabled', name: '용산구청 장애인 전용 주차장',
      spots: 6, distance: '목적지 정문 인근 20m', available: true,
      floor: '지상 1층', width: '3.5m 넓은 칸',
    },
  },
  {
    id: 'c2', tag: '큰길 우선', tagColor: C.car,
    time: 9, distance: '2.7km', taxiEstimate: '7,200원', via: '이태원로 경유',
    features: ['noToll', 'childSafe'],
    traffic: [
      { label: '원활', color: C.trafficGood, ratio: 0.7 },
      { label: '서행', color: C.trafficMid,  ratio: 0.2 },
      { label: '정체', color: C.trafficBad,  ratio: 0.1 },
    ],
    parking: {
      type: 'disabled', name: '용산구청 장애인 전용 주차장',
      spots: 6, distance: '목적지 정문 인근 20m', available: true,
      floor: '지상 1층', width: '3.5m 넓은 칸',
    },
  },
];

const PARKING_ALTERNATIVES = [
  { id: 'p1', type: 'general', name: '용산구청 공영주차장', distance: '도착지에서 80m', price: '최초 30분 무료', spots: 42, available: true, accessNote: '경사로 진입 가능' },
  { id: 'p2', type: 'dropoff', name: '용산구청 정문 앞 승하차 구역', distance: '정문 바로 앞', price: '무료 (5분 이내)', note: '단기 정차 후 주차장 이동 권장' },
  { id: 'p3', type: 'general', name: '한강로 공영주차장', distance: '도착지에서 220m', price: '시간당 1,000원', spots: 120, available: true, accessNote: '엘리베이터 없음 · 평지' },
];

const NEARBY_FACILITIES = [
  { id: 'f1', type: 'toilet',   icon: '🚻', name: '용산구청 장애인 화장실',   distance: '30m',  floor: '1층 로비',   note: '남·여 각 1개, 자동문',   color: C.toilet,   bg: C.toiletBg   },
  { id: 'f2', type: 'ramp',     icon: '♿', name: '용산구청 정문 경사로',     distance: '10m',  floor: undefined,    note: '기울기 1/12, 손잡이 양측', color: C.ramp,     bg: C.rampBg     },
  { id: 'f3', type: 'elevator', icon: '🛗', name: '용산구청 내부 엘리베이터', distance: '50m',  floor: '1~4층 운행',  note: '점자 버튼, 음성 안내',    color: C.elevator, bg: C.elevatorBg },
  { id: 'f4', type: 'toilet',   icon: '🚻', name: '한강로 공중 장애인 화장실', distance: '180m', floor: undefined,    note: '24시간 개방',             color: C.toilet,   bg: C.toiletBg   },
];

// ── 서브 컴포넌트 ───────────────────────────────────────────────
const TrafficBar = ({ traffic }: { traffic: any[] }) => (
  <View style={ss.trafficBarWrap}>
    <View style={ss.trafficBar}>
      {traffic.map((t, i) => (
        <View key={i} style={[ss.trafficPiece, {
          flex: t.ratio, backgroundColor: t.color,
          borderTopLeftRadius:     i === 0 ? 4 : 0,
          borderBottomLeftRadius:  i === 0 ? 4 : 0,
          borderTopRightRadius:    i === traffic.length - 1 ? 4 : 0,
          borderBottomRightRadius: i === traffic.length - 1 ? 4 : 0,
        }]} />
      ))}
    </View>
    <View style={ss.trafficLegend}>
      {traffic.map((t, i) => (
        <View key={i} style={ss.legendItem}>
          <View style={[ss.legendDot, { backgroundColor: t.color }]} />
          <Text style={ss.legendText}>{t.label} {Math.round(t.ratio * 100)}%</Text>
        </View>
      ))}
    </View>
  </View>
);

const MetaItem = ({ icon, value }: { icon: string; value: string }) => (
  <View style={ss.metaItem}>
    <Text style={ss.metaIcon}>{icon}</Text>
    <Text style={ss.metaValue}>{value}</Text>
  </View>
);

const AltParkingItem = ({ item }: { item: any }) => {
  const isDropoff = item.type === 'dropoff';
  const color = isDropoff ? C.dropoff : C.parkGeneral;
  const bg    = isDropoff ? C.dropoffBg : C.parkGenBg;
  const icon  = isDropoff ? '🚏' : '🅿';
  return (
    <View style={[ss.altParkingItem, { borderLeftColor: color, borderLeftWidth: 3 }]}>
      <View style={[ss.altParkingIconWrap, { backgroundColor: bg }]}>
        <Text style={ss.altParkingIcon}>{icon}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={ss.altParkingTopRow}>
          <Text style={ss.altParkingName}>{item.name}</Text>
          {item.spots && <Text style={[ss.altParkingSpots, { color }]}>{item.spots}면</Text>}
        </View>
        <Text style={ss.altParkingDist}>{item.distance}</Text>
        <View style={ss.altParkingMeta}>
          <Text style={ss.altParkingPrice}>{item.price}</Text>
          {item.accessNote && (
            <View style={[ss.altParkingNote, { backgroundColor: bg }]}>
              <Text style={[ss.altParkingNoteText, { color }]}>{item.accessNote}</Text>
            </View>
          )}
        </View>
        {item.note && <Text style={ss.altParkingSubNote}>{item.note}</Text>}
      </View>
    </View>
  );
};

const ParkingCard = ({ parking, alternatives }: { parking: any; alternatives: any[] }) => {
  const [showAlt, setShowAlt] = useState(false);

  if (parking?.available && parking.type === 'disabled') {
    return (
      <View style={ss.parkingCard}>
        <View style={ss.parkingCardHeader}>
          <View style={[ss.parkingTypeBadge, { backgroundColor: C.parkDisBg }]}>
            <Text style={ss.parkingTypeIcon}>♿</Text>
            <Text style={[ss.parkingTypeText, { color: C.parkDisabled }]}>장애인 전용 주차</Text>
          </View>
          <View style={ss.availablePill}>
            <View style={ss.availableDot} />
            <Text style={ss.availableText}>이용 가능 {parking.spots}면</Text>
          </View>
        </View>
        <Text style={ss.parkingName}>{parking.name}</Text>
        <View style={ss.parkingMeta}>
          <MetaItem icon="📍" value={parking.distance} />
          <MetaItem icon="🏢" value={parking.floor} />
          <MetaItem icon="📐" value={parking.width} />
        </View>
        <TouchableOpacity style={ss.parkingAltBtn} onPress={() => setShowAlt(v => !v)}>
          <Text style={ss.parkingAltBtnText}>🅿 주변 주차장 더보기  {showAlt ? '▲' : '▼'}</Text>
        </TouchableOpacity>
        {showAlt && alternatives.map(p => <AltParkingItem key={p.id} item={p} />)}
      </View>
    );
  }

  return (
    <View style={[ss.parkingCard, { borderColor: C.warn + '50' }]}>
      <View style={ss.parkingUnavailHeader}>
        <Text style={ss.parkingUnavailIcon}>⚠️</Text>
        <Text style={ss.parkingUnavailText}>목적지 인근 장애인 전용 주차장 만차</Text>
      </View>
      <Text style={ss.parkingUnavailSub}>아래 대안 중 선택하세요</Text>
      {alternatives.map(p => <AltParkingItem key={p.id} item={p} />)}
    </View>
  );
};

const FacilityItem = ({ item }: { item: any }) => (
  <View style={[ss.facilityItem, { borderColor: item.color + '40' }]}>
    <View style={[ss.facilityIconWrap, { backgroundColor: item.bg }]}>
      <Text style={ss.facilityIcon}>{item.icon}</Text>
    </View>
    <View style={{ flex: 1 }}>
      <View style={ss.facilityTopRow}>
        <Text style={ss.facilityName}>{item.name}</Text>
        <Text style={[ss.facilityDist, { color: item.color }]}>{item.distance}</Text>
      </View>
      {item.floor && <Text style={ss.facilityFloor}>{item.floor}</Text>}
      <Text style={ss.facilityNote}>{item.note}</Text>
    </View>
  </View>
);

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
            <Text style={ss.routeVia}>{route.via}</Text>
            {selected && (
              <View style={ss.selectedPill}><Text style={ss.selectedPillText}>✓ 선택</Text></View>
            )}
          </View>
          <View style={ss.routeCardMid}>
            <View>
              <View style={ss.timeRow}>
                <Text style={[ss.routeTime, { color: route.tagColor }]}>{formatMinutes(route.time)}</Text>
              </View>
              <Text style={ss.routeDist}>{route.distance}</Text>
            </View>
            <View style={ss.taxiEstimateBox}>
              <Text style={ss.taxiEstimateLabel}>🚕 택시 예상</Text>
              <Text style={ss.taxiEstimateValue}>{route.taxiEstimate}</Text>
            </View>
          </View>
          <TrafficBar traffic={route.traffic} />
          <View style={ss.parkBadgeRow}>
            {route.parking?.available ? (
              <View style={ss.parkAvailBadge}><Text style={ss.parkAvailText}>♿ 장애인 주차 가능</Text></View>
            ) : (
              <View style={ss.parkUnavailBadge}><Text style={ss.parkUnavailText}>⚠ 장애인 주차 만차</Text></View>
            )}
            {route.features?.includes('noToll') && (
              <View style={ss.featureBadge}><Text style={ss.featureBadgeText}>🚫 무료도로</Text></View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
};

const MapPlaceholder = ({ route }: { route: any }) => (
  <View style={ss.mapContainer}>
    <View style={ss.mapBg}>
      {[...Array(7)].map((_, i) => (
        <View key={`h${i}`} style={[ss.mapGridH, { top: `${i * 16}%` as any }]} />
      ))}
      {[...Array(5)].map((_, i) => (
        <View key={`v${i}`} style={[ss.mapGridV, { left: `${i * 25}%` as any }]} />
      ))}
      <View style={[ss.routeRoad, { backgroundColor: C.trafficGood, left: '15%', top: '30%', width: '25%', transform: [{ rotate: '10deg' }] }]} />
      <View style={[ss.routeRoad, { backgroundColor: C.trafficMid,  left: '35%', top: '38%', width: '20%', transform: [{ rotate: '-5deg' }] }]} />
      <View style={[ss.routeRoad, { backgroundColor: C.trafficBad,  left: '50%', top: '42%', width: '15%', transform: [{ rotate: '15deg' }] }]} />
      <View style={[ss.routeRoad, { backgroundColor: C.trafficGood, left: '60%', top: '50%', width: '20%', transform: [{ rotate: '-10deg' }] }]} />
      <View style={[ss.mapMarkerWrap, { top: '25%' as any, left: '12%' as any }]}>
        <View style={[ss.markerCircle, { backgroundColor: C.success }]} />
        <Text style={ss.markerLabel}>출발</Text>
      </View>
      <View style={[ss.mapMarkerWrap, { bottom: '30%' as any, right: '12%' as any }]}>
        <Text style={{ fontSize: 26 }}>📍</Text>
        <Text style={ss.markerLabel}>도착</Text>
      </View>
      <View style={[ss.parkMarker, { bottom: '35%' as any, right: '18%' as any }]}>
        <Text style={ss.parkMarkerText}>♿ 장애인주차</Text>
      </View>
      <View style={[ss.toiletMarker, { bottom: '45%' as any, right: '22%' as any }]}>
        <Text style={ss.toiletMarkerText}>🚻 화장실</Text>
      </View>
      {route && (
        <View style={[ss.realtimeChip, { borderColor: route.tagColor }]}>
          <View style={[ss.realtimeDot, { backgroundColor: route.tagColor }]} />
          <Text style={[ss.realtimeText, { color: route.tagColor }]}>실시간 {formatMinutes(route.time)}</Text>
        </View>
      )}
      <View style={ss.mapControls}>
        {['＋', '－', '⊙'].map((icon, i) => (
          <TouchableOpacity key={i} style={ss.mapControlBtn}>
            <Text style={ss.mapControlIcon}>{icon}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TouchableOpacity style={ss.layerBtn}>
        <Text style={ss.layerBtnText}>♿ 편의시설 레이어</Text>
      </TouchableOpacity>
    </View>
  </View>
);

// ── 메인 ───────────────────────────────────────────────────────
interface Props { navigation: any; walkerType?: string; }

const FACILITY_FILTERS = [
  { key: 'all',       label: '전체'          },
  { key: 'toilet',    label: '🚻 화장실'     },
  { key: 'ramp',      label: '♿ 경사로'     },
  { key: 'elevator',  label: '🛗 엘리베이터' },
];

export default function CarContent({ navigation, walkerType }: Props) {
  const [selectedRoute, setSelectedRoute]   = useState('c1');
  const [activeSection, setActiveSection]   = useState<'routes' | 'parking' | 'facilities'>('routes');
  const [facilityFilter, setFacilityFilter] = useState('all');
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const sheetAnim = useRef(new Animated.Value(0)).current;

  const toggleSheet = useCallback(() => {
    const toValue = sheetExpanded ? 0 : 1;
    Animated.spring(sheetAnim, { toValue, tension: 80, friction: 12, useNativeDriver: false }).start();
    setSheetExpanded(v => !v);
  }, [sheetExpanded]);

  const sheetHeight = sheetAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [H * 0.40, H * 0.78],
  });

  const currentRoute = ROUTES.find(r => r.id === selectedRoute);
  const filteredFacilities = facilityFilter === 'all'
    ? NEARBY_FACILITIES
    : NEARBY_FACILITIES.filter(f => f.type === facilityFilter);

  const SECTION_TABS = [
    { key: 'routes',     label: '🚗 경로',     count: ROUTES.length },
    { key: 'parking',    label: '🅿 주차',     count: PARKING_ALTERNATIVES.length + 1 },
    { key: 'facilities', label: '♿ 편의시설', count: NEARBY_FACILITIES.length },
  ];

  return (
    <View style={ss.content}>
      <MapPlaceholder route={currentRoute} />

      <Animated.View style={[ss.bottomSheet, { height: sheetHeight }]}>
        <TouchableOpacity style={ss.sheetHandle} onPress={toggleSheet} activeOpacity={0.7}>
          <View style={ss.sheetHandleBar} />
          <View style={ss.sheetTitleRow}>
            <Text style={ss.sheetTitle}>자동차 경로</Text>
            <View style={ss.liveBadge}>
              <View style={ss.liveDot} />
              <Text style={ss.liveBadgeText}>실시간 반영</Text>
            </View>
            <View style={{ flex: 1 }} />
            <Text style={ss.sheetExpandIcon}>{sheetExpanded ? '▼' : '▲'}</Text>
          </View>
        </TouchableOpacity>

        {/* 섹션 탭 */}
        <View style={ss.sectionTabBar}>
          {SECTION_TABS.map(tab => (
            <TouchableOpacity
              key={tab.key}
              style={[ss.sectionTab, activeSection === tab.key && ss.sectionTabActive]}
              onPress={() => {
                setActiveSection(tab.key as any);
                if (!sheetExpanded) toggleSheet();
              }}
            >
              <Text style={[ss.sectionTabText, activeSection === tab.key && ss.sectionTabTextActive]}>
                {tab.label}
              </Text>
              <View style={[ss.sectionCount, activeSection === tab.key && ss.sectionCountActive]}>
                <Text style={[ss.sectionCountText, activeSection === tab.key && ss.sectionCountTextActive]}>
                  {tab.count}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {activeSection === 'routes' && (
          <ScrollView style={ss.sheetScroll} contentContainerStyle={ss.sheetScrollContent} showsVerticalScrollIndicator={false}>
            {ROUTES.map(route => (
              <RouteCard key={route.id} route={route} selected={selectedRoute === route.id} onSelect={setSelectedRoute} />
            ))}
            <View style={ss.taxiBanner}>
              <View style={ss.taxiBannerLeft}>
                <Text style={ss.taxiBannerIcon}>🚕</Text>
                <View>
                  <Text style={ss.taxiBannerTitle}>교통약자 콜택시 이용하기</Text>
                  <Text style={ss.taxiBannerSub}>장애인 콜택시 · 바우처 택시 연결 가능</Text>
                </View>
              </View>
              <TouchableOpacity style={ss.taxiCallBtn}>
                <Text style={ss.taxiCallText}>호출 →</Text>
              </TouchableOpacity>
            </View>
            <View style={{ height: 16 }} />
          </ScrollView>
        )}

        {activeSection === 'parking' && (
          <ScrollView style={ss.sheetScroll} contentContainerStyle={ss.sheetScrollContent} showsVerticalScrollIndicator={false}>
            <View style={ss.sectionNote}>
              <Text style={ss.sectionNoteIcon}>ℹ️</Text>
              <Text style={ss.sectionNoteText}>
                선택 경로의 목적지 기준으로 장애인 전용 주차장을 우선 안내합니다.
              </Text>
            </View>
            <ParkingCard parking={currentRoute?.parking} alternatives={PARKING_ALTERNATIVES} />
            <View style={{ height: 16 }} />
          </ScrollView>
        )}

        {activeSection === 'facilities' && (
          <ScrollView style={ss.sheetScroll} contentContainerStyle={ss.sheetScrollContent} showsVerticalScrollIndicator={false}>
            <View style={ss.sectionNote}>
              <Text style={ss.sectionNoteIcon}>♿</Text>
              <Text style={ss.sectionNoteText}>목적지 반경 300m 이내 교통약자 편의시설입니다.</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={ss.facilityFilterBar}>
              {FACILITY_FILTERS.map(f => (
                <TouchableOpacity
                  key={f.key}
                  style={[ss.facilityFilter, facilityFilter === f.key && ss.facilityFilterActive]}
                  onPress={() => setFacilityFilter(f.key)}
                >
                  <Text style={[ss.facilityFilterText, facilityFilter === f.key && ss.facilityFilterTextActive]}>
                    {f.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {filteredFacilities.map(f => <FacilityItem key={f.id} item={f} />)}
            <View style={{ height: 16 }} />
          </ScrollView>
        )}
      </Animated.View>

      <View style={ss.startBtnWrap}>
        <TouchableOpacity
          style={[ss.startBtn, { backgroundColor: C.car }]}
          activeOpacity={0.85}
          onPress={() => navigation?.navigate('Navigation', { routeId: selectedRoute, mode: 'car' })}
        >
          <Text style={ss.startBtnIcon}>🚗</Text>
          <Text style={ss.startBtnText}>{currentRoute?.tag} 경로로 자동차 안내 시작</Text>
          <Text style={ss.startBtnArrow}>→</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const ss = StyleSheet.create({
  content: { flex: 1 },

  mapContainer: { flex: 1 },
  mapBg: { flex: 1, backgroundColor: '#E8EBF0', position: 'relative', overflow: 'hidden' },
  mapGridH: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(200,204,218,0.5)' },
  mapGridV: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(200,204,218,0.5)' },
  routeRoad: { position: 'absolute', height: 6, borderRadius: 3 },
  mapMarkerWrap: { position: 'absolute', alignItems: 'center' },
  markerCircle: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: C.white, elevation: 4 },
  markerLabel: {
    fontSize: 10, fontWeight: '700', color: C.text,
    backgroundColor: C.white, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 8, marginTop: 2, overflow: 'hidden', elevation: 2,
  },
  parkMarker: {
    position: 'absolute', backgroundColor: C.parkDisBg, borderRadius: 14,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1.5, borderColor: C.parkDisabled, elevation: 3,
  },
  parkMarkerText: { fontSize: 11, color: C.parkDisabled, fontWeight: '700' },
  toiletMarker: {
    position: 'absolute', backgroundColor: C.toiletBg, borderRadius: 14,
    paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: C.toilet, elevation: 3,
  },
  toiletMarkerText: { fontSize: 11, color: C.toilet, fontWeight: '600' },
  realtimeChip: {
    position: 'absolute', top: 14, left: 14, flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.white, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1.5, elevation: 4, gap: 6,
  },
  realtimeDot: { width: 8, height: 8, borderRadius: 4 },
  realtimeText: { fontSize: 13, fontWeight: '700' },
  mapControls: { position: 'absolute', right: 14, top: '25%', gap: 6 },
  mapControlBtn: {
    width: 38, height: 38, borderRadius: 10, backgroundColor: C.white,
    alignItems: 'center', justifyContent: 'center', elevation: 3,
  },
  mapControlIcon: { fontSize: 18, color: C.text, fontWeight: '600' },
  layerBtn: {
    position: 'absolute', right: 14, bottom: 14, backgroundColor: C.primaryBg,
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: C.primary, elevation: 3,
  },
  layerBtnText: { fontSize: 12, fontWeight: '600', color: C.primary },

  bottomSheet: {
    backgroundColor: C.white, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    elevation: 14, shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.12, shadowRadius: 12, overflow: 'hidden',
  },
  sheetHandle: {
    paddingTop: 10, paddingHorizontal: 16, paddingBottom: 8,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  sheetHandleBar: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: C.border,
    alignSelf: 'center', marginBottom: 10,
  },
  sheetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: C.text },
  liveBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#E8FFE8', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.trafficGood },
  liveBadgeText: { fontSize: 11, color: C.trafficGood, fontWeight: '700' },
  sheetExpandIcon: { fontSize: 14, color: C.textMute },
  sectionTabBar: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.white,
  },
  sectionTab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, gap: 5, borderBottomWidth: 2.5, borderBottomColor: 'transparent',
  },
  sectionTabActive: { borderBottomColor: C.primary },
  sectionTabText: { fontSize: 12, fontWeight: '600', color: C.textSub },
  sectionTabTextActive: { color: C.primary },
  sectionCount: { backgroundColor: C.bg, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  sectionCountActive: { backgroundColor: C.primaryBg },
  sectionCountText: { fontSize: 10, color: C.textMute, fontWeight: '600' },
  sectionCountTextActive: { color: C.primary },
  sheetScroll: { flex: 1 },
  sheetScrollContent: { padding: 14, gap: 12 },
  sectionNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    backgroundColor: C.primaryBg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
  },
  sectionNoteIcon: { fontSize: 14 },
  sectionNoteText: { flex: 1, fontSize: 12, color: C.textSub, lineHeight: 18 },

  routeCard: {
    backgroundColor: C.white, borderRadius: 16, borderWidth: 1.5, borderColor: C.border, overflow: 'hidden',
    elevation: 2, shadowColor: C.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 1, shadowRadius: 6,
  },
  routeCardBar: { height: 4 },
  routeCardBody: { padding: 14, gap: 10 },
  routeCardTop: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  routeTag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  routeTagText: { fontSize: 12, fontWeight: '700' },
  routeVia: { fontSize: 12, color: C.textSub },
  selectedPill: { backgroundColor: C.success + '22', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  selectedPillText: { fontSize: 11, color: C.success, fontWeight: '700' },
  routeCardMid: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  timeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  routeTime: { fontSize: 34, fontWeight: '900', lineHeight: 38 },
  routeTimeUnit: { fontSize: 14, fontWeight: '600', color: C.textSub, marginBottom: 5 },
  routeDist: { fontSize: 12, color: C.textSub, marginTop: 2 },
  taxiEstimateBox: {
    backgroundColor: C.taxiBg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8,
    alignItems: 'flex-end', borderWidth: 1, borderColor: C.taxi + '50',
  },
  taxiEstimateLabel: { fontSize: 11, color: C.textSub },
  taxiEstimateValue: { fontSize: 15, fontWeight: '800', color: C.taxi, marginTop: 2 },
  parkBadgeRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  parkAvailBadge: {
    backgroundColor: C.parkDisBg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: C.parkDisabled + '50',
  },
  parkAvailText: { fontSize: 11, color: C.parkDisabled, fontWeight: '700' },
  parkUnavailBadge: {
    backgroundColor: '#FFF3E0', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: C.warn + '50',
  },
  parkUnavailText: { fontSize: 11, color: C.warn, fontWeight: '700' },
  featureBadge: {
    backgroundColor: C.bg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: C.border,
  },
  featureBadgeText: { fontSize: 11, color: C.textSub },
  trafficBarWrap: { gap: 6 },
  trafficBar: { flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', gap: 2 },
  trafficPiece: {},
  trafficLegend: { flexDirection: 'row', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11, color: C.textSub },

  parkingCard: {
    backgroundColor: C.white, borderRadius: 16, borderWidth: 1.5, borderColor: C.parkDisabled + '40',
    padding: 14, gap: 10, elevation: 2, shadowColor: C.shadow,
    shadowOffset: { width: 0, height: 2 }, shadowOpacity: 1, shadowRadius: 6,
  },
  parkingCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  parkingTypeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5,
  },
  parkingTypeIcon: { fontSize: 14 },
  parkingTypeText: { fontSize: 12, fontWeight: '700' },
  availablePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#E8F9EF', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4,
  },
  availableDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.success },
  availableText: { fontSize: 11, color: C.success, fontWeight: '700' },
  parkingName: { fontSize: 15, fontWeight: '700', color: C.text },
  parkingMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metaItem: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: C.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
  },
  metaIcon: { fontSize: 12 },
  metaValue: { fontSize: 12, color: C.textSub, fontWeight: '500' },
  parkingAltBtn: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: C.border, marginTop: 4 },
  parkingAltBtnText: { fontSize: 13, color: C.car, fontWeight: '600' },
  parkingUnavailHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#FFF3E0', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
  },
  parkingUnavailIcon: { fontSize: 18 },
  parkingUnavailText: { fontSize: 13, color: C.warn, fontWeight: '700', flex: 1 },
  parkingUnavailSub: { fontSize: 12, color: C.textSub },
  altParkingItem: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    backgroundColor: C.bg, borderRadius: 12, padding: 12, marginBottom: 8,
  },
  altParkingIconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  altParkingIcon: { fontSize: 18 },
  altParkingTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  altParkingName: { fontSize: 13, fontWeight: '700', color: C.text, flex: 1 },
  altParkingSpots: { fontSize: 12, fontWeight: '700' },
  altParkingDist: { fontSize: 12, color: C.textSub, marginTop: 1 },
  altParkingMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  altParkingPrice: { fontSize: 12, color: C.textSub, fontWeight: '600' },
  altParkingNote: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  altParkingNoteText: { fontSize: 11, fontWeight: '600' },
  altParkingSubNote: { fontSize: 11, color: C.textMute, marginTop: 3 },

  facilityFilterBar: { marginBottom: 4 },
  facilityFilter: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, marginRight: 8,
  },
  facilityFilterActive: { backgroundColor: C.primary, borderColor: C.primary },
  facilityFilterText: { fontSize: 12, color: C.textSub, fontWeight: '500' },
  facilityFilterTextActive: { color: C.white, fontWeight: '700' },
  facilityItem: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: C.white,
    borderRadius: 14, padding: 12, borderWidth: 1,
    elevation: 1, shadowColor: C.shadow, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 1, shadowRadius: 4,
  },
  facilityIconWrap: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  facilityIcon: { fontSize: 20 },
  facilityTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  facilityName: { fontSize: 14, fontWeight: '700', color: C.text, flex: 1 },
  facilityDist: { fontSize: 12, fontWeight: '700' },
  facilityFloor: { fontSize: 12, color: C.textSub, marginTop: 1 },
  facilityNote: { fontSize: 12, color: C.textMute, marginTop: 2 },

  taxiBanner: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.taxiBg,
    borderRadius: 14, padding: 14, gap: 10,
    borderWidth: 1, borderColor: C.taxi + '40', marginTop: 4,
  },
  taxiBannerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  taxiBannerIcon: { fontSize: 26 },
  taxiBannerTitle: { fontSize: 13, fontWeight: '700', color: C.text },
  taxiBannerSub: { fontSize: 11, color: C.textSub, marginTop: 1 },
  taxiCallBtn: { backgroundColor: C.taxi, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 },
  taxiCallText: { fontSize: 13, fontWeight: '800', color: C.white },

  startBtnWrap: {
    backgroundColor: C.white, paddingHorizontal: 16, paddingVertical: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 12,
    borderTopWidth: 1, borderTopColor: C.border,
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
