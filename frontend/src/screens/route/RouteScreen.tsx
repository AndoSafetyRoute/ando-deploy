import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Platform,
  Modal,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { C } from "../../constants/colors";
import WalkContent from "./WalkContent";
import TransitContent, { useTransitRoutes } from "./TransitContent";
import { requestRoute } from "../../api/routeApi";
import { getUserType, toApiUserType, saveUserType, toKoreanUserType, getShowSlopeMarkers, setShowSlopeMarkers, formatMinutes } from "../../utils/storage";

type TransportKey = "transit" | "car" | "walk";

type RouteParams = {
  from?: string;
  to?: string;

  startName?: string;
  startAddress?: string;
  startLatitude?: string;
  startLongitude?: string;

  endName?: string;
  endAddress?: string;
  endLatitude?: string;
  endLongitude?: string;

  routeData?: string;
};

interface Props {
  navigation: any;
  route?: {
    params?: RouteParams;
  };
}

const NAVY = "#1B0F4A";

const TRANSPORT_TABS: Array<{
  key: TransportKey;
  icon: string;
  label: string;
  defaultTime: string;
}> = [
  { key: "transit", icon: "🚌", label: "대중교통", defaultTime: "31분" },
  { key: "walk", icon: "🚶", label: "도보", defaultTime: "35분" },
];

const WALKER_TYPES = [
  { key: "manual_wheelchair", label: "수동 휠체어", icon: "♿" },
  { key: "electric_wheelchair", label: "전동 휠체어", icon: "🦽" },
  { key: "walker", label: "보행기", icon: "🚶" },
  { key: "cane", label: "지팡이", icon: "🦯" },
  { key: "leg_injury", label: "목발 사용자", icon: "🩹" },
  { key: "elderly", label: "고령자", icon: "👴" },
];

function safeParseRouteData(routeData?: string) {
  if (!routeData) return null;

  try {
    return JSON.parse(routeData);
  } catch (error) {
    console.log("routeData parse error:", error);
    return null;
  }
}

function getRecommendedRoute(routeData: any) {
  if (!routeData) return null;

  if (Array.isArray(routeData.routes)) {
    return (
      routeData.routes.find((r: any) => r.id === "recommended") ??
      routeData.routes[0] ??
      null
    );
  }

  return routeData;
}

function getDistanceNumber(routeData: any): number | null {
  if (!routeData) return null;

  const recommendedRoute = getRecommendedRoute(routeData);

  const distance =
    recommendedRoute?.totalDistance ??
    recommendedRoute?.total_length_m ??
    recommendedRoute?.distance ??
    recommendedRoute?.summary?.distance ??
    routeData?.totalDistance ??
    routeData?.total_length_m ??
    routeData?.distance ??
    routeData?.summary?.distance;

  const n = Number(distance);

  return Number.isFinite(n) ? n : null;
}

function getDistanceText(routeData: any) {
  const distanceNumber = getDistanceNumber(routeData);

  if (distanceNumber === null) return "거리 정보 없음";

  if (distanceNumber >= 1000) {
    return `${(distanceNumber / 1000).toFixed(1)}km`;
  }

  return `${Math.round(distanceNumber)}m`;
}

function getTimeText(routeData: any, fallback: string) {
  if (!routeData) return fallback;

  const distanceNumber = getDistanceNumber(routeData);

  if (distanceNumber === null) return fallback;

  // 보행 기준: 약 1m/s = 60m/min
  const minute = Math.max(1, Math.round(distanceNumber / 60));

  return formatMinutes(minute);
}

export default function RouteScreen({ navigation, route }: Props) {
  const params = route?.params ?? {};

  const initialRouteData = useMemo(
    () => safeParseRouteData(params.routeData),
    [params.routeData]
  );

  const [parsedRouteData, setParsedRouteData] = useState(initialRouteData);
  const [routeLoading, setRouteLoading] = useState(false);

  const [from, setFrom] = useState(
    params.from ?? params.startName ?? "출발지"
  );
  const [to, setTo] = useState(params.to ?? params.endName ?? "도착지");

  // 출발지·도착지의 "실제 값"(좌표·주소). 교환 버튼을 눌러도 이게 함께 뒤집혀야
  // 지도/거리/소요시간/안내 시작이 반대 방향으로 갱신된다. 예전엔 from/to 라벨만
  // 바꾸고 좌표는 params 를 그대로 써서 "눌러도 아무 것도 안 바뀌는" 것처럼 보였다.
  const [endpoints, setEndpoints] = useState({
    startName: params.startName,
    startAddress: params.startAddress,
    startLatitude: params.startLatitude,
    startLongitude: params.startLongitude,
    endName: params.endName,
    endAddress: params.endAddress,
    endLatitude: params.endLatitude,
    endLongitude: params.endLongitude,
  });

  const [editingField, setEditingField] = useState<"from" | "to" | null>(null);
  const [walkerType, setWalkerType] = useState("manual_wheelchair");
  const [showSlopeMarkers, setShowSlopeMarkersState] = useState(true);
  const [tempWalkerType, setTempWalkerType] = useState("manual_wheelchair");
  const [showWalkerModal, setShowWalkerModal] = useState(false);
  const [activeTransport, setActiveTransport] = useState<TransportKey>("walk");

  // activeTransport(탭)와 무관하게 항상 호출한다. 대중교통 탭을 열지 않은 상태에서도
  // 미리 조회가 시작돼야 "도보로 처음 탐색하면 대중교통은 기본값(31분)에 고정되고,
  // 탭을 열어야만 실제 값으로 바뀐다"는 문제가 해결되고, 유형을 바꿨을 때도 지금 보고
  // 있는 탭과 무관하게 즉시 재조회가 시작된다.
  const hasCoordsForTransit =
    !!endpoints.startLatitude &&
    !!endpoints.startLongitude &&
    !!endpoints.endLatitude &&
    !!endpoints.endLongitude;

  const transitState = useTransitRoutes({
    startLatitude: endpoints.startLatitude,
    startLongitude: endpoints.startLongitude,
    endLatitude: endpoints.endLatitude,
    endLongitude: endpoints.endLongitude,
    startName: endpoints.startName,
    endName: endpoints.endName,
    walkerType,
  });

  const transitCurrentRoute = transitState.routes.find(
    (r: any) => r.id === transitState.selectedRoute
  );
  const transitTimeMin: number | null = hasCoordsForTransit
    ? transitCurrentRoute?.totalTime ?? null
    : null;

  const [panelOpen, setPanelOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const panelAnim = useRef(new Animated.Value(1)).current;
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;

  const togglePanel = (open: boolean) => {
    if (open === panelOpenRef.current) return;
    setPanelOpen(open);
    Animated.timing(panelAnim, {
      toValue: open ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  };

  const panelPanResponder = useRef(
    PanResponder.create({
      // 이동이 없는 순수 탭도 이 responder가 잡아야 onPanResponderRelease의
      // 탭-토글 분기가 실행된다. 이게 빠지면 짧은 이동이 없는 탭은 아예 무시된다.
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dy) > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy < -8) togglePanel(false);
        else if (gesture.dy > 8) togglePanel(true);
        else togglePanel(!panelOpenRef.current);
      },
    })
  ).current;

  useEffect(() => {
    getUserType().then((saved) => {
      const apiType = toApiUserType(saved);
      setWalkerType(apiType);
      setTempWalkerType(apiType);
    });
    getShowSlopeMarkers().then(setShowSlopeMarkersState);
  }, []);

  // 지도 위 % 버튼용 — 설정 화면과 같은 저장소를 써서 서로 값이 어긋나지 않게 한다.
  const handleToggleSlopeMarkers = () => {
    setShowSlopeMarkersState((prev) => {
      const next = !prev;
      setShowSlopeMarkers(next).catch(() => {});
      return next;
    });
  };

  const fromRef = useRef<TextInput>(null);
  const toRef = useRef<TextInput>(null);

  const currentWalker =
    WALKER_TYPES.find((walker) => walker.key === walkerType) ??
    WALKER_TYPES[0];

  const startEditing = (field: "from" | "to") => {
    setEditingField(field);

    setTimeout(() => {
      if (field === "from") {
        fromRef.current?.focus();
      } else {
        toRef.current?.focus();
      }
    }, 50);
  };

  const handleSwap = async () => {
    if (routeLoading) return;

    // 1) 표시 라벨 뒤집기
    setFrom(to);
    setTo(from);

    // 2) 실제 좌표·주소도 함께 뒤집기 (이게 빠져서 "안 눌리는" 것처럼 보였다)
    const swapped = {
      startName: endpoints.endName,
      startAddress: endpoints.endAddress,
      startLatitude: endpoints.endLatitude,
      startLongitude: endpoints.endLongitude,
      endName: endpoints.startName,
      endAddress: endpoints.startAddress,
      endLatitude: endpoints.startLatitude,
      endLongitude: endpoints.startLongitude,
    };
    setEndpoints(swapped);

    // 3) 뒤집힌 방향으로 경로 재탐색 (좌표 없으면 라벨만 바꾸고 종료)
    const hasCoords =
      swapped.startLatitude &&
      swapped.startLongitude &&
      swapped.endLatitude &&
      swapped.endLongitude;
    if (!hasCoords) return;

    try {
      setRouteLoading(true);
      const routeResult = await requestRoute({
        startLatitude: swapped.startLatitude!,
        startLongitude: swapped.startLongitude!,
        endLatitude: swapped.endLatitude!,
        endLongitude: swapped.endLongitude!,
        userType: walkerType,
        endStationName: swapped.endName,
      });
      setParsedRouteData(routeResult);
    } catch (error) {
      console.log("swap re-route error:", error);
      Alert.alert(
        "경로 재탐색 실패",
        "출발지·도착지를 바꾼 경로를 계산하지 못했습니다. 잠시 후 다시 시도해주세요."
      );
    } finally {
      setRouteLoading(false);
    }
  };

  const openWalkerModal = () => {
    setTempWalkerType(walkerType);
    setShowWalkerModal(true);
  };

  const confirmWalkerType = async () => {
    const nextType = tempWalkerType;
    setShowWalkerModal(false);

    if (nextType === walkerType) return;

    setWalkerType(nextType);
    // 길안내 화면의 변경을 마이페이지 기본값에도 그대로 반영한다.
    saveUserType(toKoreanUserType(nextType)).catch(() => {});

    const hasCoords =
      endpoints.startLatitude &&
      endpoints.startLongitude &&
      endpoints.endLatitude &&
      endpoints.endLongitude;

    if (!hasCoords) return;

    try {
      setRouteLoading(true);

      const routeResult = await requestRoute({
        startLatitude: endpoints.startLatitude!,
        startLongitude: endpoints.startLongitude!,
        endLatitude: endpoints.endLatitude!,
        endLongitude: endpoints.endLongitude!,
        userType: nextType,
        endStationName: endpoints.endName,
      });

      setParsedRouteData(routeResult);
    } catch (error) {
      console.log("route recompute error:", error);
      Alert.alert(
        "경로 재탐색 실패",
        "이동 유형 변경에 따른 경로를 다시 계산하지 못했습니다. 잠시 후 다시 시도해주세요."
      );
    } finally {
      setRouteLoading(false);
    }
  };

  const goBack = () => {
    if (navigation?.goBack) {
      navigation.goBack();
    }
  };

  const commonContentProps = {
    navigation,
    walkerType,
    from,
    to,
    showSlopeMarkers,
    onToggleSlopeMarkers: handleToggleSlopeMarkers,
    routeData: parsedRouteData,
    startName: endpoints.startName,
    startAddress: endpoints.startAddress,
    startLatitude: endpoints.startLatitude,
    startLongitude: endpoints.startLongitude,
    endName: endpoints.endName,
    endAddress: endpoints.endAddress,
    endLatitude: endpoints.endLatitude,
    endLongitude: endpoints.endLongitude,
  };

  const renderContent = () => {
    switch (activeTransport) {
      case "transit":
        return (
          <TransitContent
            {...commonContentProps}
            transitState={transitState}
          />
        );
      case "walk":
      default:
        return <WalkContent {...commonContentProps} />;
    }
  };

  const getTabTime = (tab: (typeof TRANSPORT_TABS)[number]) => {
    if (tab.key === "walk") {
      return getTimeText(parsedRouteData, tab.defaultTime);
    }

    if (tab.key === "transit") {
      return transitTimeMin != null ? formatMinutes(transitTimeMin) : tab.defaultTime;
    }

    return tab.defaultTime;
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={C.white} />

      {/* 헤더 */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={goBack}>
          <Ionicons name="chevron-back" size={26} color={NAVY} />
        </TouchableOpacity>

        <View style={styles.routeInfo}>
          <TouchableOpacity
            style={styles.routeRow}
            onPress={() => startEditing("from")}
            activeOpacity={0.75}
          >
            <View style={[styles.dot, styles.startDot]} />

            {editingField === "from" ? (
              <TextInput
                ref={fromRef}
                style={styles.routeInput}
                value={from}
                onChangeText={setFrom}
                onBlur={() => setEditingField(null)}
                returnKeyType="done"
                onSubmitEditing={() => setEditingField(null)}
                placeholder="출발지 입력"
                placeholderTextColor={C.textMute}
              />
            ) : (
              <Text style={styles.routeText} numberOfLines={1}>
                {from || "출발지를 입력하세요"}
              </Text>
            )}
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.routeRow}
            onPress={() => startEditing("to")}
            activeOpacity={0.75}
          >
            <View style={[styles.dot, styles.endDot]} />

            {editingField === "to" ? (
              <TextInput
                ref={toRef}
                style={styles.routeInput}
                value={to}
                onChangeText={setTo}
                onBlur={() => setEditingField(null)}
                returnKeyType="done"
                onSubmitEditing={() => setEditingField(null)}
                placeholder="도착지 입력"
                placeholderTextColor={C.textMute}
              />
            ) : (
              <Text style={styles.routeText} numberOfLines={1}>
                {to || "도착지를 입력하세요"}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.swapButton}
          onPress={handleSwap}
          disabled={routeLoading}
          activeOpacity={0.6}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="출발지와 도착지 바꾸기"
        >
          <Text style={styles.swapIcon}>⇅</Text>
        </TouchableOpacity>
      </View>

      {/* 보행자 맞춤경로 / 보행약자 유형 / 교통수단 탭 - 접기/펼치기 가능 */}
      <Animated.View
        style={{
          overflow: "hidden",
          opacity: panelAnim,
          height:
            panelHeight == null
              ? undefined
              : panelAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, panelHeight],
                }),
        }}
      >
        <View
          onLayout={(e) => {
            // 접힌 상태에서 애니메이션 도중 부모(overflow:hidden, 애니메이션 height)의
            // 중간값에 영향을 받아 onLayout이 다시 불리면 잘못된(작은) 높이로
            // 덮어써져서 다시 펼쳐도 그 작은 높이로만 늘어나는 버그가 있었다.
            // 최초 1회만 측정해서 고정한다.
            if (panelHeight == null) {
              setPanelHeight(e.nativeEvent.layout.height);
            }
          }}
        >
          {/* 경로 요약 */}
          <View style={styles.summaryCard}>
            <View>
              <Text style={styles.summaryLabel}>보행약자 맞춤 경로</Text>
              <Text style={styles.summaryTitle} numberOfLines={1}>
                {from} → {to}
              </Text>
            </View>

            <View style={styles.summaryBadge}>
              <Text style={styles.summaryBadgeText}>
                {getDistanceText(parsedRouteData)}
              </Text>
            </View>
          </View>

          {/* 보행자 유형 */}
          <View style={styles.walkerBar}>
            <View style={styles.walkerChip}>
              <Text style={styles.walkerIcon}>{currentWalker.icon}</Text>
              <Text style={styles.walkerLabel}>{currentWalker.label}</Text>
            </View>

            <TouchableOpacity
              style={styles.walkerChangeButton}
              onPress={openWalkerModal}
            >
              <Text style={styles.walkerChangeButtonText}>변경</Text>
            </TouchableOpacity>
          </View>

          {/* 교통수단 탭 */}
          <View style={styles.transportBar}>
            {TRANSPORT_TABS.map((tab) => {
              const isActive = activeTransport === tab.key;

              return (
                <TouchableOpacity
                  key={tab.key}
                  style={[styles.tab, isActive && styles.tabActive]}
                  onPress={() => setActiveTransport(tab.key)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.tabIcon}>{tab.icon}</Text>

                  <Text
                    style={[styles.tabTime, isActive && styles.tabTimeActive]}
                  >
                    {getTabTime(tab)}
                  </Text>

                  <Text
                    style={[styles.tabLabel, isActive && styles.tabLabelActive]}
                  >
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </Animated.View>

      {/* 접기/펼치기 핸들 */}
      <View style={styles.panelHandle} {...panelPanResponder.panHandlers}>
        <View style={styles.panelHandleBar} />
        <Text style={styles.panelHandleText}>
          {panelOpen ? "▲ 접기" : "▼ 펼치기"}
        </Text>
      </View>

      {/* 컨텐츠 */}
      <View style={styles.contentArea}>
        {renderContent()}

        {routeLoading && (
          <View style={styles.routeLoadingOverlay}>
            <ActivityIndicator size="large" color={NAVY} />
            <Text style={styles.routeLoadingText}>
              선택한 유형에 맞춰 경로를 다시 계산하고 있어요
            </Text>
          </View>
        )}
      </View>

      {/* 이동 유형 선택 모달 */}
      <Modal
        visible={showWalkerModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowWalkerModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowWalkerModal(false)}
        >
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <Text style={styles.modalTitle}>이동 유형 선택</Text>
            <Text style={styles.modalSubtitle}>
              본인의 이동 방식에 맞는 유형을 선택하세요
            </Text>

            <ScrollView
              style={styles.radioList}
              showsVerticalScrollIndicator={false}
            >
              {WALKER_TYPES.map((walker) => {
                const selected = tempWalkerType === walker.key;

                return (
                  <TouchableOpacity
                    key={walker.key}
                    style={[styles.radioRow, selected && styles.radioRowSelected]}
                    onPress={() => setTempWalkerType(walker.key)}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.radioTypeIcon}>{walker.icon}</Text>

                    <Text
                      style={[
                        styles.radioLabel,
                        selected && styles.radioLabelSelected,
                      ]}
                    >
                      {walker.label}
                    </Text>

                    <View
                      style={[
                        styles.radioCircle,
                        selected && styles.radioCircleSelected,
                      ]}
                    >
                      {selected && <View style={styles.radioCircleInner} />}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={styles.modalButtonRow}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => setShowWalkerModal(false)}
              >
                <Text style={styles.modalCancelText}>취소</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalConfirmButton}
                onPress={confirmWalkerType}
              >
                <Text style={styles.modalConfirmText}>확인</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: C.bg,
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.white,
    paddingTop: Platform.OS === "ios" ? 52 : 16,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },

  backButton: {
    width: 42,
    height: 42,
    borderRadius: 15,
    backgroundColor: C.bg,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },

  routeInfo: {
    flex: 1,
    backgroundColor: C.bg,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },

  routeRow: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
  },

  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    marginRight: 9,
  },

  startDot: {
    backgroundColor: C.success,
  },

  endDot: {
    backgroundColor: C.danger,
  },

  routeText: {
    flex: 1,
    fontSize: 15,
    fontWeight: "700",
    color: C.text,
  },

  routeInput: {
    flex: 1,
    height: 34,
    fontSize: 15,
    fontWeight: "700",
    color: C.text,
    paddingVertical: 0,
  },

  divider: {
    height: 1,
    backgroundColor: C.line,
    marginVertical: 5,
    marginLeft: 18,
  },

  swapButton: {
    width: 42,
    height: 42,
    borderRadius: 15,
    backgroundColor: C.bg,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 10,
  },

  swapIcon: {
    fontSize: 24,
    fontWeight: "800",
    color: NAVY,
  },

  summaryCard: {
    marginHorizontal: 16,
    marginTop: 14,
    backgroundColor: C.white,
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: C.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  summaryLabel: {
    fontSize: 12,
    color: C.textMute,
    fontWeight: "700",
  },

  summaryTitle: {
    marginTop: 5,
    maxWidth: 230,
    fontSize: 16,
    color: C.text,
    fontWeight: "800",
  },

  summaryBadge: {
    backgroundColor: NAVY,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },

  summaryBadgeText: {
    color: C.white,
    fontSize: 12,
    fontWeight: "800",
  },

  walkerBar: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: C.white,
    borderRadius: 18,
    padding: 12,
    borderWidth: 1,
    borderColor: C.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  walkerChip: {
    flexDirection: "row",
    alignItems: "center",
  },

  walkerIcon: {
    fontSize: 23,
    marginRight: 8,
  },

  walkerLabel: {
    fontSize: 15,
    fontWeight: "800",
    color: C.text,
  },

  walkerChangeButton: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: C.bg,
    justifyContent: "center",
    alignItems: "center",
  },

  walkerChangeButtonText: {
    fontSize: 13,
    fontWeight: "800",
    color: NAVY,
  },

  transportBar: {
    marginHorizontal: 16,
    marginTop: 12,
    flexDirection: "row",
    backgroundColor: C.white,
    borderRadius: 22,
    padding: 8,
    borderWidth: 1,
    borderColor: C.line,
  },

  tab: {
    flex: 1,
    borderRadius: 18,
    paddingVertical: 10,
    alignItems: "center",
  },

  tabActive: {
    backgroundColor: NAVY,
  },

  tabIcon: {
    fontSize: 22,
  },

  tabTime: {
    marginTop: 5,
    fontSize: 14,
    fontWeight: "800",
    color: C.text,
  },

  tabTimeActive: {
    color: C.white,
  },

  tabLabel: {
    marginTop: 3,
    fontSize: 12,
    fontWeight: "700",
    color: C.textMute,
  },

  tabLabelActive: {
    color: C.white,
  },

  contentArea: {
    flex: 1,
    marginTop: 10,
  },

  panelHandle: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    backgroundColor: C.white,
  },

  panelHandleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.line,
    marginBottom: 4,
  },

  panelHandleText: {
    fontSize: 11,
    fontWeight: "700",
    color: C.textMute,
  },

  routeLoadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.92)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
  },

  routeLoadingText: {
    marginTop: 14,
    fontSize: 14,
    fontWeight: "700",
    color: NAVY,
    textAlign: "center",
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.38)",
    justifyContent: "center",
    paddingHorizontal: 24,
  },

  modalCard: {
    backgroundColor: C.white,
    borderRadius: 28,
    padding: 22,
    maxHeight: "80%",
  },

  modalTitle: {
    fontSize: 22,
    fontWeight: "900",
    color: C.text,
    textAlign: "center",
  },

  modalSubtitle: {
    marginTop: 7,
    fontSize: 14,
    color: C.textMute,
    textAlign: "center",
  },

  radioList: {
    marginTop: 20,
  },

  radioRow: {
    minHeight: 58,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.bg,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    marginBottom: 10,
  },

  radioRowSelected: {
    borderColor: NAVY,
    backgroundColor: "rgba(27, 15, 74, 0.08)",
  },

  radioTypeIcon: {
    fontSize: 25,
    marginRight: 12,
  },

  radioLabel: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    color: C.text,
  },

  radioLabelSelected: {
    color: NAVY,
    fontWeight: "900",
  },

  radioCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: C.textMute,
    justifyContent: "center",
    alignItems: "center",
  },

  radioCircleSelected: {
    borderColor: NAVY,
  },

  radioCircleInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: NAVY,
  },

  modalButtonRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 18,
  },

  modalCancelButton: {
    flex: 1,
    height: 54,
    borderRadius: 18,
    backgroundColor: C.bg,
    justifyContent: "center",
    alignItems: "center",
  },

  modalCancelText: {
    fontSize: 16,
    fontWeight: "800",
    color: C.text,
  },

  modalConfirmButton: {
    flex: 1,
    height: 54,
    borderRadius: 18,
    backgroundColor: NAVY,
    justifyContent: "center",
    alignItems: "center",
  },

  modalConfirmText: {
    fontSize: 16,
    fontWeight: "800",
    color: C.white,
  },
});