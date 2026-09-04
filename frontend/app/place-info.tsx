import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons, Feather } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import { router, useLocalSearchParams } from "expo-router";
import { goHome } from "../src/utils/navigation";

const NAVY = "#1B0F4A";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const BUTTON_GRAY = "#9D9696";
const TEXT_GRAY = "#666666";

const KAKAO_JAVASCRIPT_KEY = process.env.EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY;

function getParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

export default function PlaceInfoScreen() {
  const params = useLocalSearchParams();

  const place = {
    id: getParam(params.id),
    name: getParam(params.name, "장소명 없음"),
    address: getParam(params.address, "주소 정보 없음"),
    phone: getParam(params.phone, "전화번호 정보 없음"),
    category: getParam(params.category, "카테고리 정보 없음"),
    placeUrl: getParam(params.placeUrl),
    latitude: Number(getParam(params.latitude, "37.5665")),
    longitude: Number(getParam(params.longitude, "126.978")),
  };

  const safePlaceName = place.name.replace(/'/g, "\\'");
  const safeAddress = place.address.replace(/'/g, "\\'");

  const kakaoMapHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0"
        />
        <style>
          html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
          }

          #map {
            width: 100%;
            height: 100%;
          }

          .info-window {
            padding: 8px 12px;
            font-size: 13px;
            font-weight: 700;
            color: #111;
            white-space: nowrap;
          }
        </style>
      </head>

      <body>
        <div id="map"></div>

        <script
          type="text/javascript"
          src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JAVASCRIPT_KEY}&autoload=false">
        </script>

        <script>
          kakao.maps.load(function () {
            var container = document.getElementById("map");

            var position = new kakao.maps.LatLng(${place.latitude}, ${place.longitude});

            var options = {
              center: position,
              level: 3
            };

            var map = new kakao.maps.Map(container, options);

            var marker = new kakao.maps.Marker({
              position: position
            });

            marker.setMap(map);

            var infowindow = new kakao.maps.InfoWindow({
              content: '<div class="info-window">${safePlaceName}</div>'
            });

            infowindow.open(map, marker);
          });
        </script>
      </body>
    </html>
  `;

  // 출발지/도착지 하나를 이 장소로 정하고 나면, route-select의 빈 필드를
  // 한 번 더 탭하게 하지 않고 바로 나머지 한쪽 검색 화면으로 이어간다.
  const goToRouteSelect = (type: "start" | "end") => {
    if (type === "start") {
      router.push({
        pathname: "/search",
        params: {
          mode: "route-end",
          startName: place.name,
          startAddress: place.address,
          startLatitude: String(place.latitude),
          startLongitude: String(place.longitude),
        },
      });
      return;
    }

    router.push({
      pathname: "/search",
      params: {
        mode: "route-start",
        endName: place.name,
        endAddress: place.address,
        endLatitude: String(place.latitude),
        endLongitude: String(place.longitude),
      },
    });
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

        <Text style={styles.headerTitle} numberOfLines={1}>
          {place.name}
        </Text>

        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={goHome}
        >
          <Ionicons name="close" size={28} color={NAVY} />
        </TouchableOpacity>
      </View>

      {/* 카카오 지도 */}
      <View style={styles.mapCard}>
        <WebView
          originWhitelist={["*"]}
          source={{ html: kakaoMapHtml }}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          mixedContentMode="always"
          style={styles.webView}
        />
      </View>

      {/* 장소 정보 패널 */}
      <View style={styles.infoPanel}>
        <View style={styles.panelHeader}>
          <View style={styles.titleBox}>
            <Text style={styles.placeName} numberOfLines={1}>
              {place.name}
            </Text>

            <Text style={styles.categoryText} numberOfLines={1}>
              {place.category}
            </Text>
          </View>

          <TouchableOpacity style={styles.shareButton}>
            <Feather name="share-2" size={23} color={NAVY} />
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionTitle}>장소정보</Text>

        <View style={styles.infoRow}>
          <Ionicons name="location-outline" size={19} color={NAVY} />
          <Text style={styles.infoText}>{place.address}</Text>
        </View>

        <View style={styles.infoRow}>
          <Ionicons name="call-outline" size={18} color={NAVY} />
          <Text style={styles.infoText}>{place.phone}</Text>
        </View>

        {place.placeUrl ? (
          <View style={styles.infoRow}>
            <Ionicons name="link-outline" size={18} color={NAVY} />
            <Text style={styles.infoText} numberOfLines={1}>
              {place.placeUrl}
            </Text>
          </View>
        ) : null}

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={styles.routeButton}
            activeOpacity={0.85}
            onPress={() => goToRouteSelect("start")}
          >
            <Ionicons name="flag" size={20} color="#FFFFFF" />
            <Text style={styles.routeButtonText}>출발</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.routeButton}
            activeOpacity={0.85}
            onPress={() => goToRouteSelect("end")}
          >
            <Ionicons name="location" size={20} color="#FFFFFF" />
            <Text style={styles.routeButtonText}>도착</Text>
          </TouchableOpacity>
        </View>
      </View>
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
    elevation: 5,
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 20,
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
    marginHorizontal: 12,
    fontSize: 19,
    fontWeight: "800",
    color: "#111111",
  },

  mapCard: {
    flex: 1,
    marginTop: 18,
    borderRadius: 26,
    overflow: "hidden",
    backgroundColor: LIGHT_GRAY,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    ...shadowStyle,
  },

  webView: {
    flex: 1,
    backgroundColor: LIGHT_GRAY,
  },

  infoPanel: {
    backgroundColor: "#FFFFFF",
    borderRadius: 26,
    padding: 20,
    marginTop: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    ...shadowStyle,
  },

  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
  },

  titleBox: {
    flex: 1,
  },

  placeName: {
    fontSize: 22,
    fontWeight: "800",
    color: "#111111",
  },

  categoryText: {
    marginTop: 5,
    fontSize: 13,
    color: TEXT_GRAY,
  },

  shareButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: LIGHT_GRAY,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 12,
  },

  sectionTitle: {
    marginTop: 20,
    fontSize: 16,
    fontWeight: "800",
    color: "#111111",
  },

  infoRow: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "flex-start",
  },

  infoText: {
    flex: 1,
    marginLeft: 8,
    fontSize: 14,
    lineHeight: 20,
    color: "#444444",
  },

  buttonRow: {
    flexDirection: "row",
    gap: 14,
    marginTop: 24,
  },

  routeButton: {
    flex: 1,
    height: 58,
    backgroundColor: BUTTON_GRAY,
    borderRadius: 18,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    alignItems: "center",
  },

  routeButtonText: {
    fontSize: 18,
    color: "#FFFFFF",
    fontWeight: "800",
  },
});