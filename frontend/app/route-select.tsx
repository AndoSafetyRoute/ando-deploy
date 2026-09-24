import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Alert,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { goHome } from "../src/utils/navigation";
import { requestRoute } from "../src/api/routeApi";
import { getUserType, toApiUserType } from "../src/utils/storage";
import { isWithinSlopeDataCoverage, SLOPE_DATA_WARNING } from "../src/utils/coverage";
import { resolveCurrentLocation } from "../src/utils/currentLocation";

const NAVY = "#1B0F4A";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT_GRAY = "#666666";
const BUTTON_GRAY = "#9D9696";

function getParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

type Endpoint = {
  name: string;
  address: string;
  latitude: string;
  longitude: string;
};

const emptyEndpoint: Endpoint = { name: "", address: "", latitude: "", longitude: "" };
const isFilled = (e: Endpoint) => !!e.name && !!e.latitude && !!e.longitude;

export default function RouteSelectScreen() {
  const params = useLocalSearchParams();

  // 검색 화면에서 넘어온 값(params)을 초기값으로, 이후엔 화면 로컬 상태로 관리한다.
  // 현위치 버튼은 /search 로 나갔다 오지 않고 이 상태만 갱신한다.
  const paramStart = useMemo<Endpoint>(() => ({
    name: getParam(params.startName),
    address: getParam(params.startAddress),
    latitude: getParam(params.startLatitude),
    longitude: getParam(params.startLongitude),
  }), [params.startName, params.startAddress, params.startLatitude, params.startLongitude]);

  const paramEnd = useMemo<Endpoint>(() => ({
    name: getParam(params.endName),
    address: getParam(params.endAddress),
    latitude: getParam(params.endLatitude),
    longitude: getParam(params.endLongitude),
  }), [params.endName, params.endAddress, params.endLatitude, params.endLongitude]);

  const [start, setStart] = useState<Endpoint>(paramStart);
  const [end, setEnd] = useState<Endpoint>(paramEnd);

  // /search 에서 장소를 고르고 돌아오면 params 가 바뀐다 → 그때만 상태에 반영한다.
  // (현위치 버튼은 params 를 안 건드리므로 여기서 덮어써지지 않는다.)
  useEffect(() => { setStart(paramStart); }, [paramStart]);
  useEffect(() => { setEnd(paramEnd); }, [paramEnd]);

  const [loading, setLoading] = useState(false);
  const [gpsField, setGpsField] = useState<null | "start" | "end">(null);

  const hasStart = isFilled(start);
  const hasEnd = isFilled(end);
  const canStartRoute = hasStart && hasEnd && !loading && gpsField === null;

  const outOfCoverage =
    (hasStart && !isWithinSlopeDataCoverage(start.latitude, start.longitude)) ||
    (hasEnd && !isWithinSlopeDataCoverage(end.latitude, end.longitude));

  const moveToSearch = (which: "start" | "end") => {
    // 현재 상태를 그대로 넘겨서, 한쪽을 현위치로 잡아둔 뒤 다른 쪽을 검색해도
    // 돌아왔을 때 현위치 값이 살아있게 한다.
    router.push({
      pathname: "/search",
      params: {
        mode: which === "start" ? "route-start" : "route-end",
        startName: start.name,
        startAddress: start.address,
        startLatitude: start.latitude,
        startLongitude: start.longitude,
        endName: end.name,
        endAddress: end.address,
        endLatitude: end.latitude,
        endLongitude: end.longitude,
      },
    });
  };

  const useCurrentLocationFor = async (which: "start" | "end") => {
    if (gpsField !== null || loading) return;
    setGpsField(which);
    try {
      const r = await resolveCurrentLocation();
      if (!r.ok || !r.location) {
        Alert.alert(
          r.reason === "permission" ? "위치 권한 필요" : "위치 확인 실패",
          r.reason === "permission"
            ? "현위치를 출발지·도착지로 쓰려면 위치 권한을 허용해 주세요."
            : "현재 위치를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요."
        );
        return;
      }
      const next: Endpoint = {
        name: r.location.name,
        address: r.location.address,
        latitude: String(r.location.latitude),
        longitude: String(r.location.longitude),
      };
      if (which === "start") setStart(next);
      else setEnd(next);
    } catch (e) {
      console.log("현위치 설정 실패:", e);
      Alert.alert("위치 확인 실패", "현재 위치를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setGpsField(null);
    }
  };

  const handleStartRoute = async () => {
    if (!hasStart || !hasEnd) {
      Alert.alert("경로 설정 필요", "출발지와 도착지를 모두 입력해주세요.");
      return;
    }

    try {
      setLoading(true);

      const savedUserType = await getUserType();

      const routeResult = await requestRoute({
        startLatitude: start.latitude,
        startLongitude: start.longitude,
        endLatitude: end.latitude,
        endLongitude: end.longitude,
        userType: toApiUserType(savedUserType),
        endStationName: end.name,
        startStationName: start.name,
      });

      router.push({
        pathname: "/route",
        params: {
          from: start.name,
          to: end.name,

          startName: start.name,
          startAddress: start.address,
          startLatitude: start.latitude,
          startLongitude: start.longitude,

          endName: end.name,
          endAddress: end.address,
          endLatitude: end.latitude,
          endLongitude: end.longitude,

          routeData: JSON.stringify(routeResult),
        },
      });
    } catch (error) {
      console.log("route api error:", error);
      Alert.alert(
        "경로 탐색 실패",
        "백엔드 경로 탐색 중 오류가 발생했습니다. 서버 주소와 실행 상태를 확인해주세요."
      );
    } finally {
      setLoading(false);
    }
  };

  const renderRow = (which: "start" | "end") => {
    const e = which === "start" ? start : end;
    const filled = which === "start" ? hasStart : hasEnd;
    const gpsBusy = gpsField === which;
    return (
      <View style={styles.routeRow}>
        <View style={[styles.dotIcon, which === "start" ? styles.startDot : styles.endDot]}>
          <Ionicons
            name={which === "start" ? "radio-button-on" : "location"}
            size={15}
            color="#FFFFFF"
          />
        </View>

        <View style={styles.routeTextBox}>
          <Text style={styles.routeLabel}>{which === "start" ? "출발" : "도착"}</Text>
          <Text
            style={[styles.routeText, filled && styles.selectedRouteText]}
            numberOfLines={1}
          >
            {filled ? e.name : which === "start" ? "출발지를 입력하세요" : "도착지를 입력하세요"}
          </Text>
          {filled && (
            <Text style={styles.addressText} numberOfLines={1}>
              {e.address || "주소 정보 없음"}
            </Text>
          )}
        </View>

        <TouchableOpacity
          style={styles.gpsButton}
          onPress={() => useCurrentLocationFor(which)}
          disabled={gpsField !== null || loading}
          accessibilityLabel={which === "start" ? "현위치를 출발지로" : "현위치를 도착지로"}
        >
          {gpsBusy ? (
            <ActivityIndicator size="small" color={NAVY} />
          ) : (
            <Ionicons name="locate" size={18} color={NAVY} />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.smallButton}
          onPress={() => moveToSearch(which)}
          disabled={gpsField !== null || loading}
        >
          <Text style={styles.smallButtonText}>{filled ? "변경" : "입력"}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerIconButton} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={NAVY} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>경로 설정</Text>
        <TouchableOpacity style={styles.headerIconButton} onPress={goHome}>
          <Ionicons name="close" size={28} color={NAVY} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.statusCard}>
          <View style={styles.statusIconBox}>
            <MaterialCommunityIcons name="map-marker-path" size={32} color="#FFFFFF" />
          </View>
          <Text style={styles.statusTitle}>
            {hasStart && hasEnd
              ? "출발지와 도착지가 설정되었습니다"
              : "경로 정보를 입력해 주세요"}
          </Text>
          <Text style={styles.statusPlace} numberOfLines={1}>
            {hasStart && hasEnd
              ? `${start.name} → ${end.name}`
              : hasStart
              ? "도착지를 추가로 입력해 주세요"
              : hasEnd
              ? "출발지를 추가로 입력해 주세요"
              : "각 칸의 📍 버튼으로 현위치를 잡거나, 입력을 눌러 검색하세요"}
          </Text>
        </View>

        <View style={styles.routeCard}>
          {renderRow("start")}
          <View style={styles.verticalLine} />
          {renderRow("end")}
        </View>

        {outOfCoverage && (
          <View style={styles.coverageWarningCard}>
            <Text style={styles.coverageWarningText}>{SLOPE_DATA_WARNING}</Text>
          </View>
        )}

        <View style={styles.optionCard}>
          <View style={styles.optionHeader}>
            <MaterialCommunityIcons name="walk" size={24} color={NAVY} />
            <Text style={styles.optionTitle}>보행 경로 안내</Text>
          </View>
          <Text style={styles.optionDescription}>
            출발지와 도착지를 모두 설정하면 거리 우선, 유형별 추천, 사용자
            맞춤형 경로 중 원하는 경로를 골라 안내받을 수 있어요.
          </Text>
        </View>

        <View style={styles.bottomArea}>
          <TouchableOpacity
            style={[styles.searchRouteButton, !canStartRoute && styles.disabledButton]}
            activeOpacity={0.85}
            disabled={!canStartRoute}
            onPress={handleStartRoute}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.searchRouteText}>길찾기</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.homeButton} activeOpacity={0.85} onPress={goHome}>
            <Text style={styles.homeButtonText}>홈으로 돌아가기</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const shadowStyle = Platform.select({
  ios: {
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  android: {
    elevation: 4,
  },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF", paddingHorizontal: 20 },
  scrollContent: { paddingBottom: 32 },

  header: { height: 62, marginTop: 18, flexDirection: "row", alignItems: "center" },
  headerIconButton: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: LIGHT_GRAY,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 20,
    fontWeight: "800",
    color: "#111111",
  },

  statusCard: {
    marginTop: 22,
    backgroundColor: NAVY,
    borderRadius: 28,
    paddingVertical: 28,
    paddingHorizontal: 22,
    alignItems: "center",
    ...shadowStyle,
  },
  statusIconBox: {
    width: 58,
    height: 58,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.18)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  statusTitle: { fontSize: 19, fontWeight: "800", color: "#FFFFFF", textAlign: "center" },
  statusPlace: {
    marginTop: 12,
    fontSize: 15,
    fontWeight: "600",
    color: "rgba(255,255,255,0.82)",
    maxWidth: "100%",
    textAlign: "center",
  },

  routeCard: {
    marginTop: 22,
    backgroundColor: "#FFFFFF",
    borderRadius: 26,
    paddingHorizontal: 18,
    paddingVertical: 18,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    ...shadowStyle,
  },
  routeRow: { minHeight: 74, flexDirection: "row", alignItems: "center" },
  dotIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },
  startDot: { backgroundColor: NAVY },
  endDot: { backgroundColor: BUTTON_GRAY },
  verticalLine: {
    width: 2,
    height: 24,
    backgroundColor: BORDER_GRAY,
    marginLeft: 16,
    marginVertical: 2,
  },
  routeTextBox: { flex: 1 },
  routeLabel: { fontSize: 13, fontWeight: "700", color: TEXT_GRAY },
  routeText: { marginTop: 5, fontSize: 16, fontWeight: "500", color: "#999999" },
  selectedRouteText: { color: "#111111", fontWeight: "800" },
  addressText: { marginTop: 4, fontSize: 12, color: TEXT_GRAY },

  gpsButton: {
    width: 40,
    height: 36,
    borderRadius: 12,
    backgroundColor: LIGHT_GRAY,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  smallButton: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: LIGHT_GRAY,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  smallButtonText: { fontSize: 13, fontWeight: "700", color: NAVY },

  optionCard: {
    marginTop: 18,
    backgroundColor: LIGHT_GRAY,
    borderRadius: 22,
    padding: 18,
  },
  coverageWarningCard: {
    marginTop: 16,
    backgroundColor: "#FFF4E5",
    borderRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "#F5C177",
  },
  coverageWarningText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#8A5A00",
    textAlign: "center",
    lineHeight: 20,
  },
  optionHeader: { flexDirection: "row", alignItems: "center" },
  optionTitle: { marginLeft: 8, fontSize: 16, fontWeight: "800", color: "#111111" },
  optionDescription: { marginTop: 10, fontSize: 14, lineHeight: 20, color: TEXT_GRAY },

  bottomArea: { marginTop: "auto", paddingBottom: 18 },
  searchRouteButton: {
    height: 62,
    backgroundColor: NAVY,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    ...shadowStyle,
  },
  disabledButton: { backgroundColor: "#C9C9C9" },
  searchRouteText: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
  homeButton: {
    height: 58,
    backgroundColor: BUTTON_GRAY,
    borderRadius: 20,
    marginTop: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  homeButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
});
