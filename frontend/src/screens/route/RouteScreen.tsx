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
import { resolveCurrentLocation } from "../../utils/currentLocation";

const KAKAO_REST_API_KEY = process.env.EXPO_PUBLIC_KAKAO_REST_API_KEY;

type GeoPlace = { name: string; address: string; latitude: string; longitude: string };

// 카카오 키워드 검색 → 후보 목록. size 개까지.
async function geocodeKeywordList(query: string, size = 6): Promise<GeoPlace[]> {
  const q = query.trim();
  if (!q || !KAKAO_REST_API_KEY) return [];
  try {
    const res = await fetch(
      "https://dapi.kakao.com/v2/local/search/keyword.json?query=" +
        encodeURIComponent(q) + `&size=${size}`,
      { headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.documents ?? []).map((d: any) => ({
      name: d.place_name || q,
      address: d.road_address_name || d.address_name || "",
      latitude: String(d.y),
      longitude: String(d.x),
    }));
  } catch {
    return [];
  }
}

// 첫 결과만 (엔터/포커스아웃 폴백용).
async function geocodeKeyword(query: string): Promise<GeoPlace | null> {
  const list = await geocodeKeywordList(query, 1);
  return list[0] ?? null;
}

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
  { key: "general", label: "일반", icon: "🧍" },
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

function getEstimatedTimeSeconds(routeData: any): number | null {
  if (!routeData) return null;

  const recommendedRoute = getRecommendedRoute(routeData);

  const seconds =
    recommendedRoute?.estimatedTimeS ??
    routeData?.estimatedTimeS;

  const n = Number(seconds);

  return Number.isFinite(n) && n > 0 ? n : null;
}

function getTimeText(routeData: any, fallback: string) {
  if (!routeData) return fallback;

  // 백엔드가 이동유형별 속도(estimate_route_time)로 이미 계산해 보내주는 값을
  // 우선 쓴다 — 여기서 "거리/60(=1m/s 가정)"으로 따로 계산하면 휠체어 등
  // 실제 속도와 달라서 경로가 바뀔 때마다 엉뚱한 분으로 보일 수 있었다.
  const estimatedSeconds = getEstimatedTimeSeconds(routeData);
  if (estimatedSeconds !== null) {
    return formatMinutes(estimatedSeconds / 60);
  }

  const distanceNumber = getDistanceNumber(routeData);

  if (distanceNumber === null) return fallback;

  // 보행 기준: 약 1m/s = 60m/min
  const minute = Math.max(1, Math.round(distanceNumber / 60));

  return formatMinutes(minute);
}

// 대중교통 경로를 못 찾았을 때("정확한 경로 없음")도 실제로 갈 방법이 없는 건
// 아니므로, 하드코딩된 placeholder 대신 같은 출발/도착의 '최단 거리' 도보
// 시간을 대신 보여준다 — 없으면 유형별(메인) 경로 시간으로 한 번 더 폴백한다.
function getShortestRouteTimeText(routeData: any, fallback: string) {
  if (!routeData) return fallback;

  const routesList = Array.isArray(routeData.routes) ? routeData.routes : [];
  const shortestRoute = routesList.find((r: any) => r.id === "shortest");

  const seconds = Number(shortestRoute?.estimatedTimeS);
  if (Number.isFinite(seconds) && seconds > 0) {
    return formatMinutes(seconds / 60);
  }

  return getTimeText(routeData, fallback);
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
  const [suggestions, setSuggestions] = useState<GeoPlace[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const pickingRef = useRef(false); // 추천 항목 탭 중에는 onBlur 지오코딩을 건너뛴다
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
        startStationName: swapped.startName,
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

  // 출발/도착 한쪽의 좌표가 바뀌면 → 그 방향으로 경로를 다시 계산한다.
  // 계산 동안 화면 가운데 "재탐색 중" 오버레이(routeLoading)가 뜬다.
  const applyEndpointAndReroute = async (
    field: "from" | "to",
    ep: { name: string; address: string; latitude: string; longitude: string }
  ) => {
    if (routeLoading) return;
    const next =
      field === "from"
        ? { ...endpoints, startName: ep.name, startAddress: ep.address, startLatitude: ep.latitude, startLongitude: ep.longitude }
        : { ...endpoints, endName: ep.name, endAddress: ep.address, endLatitude: ep.latitude, endLongitude: ep.longitude };
    setEndpoints(next);
    if (field === "from") setFrom(ep.name);
    else setTo(ep.name);
    setEditingField(null);

    if (!next.startLatitude || !next.startLongitude || !next.endLatitude || !next.endLongitude) return;
    try {
      setRouteLoading(true);
      const routeResult = await requestRoute({
        startLatitude: next.startLatitude!,
        startLongitude: next.startLongitude!,
        endLatitude: next.endLatitude!,
        endLongitude: next.endLongitude!,
        userType: walkerType,
        endStationName: next.endName,
        startStationName: next.startName,
      });
      setParsedRouteData(routeResult);
    } catch (error) {
      console.log("endpoint re-route error:", error);
      Alert.alert("경로 재탐색 실패", "바뀐 지점으로 경로를 계산하지 못했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setRouteLoading(false);
    }
  };

  // 편집 중인 칸의 텍스트로 연관검색어(추천 장소) 목록을 디바운스 조회한다.
  useEffect(() => {
    if (!editingField) { setSuggestions([]); return; }
    const q = (editingField === "from" ? from : to).trim();
    const prevName = editingField === "from" ? endpoints.startName : endpoints.endName;
    if (!q || q === prevName) { setSuggestions([]); return; }
    let alive = true;
    setSuggestLoading(true);
    const t = setTimeout(async () => {
      const list = await geocodeKeywordList(q, 6);
      if (!alive) return;
      setSuggestions(list);
      setSuggestLoading(false);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [editingField, from, to, endpoints.startName, endpoints.endName]);

  // 추천 목록에서 한 곳을 고름 → 그 좌표로 재탐색.
  const pickSuggestion = async (field: "from" | "to", place: GeoPlace) => {
    pickingRef.current = true;
    setSuggestions([]);
    setEditingField(null);
    if (field === "from") setFrom(place.name); else setTo(place.name);
    await applyEndpointAndReroute(field, place);
    setTimeout(() => { pickingRef.current = false; }, 300);
  };

  // 텍스트 입력 확정(엔터 or 포커스 아웃) → 카카오로 지오코딩 후 재탐색.
  // 추천 항목을 탭한 경우(pickingRef)엔 건너뛴다. 재진입도 ref 로 막는다.
  const committingRef = useRef(false);
  const commitFieldEdit = async (field: "from" | "to") => {
    if (committingRef.current || pickingRef.current) return;
    const typed = (field === "from" ? from : to).trim();
    const prevName = field === "from" ? endpoints.startName : endpoints.endName;
    setEditingField(null);
    setSuggestions([]);
    if (!typed || typed === prevName) return;

    committingRef.current = true;
    try {
      setRouteLoading(true);
      const geo = await geocodeKeyword(typed);
      if (!geo) {
        setRouteLoading(false);
        Alert.alert("장소를 찾지 못했어요", `'${typed}' 검색 결과가 없어요. 다른 이름으로 시도해 주세요.`);
        if (field === "from") setFrom(prevName ?? "");
        else setTo(prevName ?? "");
        return;
      }
      await applyEndpointAndReroute(field, geo); // 내부에서 setRouteLoading(false)
    } finally {
      committingRef.current = false;
    }
  };

  // 각 칸의 현위치(GPS) 버튼 → 현 위치로 그 지점을 잡고 즉시 재탐색.
  const useGpsForField = async (field: "from" | "to") => {
    if (routeLoading) return;
    setRouteLoading(true);
    const r = await resolveCurrentLocation();
    setRouteLoading(false);
    if (!r.ok || !r.location) {
      Alert.alert(
        r.reason === "permission" ? "위치 권한 필요" : "위치 확인 실패",
        r.reason === "permission"
          ? "현위치를 쓰려면 위치 권한을 허용해 주세요."
          : "현재 위치를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요."
      );
      return;
    }
    await applyEndpointAndReroute(field, {
      name: r.location.name,
      address: r.location.address,
      latitude: String(r.location.latitude),
      longitude: String(r.location.longitude),
    });
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
        startStationName: endpoints.startName,
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
      // 계산 중에는 31분류 placeholder나 최단거리 대체값을 보여주면 "이미 계산된
      // 값"처럼 보인다 — 계산이 끝나기 전까지는 로딩중임을 분명히 표시한다.
      if (hasCoordsForTransit && transitState.loading) return "계산 중";

      return transitTimeMin != null
        ? formatMinutes(transitTimeMin)
        : getShortestRouteTimeText(parsedRouteData, tab.defaultTime);
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
                onBlur={() => commitFieldEdit("from")}
                returnKeyType="search"
                onSubmitEditing={() => commitFieldEdit("from")}
                placeholder="출발지 입력 후 검색"
                placeholderTextColor={C.textMute}
              />
            ) : (
              <Text style={styles.routeText} numberOfLines={1}>
                {from || "출발지를 입력하세요"}
              </Text>
            )}
            <TouchableOpacity
              onPress={() => useGpsForField("from")}
              disabled={routeLoading}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="현위치를 출발지로"
            >
              <Ionicons name="locate" size={18} color={routeLoading ? C.textMute : NAVY} />
            </TouchableOpacity>
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
                onBlur={() => commitFieldEdit("to")}
                returnKeyType="search"
                onSubmitEditing={() => commitFieldEdit("to")}
                placeholder="도착지 입력 후 검색"
                placeholderTextColor={C.textMute}
              />
            ) : (
              <Text style={styles.routeText} numberOfLines={1}>
                {to || "도착지를 입력하세요"}
              </Text>
            )}
            <TouchableOpacity
              onPress={() => useGpsForField("to")}
              disabled={routeLoading}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="현위치를 도착지로"
            >
              <Ionicons name="locate" size={18} color={routeLoading ? C.textMute : NAVY} />
            </TouchableOpacity>
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

      {/* 연관검색어(추천 장소) 목록 — 출발/도착 칸을 편집 중일 때 */}
      {editingField && (suggestLoading || suggestions.length > 0) && (
        <View style={styles.suggestBox}>
          {suggestLoading && suggestions.length === 0 ? (
            <View style={styles.suggestRow}>
              <ActivityIndicator size="small" color={NAVY} />
              <Text style={styles.suggestName}>  검색 중…</Text>
            </View>
          ) : (
            suggestions.map((s, i) => (
              <TouchableOpacity
                key={`${s.latitude},${s.longitude},${i}`}
                style={styles.suggestRow}
                activeOpacity={0.7}
                onPressIn={() => { pickingRef.current = true; }}
                onPress={() => pickSuggestion(editingField, s)}
              >
                <Ionicons name="location-outline" size={16} color={C.textMute} />
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={styles.suggestName} numberOfLines={1}>{s.name}</Text>
                  {!!s.address && (
                    <Text style={styles.suggestAddr} numberOfLines={1}>{s.address}</Text>
                  )}
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>
      )}

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
              {/* 입력 중 텍스트(from/to)가 아니라 "검색 완료된" 값(endpoints)을 보여준다 —
                  글자 칠 때마다 여기가 흔들리지 않게. */}
              <Text style={styles.summaryTitle} numberOfLines={1}>
                {(endpoints.startName || from)} → {(endpoints.endName || to)}
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

      {/* 재탐색 오버레이 — 헤더까지 화면 전체를 덮어 현재 경로를 고정한 채 로딩 표시 */}
      {routeLoading && (
        <View style={styles.routeLoadingOverlay} pointerEvents="auto">
          <ActivityIndicator size="large" color={NAVY} />
          <Text style={styles.routeLoadingText}>
            경로를 다시 계산하고 있어요
          </Text>
        </View>
      )}
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

  suggestBox: {
    backgroundColor: C.white,
    marginHorizontal: 16,
    marginTop: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.line,
    overflow: "hidden",
  },
  suggestRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  suggestName: {
    fontSize: 14,
    fontWeight: "700",
    color: C.text,
  },
  suggestAddr: {
    marginTop: 2,
    fontSize: 11.5,
    color: C.textMute,
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