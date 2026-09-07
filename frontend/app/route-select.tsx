import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Platform,
  Alert,
  ActivityIndicator,
  ScrollView,
  Linking,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as Location from "expo-location";
import { requestRoute, RouteApiError } from "../src/api/routeApi";
import { getUserType, toApiUserType } from "../src/utils/storage";
import { isWithinSlopeDataCoverage, OUT_OF_SERVICE_AREA_MESSAGE } from "../src/utils/coverage";
import { goHome } from "../src/utils/navigation";

const NAVY = "#1B0F4A";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT_GRAY = "#666666";
const BUTTON_GRAY = "#9D9696";

const KAKAO_REST_API_KEY = process.env.EXPO_PUBLIC_KAKAO_REST_API_KEY;

function getParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

// 좌표 → 주소 문자열. 실패해도 좌표 자체는 이미 있으니 "현재 위치"로 표시만
// 하고 계속 진행한다(주소 못 붙여도 출발지로 쓰는 데는 지장 없음).
async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${lon}&y=${lat}`,
      { headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` } },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const doc = json.documents?.[0];
    return doc?.road_address?.address_name || doc?.address?.address_name || null;
  } catch {
    return null;
  }
}

export default function RouteSelectScreen() {
  const params = useLocalSearchParams();
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locatingEnd, setLocatingEnd] = useState(false);

  const startName = getParam(params.startName);
  const startAddress = getParam(params.startAddress);
  const startLatitude = getParam(params.startLatitude);
  const startLongitude = getParam(params.startLongitude);

  const endName = getParam(params.endName);
  const endAddress = getParam(params.endAddress);
  const endLatitude = getParam(params.endLatitude);
  const endLongitude = getParam(params.endLongitude);

  const hasStart = !!startName && !!startLatitude && !!startLongitude;
  const hasEnd = !!endName && !!endLatitude && !!endLongitude;

  // 서울 밖 좌표: 경사도뿐 아니라 라우팅 그래프 자체가 없어 거리 우선 경로도
  // 못 만든다 → 안내 문구만 띄우고 길찾기 시작을 막는다(에러 팝업 대신).
  const outOfCoverage =
    (hasStart && !isWithinSlopeDataCoverage(startLatitude, startLongitude)) ||
    (hasEnd && !isWithinSlopeDataCoverage(endLatitude, endLongitude));

  const canStartRoute = hasStart && hasEnd && !loading && !outOfCoverage;

  const moveToSearchForStart = () => {
    router.push({
      pathname: "/search",
      params: {
        mode: "route-start",

        startName,
        startAddress,
        startLatitude,
        startLongitude,

        endName,
        endAddress,
        endLatitude,
        endLongitude,
      },
    });
  };

  // "현재 위치" 버튼 — 검색 화면으로 안 보내고 바로 GPS를 찍어 출발지로 채운다.
  const useCurrentLocationAsStart = async () => {
    try {
      setLocating(true);

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("위치 권한 필요", "현재 위치를 출발지로 쓰려면 위치 권한을 허용해주세요.");
        return;
      }

      const providerStatus = await Location.getProviderStatusAsync();
      if (!providerStatus.locationServicesEnabled) {
        Alert.alert(
          "위치 서비스 꺼짐",
          "설정에서 위치 서비스를 켜주세요.",
          [
            { text: "설정 열기", onPress: () => Linking.openSettings() },
            { text: "취소", style: "cancel" },
          ]
        );
        return;
      }

      let coords: { latitude: number; longitude: number } | null = null;
      try {
        const loc: any = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]);
        coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      } catch {
        const last = await Location.getLastKnownPositionAsync({});
        if (last) coords = { latitude: last.coords.latitude, longitude: last.coords.longitude };
      }

      if (!coords) {
        Alert.alert("위치를 가져올 수 없습니다", "실외로 이동한 후 다시 시도해주세요.");
        return;
      }

      const address = await reverseGeocode(coords.latitude, coords.longitude);

      router.replace({
        pathname: "/route-select",
        params: {
          startName: "현재 위치",
          startAddress: address ?? "",
          startLatitude: String(coords.latitude),
          startLongitude: String(coords.longitude),

          endName,
          endAddress,
          endLatitude,
          endLongitude,
        },
      });
    } catch (err: any) {
      Alert.alert("위치를 가져올 수 없습니다", err?.message ?? "잠시 후 다시 시도해주세요.");
    } finally {
      setLocating(false);
    }
  };

  // 출발지 GPS 버튼과 동일 — 도착지를 현재 위치로 채운다(3-2: 실효성 있어 도착지에도 적용).
  const useCurrentLocationAsEnd = async () => {
    try {
      setLocatingEnd(true);

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("위치 권한 필요", "현재 위치를 도착지로 쓰려면 위치 권한을 허용해주세요.");
        return;
      }

      const providerStatus = await Location.getProviderStatusAsync();
      if (!providerStatus.locationServicesEnabled) {
        Alert.alert(
          "위치 서비스 꺼짐",
          "설정에서 위치 서비스를 켜주세요.",
          [
            { text: "설정 열기", onPress: () => Linking.openSettings() },
            { text: "취소", style: "cancel" },
          ]
        );
        return;
      }

      let coords: { latitude: number; longitude: number } | null = null;
      try {
        const loc: any = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]);
        coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      } catch {
        const last = await Location.getLastKnownPositionAsync({});
        if (last) coords = { latitude: last.coords.latitude, longitude: last.coords.longitude };
      }

      if (!coords) {
        Alert.alert("위치를 가져올 수 없습니다", "실외로 이동한 후 다시 시도해주세요.");
        return;
      }

      const address = await reverseGeocode(coords.latitude, coords.longitude);

      router.replace({
        pathname: "/route-select",
        params: {
          startName,
          startAddress,
          startLatitude,
          startLongitude,

          endName: "현재 위치",
          endAddress: address ?? "",
          endLatitude: String(coords.latitude),
          endLongitude: String(coords.longitude),
        },
      });
    } catch (err: any) {
      Alert.alert("위치를 가져올 수 없습니다", err?.message ?? "잠시 후 다시 시도해주세요.");
    } finally {
      setLocatingEnd(false);
    }
  };

  const moveToSearchForEnd = () => {
    router.push({
      pathname: "/search",
      params: {
        mode: "route-end",

        startName,
        startAddress,
        startLatitude,
        startLongitude,

        endName,
        endAddress,
        endLatitude,
        endLongitude,
      },
    });
  };

  const handleStartRoute = async () => {
    if (!hasStart || !hasEnd) {
      Alert.alert("경로 설정 필요", "출발지와 도착지를 모두 입력해주세요.");
      return;
    }

    if (outOfCoverage) {
      Alert.alert("서비스 지역이 아닙니다", OUT_OF_SERVICE_AREA_MESSAGE);
      return;
    }

    try {
      setLoading(true);

      const savedUserType = await getUserType();

      const routeResult = await requestRoute({
        startLatitude,
        startLongitude,
        endLatitude,
        endLongitude,
        userType: toApiUserType(savedUserType),
        endStationName: endName,
      });

      router.push({
        pathname: "/route",
        params: {
          from: startName,
          to: endName,

          startName,
          startAddress,
          startLatitude,
          startLongitude,

          endName,
          endAddress,
          endLatitude,
          endLongitude,

          routeData: JSON.stringify(routeResult),
        },
      });
    } catch (error) {
      console.log("route api error:", error);
      if (error instanceof RouteApiError && error.code === "out_of_service_area") {
        // bbox 사전 검사를 통과했지만(대략치) 실제 그래프 범위 밖인 경우 —
        // 스크리한 실패 팝업 대신 같은 안내 문구로 처리한다.
        Alert.alert("서비스 지역이 아닙니다", OUT_OF_SERVICE_AREA_MESSAGE);
      } else {
        Alert.alert(
          "경로 탐색 실패",
          "백엔드 경로 탐색 중 오류가 발생했습니다. 서버 주소와 실행 상태를 확인해주세요."
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* 상단 헤더 */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={() => router.back()}
        >
          <Ionicons name="chevron-back" size={28} color={NAVY} />
        </TouchableOpacity>

        <Text style={styles.headerTitle}>경로 설정</Text>

        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={goHome}
        >
          <Ionicons name="close" size={28} color={NAVY} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
      {/* 안내 카드 */}
      <View style={styles.statusCard}>
        <View style={styles.statusIconBox}>
          <MaterialCommunityIcons
            name="map-marker-path"
            size={32}
            color="#FFFFFF"
          />
        </View>

        <Text style={styles.statusTitle}>
          {hasStart && hasEnd
            ? "출발지와 도착지가 설정되었습니다"
            : "경로 정보를 입력해 주세요"}
        </Text>

        <Text style={styles.statusPlace} numberOfLines={1}>
          {hasStart && hasEnd
            ? `${startName} → ${endName}`
            : hasStart
            ? "도착지를 추가로 입력해 주세요"
            : hasEnd
            ? "출발지를 추가로 입력해 주세요"
            : "출발지와 도착지를 입력해 주세요"}
        </Text>
      </View>

      {/* 출발/도착 입력 카드 */}
      <View style={styles.routeCard}>
        <View style={styles.routeRow}>
          <View style={[styles.dotIcon, styles.startDot]}>
            <Ionicons name="radio-button-on" size={15} color="#FFFFFF" />
          </View>

          <View style={styles.routeTextBox}>
            <Text style={styles.routeLabel}>출발</Text>

            <Text
              style={[styles.routeText, hasStart && styles.selectedRouteText]}
              numberOfLines={1}
            >
              {hasStart ? startName : "출발지를 입력하세요"}
            </Text>

            {hasStart && (
              <Text style={styles.addressText} numberOfLines={1}>
                {startAddress || "주소 정보 없음"}
              </Text>
            )}
          </View>

          <View style={styles.startButtonGroup}>
            <TouchableOpacity
              style={[styles.smallButton, styles.currentLocationButton]}
              onPress={useCurrentLocationAsStart}
              disabled={locating}
            >
              {locating ? (
                <ActivityIndicator size="small" color={NAVY} />
              ) : (
                <Ionicons name="locate" size={18} color={NAVY} />
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.smallButton}
              onPress={moveToSearchForStart}
            >
              <Text style={styles.smallButtonText}>
                {hasStart ? "변경" : "입력"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.verticalLine} />

        <View style={styles.routeRow}>
          <View style={[styles.dotIcon, styles.endDot]}>
            <Ionicons name="location" size={15} color="#FFFFFF" />
          </View>

          <View style={styles.routeTextBox}>
            <Text style={styles.routeLabel}>도착</Text>

            <Text
              style={[styles.routeText, hasEnd && styles.selectedRouteText]}
              numberOfLines={1}
            >
              {hasEnd ? endName : "도착지를 입력하세요"}
            </Text>

            {hasEnd && (
              <Text style={styles.addressText} numberOfLines={1}>
                {endAddress || "주소 정보 없음"}
              </Text>
            )}
          </View>

          <View style={styles.startButtonGroup}>
            <TouchableOpacity
              style={[styles.smallButton, styles.currentLocationButton]}
              onPress={useCurrentLocationAsEnd}
              disabled={locatingEnd}
            >
              {locatingEnd ? (
                <ActivityIndicator size="small" color={NAVY} />
              ) : (
                <Ionicons name="locate" size={18} color={NAVY} />
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.smallButton}
              onPress={moveToSearchForEnd}
            >
              <Text style={styles.smallButtonText}>
                {hasEnd ? "변경" : "입력"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* 서비스 지역(서울) 밖 안내 — 길찾기 시작은 위 canStartRoute 에서 비활성화됨 */}
      {outOfCoverage && (
        <View style={styles.coverageWarningCard}>
          <Text style={styles.coverageWarningText}>{OUT_OF_SERVICE_AREA_MESSAGE}</Text>
        </View>
      )}

      {/* 경로 옵션 카드 */}
      <View style={styles.optionCard}>
        <View style={styles.optionHeader}>
          <MaterialCommunityIcons name="walk" size={24} color={NAVY} />
          <Text style={styles.optionTitle}>보행 경로 안내</Text>
        </View>

        <Text style={styles.optionDescription}>
          6가지 유형별 추천 경로를 경사도에 따라 제공합니다.
        </Text>
      </View>

      <View style={styles.bottomArea}>
        <TouchableOpacity
          style={[
            styles.searchRouteButton,
            !canStartRoute && styles.disabledButton,
          ]}
          activeOpacity={0.85}
          disabled={!canStartRoute}
          onPress={handleStartRoute}
        >
          {loading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.searchRouteText}>길찾기 시작</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.homeButton}
          activeOpacity={0.85}
          onPress={goHome}
        >
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
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 20,
  },

  scrollContent: {
    paddingBottom: 32,
  },

  header: {
    height: 62,
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
  },

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

  statusTitle: {
    fontSize: 19,
    fontWeight: "800",
    color: "#FFFFFF",
    textAlign: "center",
  },

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

  routeRow: {
    minHeight: 74,
    flexDirection: "row",
    alignItems: "center",
  },

  dotIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },

  startDot: {
    backgroundColor: NAVY,
  },

  endDot: {
    backgroundColor: BUTTON_GRAY,
  },

  verticalLine: {
    width: 2,
    height: 24,
    backgroundColor: BORDER_GRAY,
    marginLeft: 16,
    marginVertical: 2,
  },

  routeTextBox: {
    flex: 1,
  },

  routeLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: TEXT_GRAY,
  },

  routeText: {
    marginTop: 5,
    fontSize: 16,
    fontWeight: "500",
    color: "#999999",
  },

  selectedRouteText: {
    color: "#111111",
    fontWeight: "800",
  },

  addressText: {
    marginTop: 4,
    fontSize: 12,
    color: TEXT_GRAY,
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

  smallButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: NAVY,
  },

  startButtonGroup: {
    flexDirection: "row",
    alignItems: "center",
  },

  currentLocationButton: {
    paddingHorizontal: 0,
    width: 36,
    marginLeft: 8,
  },

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

  optionHeader: {
    flexDirection: "row",
    alignItems: "center",
  },

  optionTitle: {
    marginLeft: 8,
    fontSize: 16,
    fontWeight: "800",
    color: "#111111",
  },

  optionDescription: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 20,
    color: TEXT_GRAY,
  },

  bottomArea: {
    marginTop: "auto",
    paddingBottom: 18,
  },

  searchRouteButton: {
    height: 62,
    backgroundColor: NAVY,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    ...shadowStyle,
  },

  disabledButton: {
    backgroundColor: "#C9C9C9",
  },

  searchRouteText: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "800",
  },

  homeButton: {
    height: 58,
    backgroundColor: BUTTON_GRAY,
    borderRadius: 20,
    marginTop: 12,
    justifyContent: "center",
    alignItems: "center",
  },

  homeButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
});