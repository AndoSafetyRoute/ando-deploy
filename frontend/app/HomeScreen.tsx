import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { WebView } from "react-native-webview";
import { router } from "expo-router";
import { goHome } from "../src/utils/navigation";
import { createClient } from "@supabase/supabase-js";
import * as Location from "expo-location";

const KAKAO_JAVASCRIPT_KEY = process.env.EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY;
const KAKAO_REST_API_KEY = process.env.EXPO_PUBLIC_KAKAO_REST_API_KEY;

const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
);

// 지도 위에 표시할 카테고리 목록.
// 새 카테고리를 추가하려면 이 배열에 항목만 추가하면 된다 (배리어프리, 경사로, 엘리베이터 등 확장 예정).
// icon 값은 @expo/vector-icons 의 MaterialCommunityIcons 아이콘 이름이다.
const CATEGORIES = [
  {
    id: "wheelchair-charge",
    label: "휠체어 충전소",
    icon: "wheelchair-accessibility" as const,
  },
  { id: "cafe", label: "카페", icon: "coffee" as const },
  { id: "restaurant", label: "음식점", icon: "silverware-fork-knife" as const },
  // 추후 확장 예: { id: "barrier-free", label: "배리어프리", icon: "human-wheelchair" },
];

// 카페/음식점은 서울 전역으로 치면 수만~수십만 개라 충전소처럼 통째로 DB에
// 담아두고 한 번에 불러오는 방식은 못 쓴다. 대신 카카오 로컬 API로 지도 중심
// 주변만 그때그때 조회한다(카카오 REST 키는 이미 대중교통 API에도 쓰던 것 재사용).
const CATEGORY_GROUP_CODES: Record<string, string> = {
  cafe: "CE7",
  restaurant: "FD6",
};

// 지도가 처음 여는 중심 좌표와 동일하게 맞춘다. 지도를 실제로 움직였을 때
// 그 위치 기준으로 재검색하는 기능은 아직 없어서, 우선 이 좌표 주변으로 고정 검색한다.
const MAP_DEFAULT_CENTER = { lat: 37.553149, lng: 126.968881 };
const NEARBY_SEARCH_RADIUS_M = 1500;

type MapPlace = {
  name: string;
  lat: number;
  lng: number;
  address: string;
  hours?: string;
  hasAirPump?: boolean;
  hasPhoneCharger?: boolean;
  category?: string;
  phone?: string;
};

async function fetchWheelchairChargers(): Promise<MapPlace[]> {
  const { data, error } = await supabase
    .from("charging_stations")
    .select("name, lat, lng, address_road, operating_hours, has_air_pump, has_phone_charger");

  if (error) throw error;

  return (data ?? []).map((row) => ({
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    address: row.address_road,
    hours: row.operating_hours,
    hasAirPump: row.has_air_pump,
    hasPhoneCharger: row.has_phone_charger,
  }));
}

async function fetchNearbyPlaces(categoryGroupCode: string): Promise<MapPlace[]> {
  const results: MapPlace[] = [];

  for (let page = 1; page <= 3; page++) {
    const url =
      `https://dapi.kakao.com/v2/local/search/category.json` +
      `?category_group_code=${categoryGroupCode}` +
      `&x=${MAP_DEFAULT_CENTER.lng}&y=${MAP_DEFAULT_CENTER.lat}` +
      `&radius=${NEARBY_SEARCH_RADIUS_M}&sort=distance&page=${page}`;

    const response = await fetch(url, {
      headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` },
    });

    if (!response.ok) {
      throw new Error(`카카오 장소 검색 실패: ${response.status}`);
    }

    const json = await response.json();
    const documents: any[] = json.documents ?? [];

    results.push(
      ...documents.map((doc) => ({
        name: doc.place_name,
        lat: Number(doc.y),
        lng: Number(doc.x),
        address: doc.road_address_name || doc.address_name,
        category: doc.category_name,
        phone: doc.phone || undefined,
      })),
    );

    if (json.meta?.is_end ?? true) break;
  }

  return results;
}

function fetchPlacesForCategory(categoryId: string): Promise<MapPlace[]> {
  if (categoryId === "wheelchair-charge") return fetchWheelchairChargers();

  const groupCode = CATEGORY_GROUP_CODES[categoryId];
  if (groupCode) return fetchNearbyPlaces(groupCode);

  return Promise.resolve([]);
}

export default function HomeScreen() {
  const [searchText, setSearchText] = useState("");
  // 선택된 카테고리 id (없으면 null). 같은 칩을 다시 누르면 해제된다.
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  // 카테고리별로 한 번 불러온 결과는 다시 선택해도 재조회하지 않고 캐시에서 쓴다.
  const [placesCache, setPlacesCache] = useState<Record<string, MapPlace[]>>({});
  const webviewRef = useRef<WebView>(null);

  const toggleCategory = (id: string) => {
    setSelectedCategory((prev) => (prev === id ? null : id));
  };

  // 선택된 카테고리가 처음 선택될 때 한 번만 데이터를 불러온다.
  useEffect(() => {
    if (!selectedCategory || placesCache[selectedCategory]) return;

    fetchPlacesForCategory(selectedCategory)
      .then((data) => {
        console.log(`${selectedCategory} 장소 개수:`, data.length);
        setPlacesCache((prev) => ({ ...prev, [selectedCategory]: data }));
      })
      .catch((e) => {
        console.log("장소 조회 오류:", e);
        Alert.alert("오류", "장소 정보를 불러오지 못했습니다.");
      });
  }, [selectedCategory]);

  // 선택된 카테고리에 해당하는 장소들을 지도에 마커로 표시하고, 해제되면 지운다.
  useEffect(() => {
    const places = selectedCategory ? placesCache[selectedCategory] : undefined;

    if (selectedCategory && places && places.length > 0) {
      webviewRef.current?.injectJavaScript(
        `if (window.showCategoryMarkers) { window.showCategoryMarkers(${JSON.stringify(places)}); } true;`,
      );
    } else if (!selectedCategory) {
      webviewRef.current?.injectJavaScript(
        `if (window.clearCategoryMarkers) { window.clearCategoryMarkers(); } true;`,
      );
    }
  }, [selectedCategory, placesCache]);

  // 홈 화면 자체엔 연관검색어 자동완성을 따로 구현하지 않고, 검색창을 누르면
  // 바로 search.tsx로 넘어가서 그쪽에서만 타이핑하게 한다 — 입력 UI를 두 곳에
  // 중복 구현하지 않고, 자동완성도 한 군데(search.tsx)에서만 관리하기 위함.
  const moveToSearchScreen = () => {
    router.push({ pathname: "/search", params: {} });
  };

  const moveToMyLocation = async () => {
    try {
      console.log("[GPS] 현위치 버튼 눌림");

      const { status } = await Location.requestForegroundPermissionsAsync();
      console.log("[GPS] 권한 상태:", status);
      if (status !== "granted") {
        Alert.alert("위치 권한 필요", "현재 위치를 보려면 위치 권한을 허용해주세요.");
        return;
      }

      const providerStatus = await Location.getProviderStatusAsync();
      console.log("[GPS] 위치 서비스:", JSON.stringify(providerStatus));
      if (!providerStatus.locationServicesEnabled) {
        Alert.alert(
          "위치 서비스 꺼짐",
          "설정에서 위치 서비스를 켜주세요.\n(갤럭시 기기: 설정 → 위치 → 사용 중 + 위치 서비스 → Google 위치 정확도 켜기)",
          [
            { text: "설정 열기", onPress: () => Linking.openSettings() },
            { text: "취소", style: "cancel" },
          ]
        );
        return;
      }

      let coords: { latitude: number; longitude: number } | null = null;
      try {
        console.log("[GPS] getCurrentPositionAsync 시작");
        const loc: any = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]);
        coords = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
        console.log("[GPS] 현위치 수신:", coords.latitude, coords.longitude, "정확도:", loc.coords.accuracy);
      } catch (err: any) {
        console.log("[GPS] getCurrentPositionAsync 실패, 마지막 위치로 폴백:", err?.message ?? err);
        const last = await Location.getLastKnownPositionAsync({});
        if (last) {
          coords = { latitude: last.coords.latitude, longitude: last.coords.longitude };
          console.log("[GPS] 마지막 위치 사용:", coords.latitude, coords.longitude);
        }
      }

      if (!coords) {
        Alert.alert("위치를 가져올 수 없습니다", "실외로 이동한 후 다시 시도해주세요.");
        return;
      }

      webviewRef.current?.injectJavaScript(
        `if (window.moveToLocation) { window.moveToLocation(${coords.latitude}, ${coords.longitude}); } true;`
      );
    } catch (err: any) {
      console.log("[GPS] 에러:", err?.message ?? err);
      Alert.alert("위치를 가져올 수 없습니다", "잠시 후 다시 시도해주세요.");
    }
  };

  const kakaoMapHtml = useMemo(() => `
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

            var center = new kakao.maps.LatLng(37.553149, 126.968881);

            var options = {
              center: center,
              level: 4
            };

            var map = new kakao.maps.Map(container, options);

            var marker = new kakao.maps.Marker({
              position: center
            });

            marker.setMap(map);

            // ── 카테고리 마커: React 쪽에서 injectJavaScript 로 호출한다 ──
            var categoryMarkers = [];
            var categoryInfo = new kakao.maps.InfoWindow({ removable: true });

            window.showCategoryMarkers = function (list) {
              window.clearCategoryMarkers();
              if (!list || list.length === 0) return;

              var bounds = new kakao.maps.LatLngBounds();

              list.forEach(function (p) {
                var pos = new kakao.maps.LatLng(p.lat, p.lng);
                var m = new kakao.maps.Marker({ position: pos });
                m.setMap(map);

                (function (place, mk) {
                  kakao.maps.event.addListener(mk, "click", function () {
                    var badges = '';
                    if (place.hasAirPump) badges += '<span style="display:inline-block;margin-right:4px;padding:2px 6px;background:#E8F0FF;color:#1B0F4A;border-radius:10px;font-size:11px;font-weight:600;">공기주입</span>';
                    if (place.hasPhoneCharger) badges += '<span style="display:inline-block;padding:2px 6px;background:#E8F0FF;color:#1B0F4A;border-radius:10px;font-size:11px;font-weight:600;">휴대폰충전</span>';

                    categoryInfo.setContent(
                      '<div style="padding:12px 14px;min-width:190px;max-width:250px;font-family:sans-serif;border-radius:12px;">' +
                        '<div style="font-size:14px;font-weight:700;color:#1B0F4A;margin-bottom:5px;">' + place.name + '</div>' +
                        (place.category ? '<div style="font-size:11px;color:#1B7A5A;margin-bottom:4px;">' + place.category + '</div>' : '') +
                        (place.address ? '<div style="font-size:11px;color:#888;margin-bottom:4px;">' + place.address + '</div>' : '') +
                        (place.hours ? '<div style="font-size:11px;color:#555;margin-bottom:6px;">' + place.hours + '</div>' : '') +
                        (place.phone ? '<div style="font-size:11px;color:#555;margin-bottom:4px;">' + place.phone + '</div>' : '') +
                        (badges ? '<div style="margin-top:4px;">' + badges + '</div>' : '') +
                      '</div>'
                    );
                    categoryInfo.open(map, mk);
                  });
                })(p, m);

                categoryMarkers.push(m);
                bounds.extend(pos);
              });

              map.setBounds(bounds, 100);
            };

            window.clearCategoryMarkers = function () {
              categoryMarkers.forEach(function (m) {
                m.setMap(null);
              });
              categoryMarkers = [];
              categoryInfo.close();
            };

            // ── 현위치 마커: "현위치" 버튼 눌렀을 때 React 쪽에서 호출 ──
            var myLocationMarker = null;
            window.moveToLocation = function (lat, lng) {
              var pos = new kakao.maps.LatLng(lat, lng);
              map.setLevel(3);
              map.setCenter(pos);
              if (myLocationMarker) myLocationMarker.setMap(null);
              myLocationMarker = new kakao.maps.Marker({ position: pos });
              myLocationMarker.setMap(map);
            };
          });
        </script>
      </body>
    </html>
  `, []);

  return (
    <SafeAreaView style={styles.container}>
      {/* 검색창 — 실제 입력은 search.tsx에서만 이뤄지고, 여기는 그 화면으로
          넘어가는 버튼 역할만 한다(연관검색어를 두 군데서 따로 구현하지 않기 위함). */}
      <TouchableOpacity
        style={styles.searchBox}
        activeOpacity={0.8}
        onPress={moveToSearchScreen}
      >
        <Ionicons name="location-outline" size={24} color={NAVY} />

        <Text style={[styles.searchPlaceholder, { color: "#8A8A8A" }]} numberOfLines={1}>
          장소 검색
        </Text>

        <View style={styles.searchButton}>
          <Ionicons name="search" size={24} color="#FFFFFF" />
        </View>
      </TouchableOpacity>

      {/* 카테고리 칩 영역 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.categoryRow}
        contentContainerStyle={styles.categoryRowContent}
      >
        {CATEGORIES.map((category) => {
          const isSelected = selectedCategory === category.id;
          return (
            <TouchableOpacity
              key={category.id}
              style={[styles.categoryChip, isSelected && styles.categoryChipSelected]}
              onPress={() => toggleCategory(category.id)}
              activeOpacity={0.8}
            >
              <MaterialCommunityIcons
                name={category.icon}
                size={18}
                color={isSelected ? "#FFFFFF" : NAVY}
              />
              <Text
                style={[styles.categoryLabel, isSelected && styles.categoryLabelSelected]}
              >
                {category.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* 카카오 지도 영역 */}
      <View style={styles.mapCard}>
        <WebView
          ref={webviewRef}
          originWhitelist={["*"]}
          source={{ html: kakaoMapHtml }}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          mixedContentMode="always"
          style={styles.webView}
        />
      </View>

      {/* 하단 네비게이션 */}
      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={[styles.navButton, styles.activeNavButton]}
          onPress={goHome}
        >
          <Ionicons name="home" size={30} color="#FFFFFF" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={() => router.push("/bookmark")}
        >
          <Feather name="bookmark" size={29} color={NAVY} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={moveToMyLocation}
        >
          <MaterialCommunityIcons name="crosshairs-gps" size={32} color={NAVY} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={() => router.push("/settings")}
        >
          <Ionicons name="settings-outline" size={31} color={NAVY} />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const NAVY = "#1B0F4A";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 20,
  },

  searchBox: {
    height: 62,
    backgroundColor: "#FFFFFF",
    marginTop: 18,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 18,
    paddingRight: 10,
    borderWidth: 1,
    borderColor: BORDER_GRAY,

    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.12,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 4 },
      },
      android: {
        elevation: 5,
      },
    }),
  },

  searchInput: {
    flex: 1,
    height: "100%",
    fontSize: 16,
    color: "#111111",
    paddingHorizontal: 12,
  },

  // searchInput(TextInput 전용, height:100%)을 Text에 그대로 쓰면 안드로이드에서
  // 텍스트가 세로 중앙이 아니라 박스 위쪽에 붙어 보인다 — 검색창이 버튼으로
  // 바뀌면서 생긴 자리 표시자 텍스트 전용 스타일.
  searchPlaceholder: {
    flex: 1,
    fontSize: 16,
    paddingHorizontal: 12,
  },

  searchButton: {
    width: 44,
    height: 44,
    borderRadius: 16,
    backgroundColor: NAVY,
    justifyContent: "center",
    alignItems: "center",
  },

  categoryRow: {
    flexGrow: 0,
    marginTop: 14,
  },

  categoryRowContent: {
    alignItems: "center",
    paddingRight: 8,
  },

  categoryChip: {
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderRadius: 20,
    marginRight: 10,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: BORDER_GRAY,
  },

  categoryChipSelected: {
    backgroundColor: NAVY,
    borderColor: NAVY,
  },

  categoryLabel: {
    marginLeft: 6,
    fontSize: 14,
    fontWeight: "600",
    color: NAVY,
  },

  categoryLabelSelected: {
    color: "#FFFFFF",
  },

  mapCard: {
    flex: 1,
    marginTop: 18,
    marginBottom: 18,
    borderRadius: 26,
    overflow: "hidden",
    backgroundColor: LIGHT_GRAY,
    borderWidth: 1,
    borderColor: BORDER_GRAY,

    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.1,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 5 },
      },
      android: {
        elevation: 4,
      },
    }),
  },

  webView: {
    flex: 1,
    backgroundColor: LIGHT_GRAY,
  },

  bottomNav: {
    height: 82,
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    marginBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: BORDER_GRAY,

    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.14,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 5 },
      },
      android: {
        elevation: 8,
      },
    }),
  },

  navButton: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: "#F6F6F8",
    justifyContent: "center",
    alignItems: "center",
  },

  activeNavButton: {
    backgroundColor: NAVY,
  },
});
