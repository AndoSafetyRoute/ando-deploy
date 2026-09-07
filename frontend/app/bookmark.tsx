import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity,
  Platform, Alert, FlatList, ActivityIndicator, Linking,
} from "react-native";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { goHome } from "../src/utils/navigation";
import * as Location from "expo-location";
import { WebView } from "react-native-webview";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getBookmarks, addBookmark, removeBookmark,
  syncBookmarksFromServer, BookmarkItem,
} from "../src/utils/storage";

const NAVY        = "#1B0F4A";
const PRIMARY     = "#7C6FF7";
const LIGHT_GRAY  = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT_GRAY   = "#666666";

const KAKAO_JAVASCRIPT_KEY = process.env.EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY;
const KAKAO_REST_API_KEY   = process.env.EXPO_PUBLIC_KAKAO_REST_API_KEY;

type SearchResult = {
  id:        string;
  name:      string;
  address:   string;
  phone:     string;
  category:  string;
  latitude:  number;
  longitude: number;
};

const shadowStyle = Platform.select({
  ios:     { shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  android: { elevation: 4 },
});

// GPS를 못 가져왔을 때만 쓰는 폴백 지도 중심(서울시청 인근). 정상 상황에선
// 마운트 시 자동으로 받아온 실제 현위치로 지도를 옮긴다. (HomeScreen 과 동일 패턴)
const MAP_FALLBACK_CENTER = { latitude: 37.553149, longitude: 126.968881 };

// 화면 진입 시 조용히 현위치를 한 번 받아온다 — 실패해도 alert 없이 null.
async function autoLocateOnMount(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;
    const providerStatus = await Location.getProviderStatusAsync();
    if (!providerStatus.locationServicesEnabled) return null;
    try {
      const loc: any = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
      return { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
    } catch {
      const last = await Location.getLastKnownPositionAsync({});
      return last ? { latitude: last.coords.latitude, longitude: last.coords.longitude } : null;
    }
  } catch (e: any) {
    console.log("[GPS] 책갈피 자동 위치 조회 실패(무시):", e?.message ?? e);
    return null;
  }
}

export default function BookmarkScreen() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);

  const [bookmarks, setBookmarks]           = useState<BookmarkItem[]>([]);
  const [bookmarkedIds, setBookmarkedIds]   = useState<Set<string>>(new Set());
  const [selectedPlace, setSelectedPlace]   = useState<BookmarkItem | null>(null);

  const [searchText, setSearchText]         = useState("");
  const [searchResults, setSearchResults]   = useState<SearchResult[]>([]);
  const [searching, setSearching]           = useState(false);
  const [showSearch, setShowSearch]         = useState(false);

  // 마운트 시 자동으로 받아온 현위치. 못 받으면 null → 지도는 MAP_FALLBACK_CENTER.
  const [currentCoords, setCurrentCoords]   = useState<{ latitude: number; longitude: number } | null>(null);
  // WebView 안 카카오맵 로드 완료 신호 — 그 전에 injectJavaScript 하면 무시된다.
  const [mapLoaded, setMapLoaded]           = useState(false);

  // 연관 검색어 — search.tsx와 동일하게 타이핑 중 디바운스 자동조회.
  // 실패해도 조용히 무시(Alert 없음), 응답이 늦게 와서 이미 검색어가
  // 바뀐 경우(searchSeqRef 불일치)엔 결과를 버린다.
  const searchSeqRef = useRef(0);

  useEffect(() => { loadBookmarks(); }, []);

  // 화면 진입 시 1회, 조용히 현위치 시도 → 지도 중심을 현위치로.
  useEffect(() => {
    autoLocateOnMount().then((coords) => { if (coords) setCurrentCoords(coords); });
  }, []);

  // 현위치를 받았고 지도 로드도 끝났으면 지도를 현위치로 이동(파란 점 마커 포함).
  useEffect(() => {
    if (currentCoords && mapLoaded) {
      webViewRef.current?.injectJavaScript(
        `if (window.moveToCurrentLocation) { window.moveToCurrentLocation(${currentCoords.latitude}, ${currentCoords.longitude}); } true;`
      );
    }
  }, [currentCoords, mapLoaded]);

  const loadBookmarks = async () => {
    // 로컬 캐시 즉시 표시
    const local = await getBookmarks();
    setBookmarks(local);
    setBookmarkedIds(new Set(local.map(b => b.id)));
    // 서버에서 최신 데이터 동기화 (백그라운드)
    syncBookmarksFromServer().then(async () => {
      const synced = await getBookmarks();
      setBookmarks(synced);
      setBookmarkedIds(new Set(synced.map(b => b.id)));
    }).catch(() => {});
  };

  const moveMapTo = (lat: number, lng: number) => {
    webViewRef.current?.injectJavaScript(`
      (function() {
        if (window.kakaoMap) {
          var pos = new kakao.maps.LatLng(${lat}, ${lng});
          window.kakaoMap.panTo(pos);
          window.kakaoMap.setLevel(3);
          if (window.selMarker) window.selMarker.setMap(null);
          window.selMarker = new kakao.maps.Marker({ position: pos, map: window.kakaoMap });
        }
      })();
      true;
    `);
  };

  // "현위치" 버튼 — 사용자가 직접 눌렀을 때는 권한/서비스 거부 이유를 알려준다.
  const moveToCurrentLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("위치 권한 필요", "현재 위치를 보려면 위치 권한을 허용해주세요.");
        return;
      }
      const providerStatus = await Location.getProviderStatusAsync();
      if (!providerStatus.locationServicesEnabled) {
        Alert.alert("위치 서비스 꺼짐", "설정에서 위치 서비스를 켜주세요.", [
          { text: "설정 열기", onPress: () => Linking.openSettings() },
          { text: "취소", style: "cancel" },
        ]);
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
      setSelectedPlace(null);
      setCurrentCoords(coords);
      webViewRef.current?.injectJavaScript(
        `if (window.moveToCurrentLocation) { window.moveToCurrentLocation(${coords.latitude}, ${coords.longitude}); } true;`
      );
    } catch (err: any) {
      Alert.alert("위치를 가져올 수 없습니다", "잠시 후 다시 시도해주세요.");
    }
  };

  const handleSelectBookmark = (item: BookmarkItem) => {
    setSelectedPlace(prev => prev?.id === item.id ? null : item);
    moveMapTo(item.latitude, item.longitude);
  };

  const handleNavigateToPlace = (place: BookmarkItem) => {
    router.push({
      pathname: "/route-select",
      params: {
        endName:      place.name,
        endAddress:   place.address,
        endLatitude:  String(place.latitude),
        endLongitude: String(place.longitude),
      },
    });
  };

  const handleAddBookmark = async (place: SearchResult) => {
    const item: BookmarkItem = {
      id:        place.id,
      name:      place.name,
      address:   place.address,
      latitude:  place.latitude,
      longitude: place.longitude,
      category:  place.category,
      phone:     place.phone !== "전화번호 정보 없음" ? place.phone : undefined,
      createdAt: Date.now(),
    };
    await addBookmark(item);
    await loadBookmarks();
  };

  const handleRemoveBookmark = (id: string) => {
    Alert.alert("즐겨찾기 삭제", "이 장소를 즐겨찾기에서 삭제하시겠습니까?", [
      { text: "취소", style: "cancel" },
      {
        text: "삭제", style: "destructive",
        onPress: async () => {
          await removeBookmark(id);
          if (selectedPlace?.id === id) setSelectedPlace(null);
          await loadBookmarks();
        },
      },
    ]);
  };

  const handleSearch = async () => {
    const q = searchText.trim();
    if (!q) return;
    if (!KAKAO_REST_API_KEY) {
      Alert.alert("API 키 없음", ".env에 EXPO_PUBLIC_KAKAO_REST_API_KEY를 설정해주세요.");
      return;
    }
    try {
      setSearching(true);
      setShowSearch(true);
      const res = await fetch(
        `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=10`,
        { headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` } }
      );
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      setSearchResults(
        data.documents.map((item: any) => ({
          id:        item.id,
          name:      item.place_name,
          address:   item.road_address_name || item.address_name || "주소 없음",
          phone:     item.phone || "전화번호 정보 없음",
          category:  item.category_name || "",
          latitude:  Number(item.y),
          longitude: Number(item.x),
        }))
      );
    } catch {
      Alert.alert("검색 실패", "장소 검색 중 오류가 발생했습니다.");
    } finally {
      setSearching(false);
    }
  };

  const searchPlacesQuiet = async (query: string) => {
    if (!KAKAO_REST_API_KEY) return;
    const seq = ++searchSeqRef.current;
    try {
      setSearching(true);
      const res = await fetch(
        `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=10`,
        { headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` } }
      );
      if (!res.ok || seq !== searchSeqRef.current) return;
      const data = await res.json();
      if (seq !== searchSeqRef.current) return;
      setSearchResults(
        data.documents.map((item: any) => ({
          id:        item.id,
          name:      item.place_name,
          address:   item.road_address_name || item.address_name || "주소 없음",
          phone:     item.phone || "전화번호 정보 없음",
          category:  item.category_name || "",
          latitude:  Number(item.y),
          longitude: Number(item.x),
        }))
      );
    } catch {
      // 타이핑 중 일시적 오류는 조용히 무시
    } finally {
      if (seq === searchSeqRef.current) setSearching(false);
    }
  };

  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed.length === 0) {
      setShowSearch(false);
      setSearchResults([]);
      return;
    }
    setShowSearch(true);
    if (trimmed.length < 2) return; // 한 글자는 결과가 너무 광범위함

    const timer = setTimeout(() => { searchPlacesQuiet(trimmed); }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const clearSearch = () => {
    setSearchText("");
    setShowSearch(false);
    setSearchResults([]);
  };

  const kakaoMapHtml = `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0"/>
  <style>html,body,#map{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}</style>
</head><body>
  <div id="map"></div>
  <script type="text/javascript" src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JAVASCRIPT_KEY}&autoload=false"></script>
  <script>
    kakao.maps.load(function(){
      window.kakaoMap = new kakao.maps.Map(document.getElementById('map'),{
        center: new kakao.maps.LatLng(${MAP_FALLBACK_CENTER.latitude},${MAP_FALLBACK_CENTER.longitude}), level:5
      });

      // ── 현위치: React 쪽에서 GPS 좌표를 받아 지도를 이동시킨다 (파란 점 마커) ──
      window.myLocationMarker = null;
      window.moveToCurrentLocation = function (lat, lng) {
        var pos = new kakao.maps.LatLng(lat, lng);
        if (!window.myLocationMarker) {
          window.myLocationMarker = new kakao.maps.Marker({
            image: new kakao.maps.MarkerImage(
              'data:image/svg+xml;base64,' + btoa(
                '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26">' +
                  '<circle cx="13" cy="13" r="8" fill="#1B7AFF" stroke="#FFFFFF" stroke-width="3"/>' +
                '</svg>'
              ),
              new kakao.maps.Size(26, 26)
            )
          });
        }
        window.myLocationMarker.setPosition(pos);
        window.myLocationMarker.setMap(window.kakaoMap);
        window.kakaoMap.setCenter(pos);
        window.kakaoMap.setLevel(3);
      };
    });
  </script>
</body></html>`;

  const renderSearchResult = ({ item }: { item: SearchResult }) => {
    const saved = bookmarkedIds.has(item.id);
    return (
      <View style={styles.card}>
        <View style={styles.cardIconBox}>
          <Ionicons name="location" size={20} color="#FFFFFF" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardName}>{item.name}</Text>
          <Text style={styles.cardAddr}>{item.address}</Text>
          {!!item.category && <Text style={styles.cardCat}>{item.category}</Text>}
          {item.phone !== "전화번호 정보 없음" && (
            <Text style={styles.cardPhone}>{item.phone}</Text>
          )}
        </View>
        <TouchableOpacity
          style={styles.bookmarkBtn}
          onPress={async () => {
            if (saved) {
              handleRemoveBookmark(item.id);
            } else {
              await handleAddBookmark(item);
            }
          }}
        >
          <Ionicons
            name={saved ? "bookmark" : "bookmark-outline"}
            size={24}
            color={saved ? PRIMARY : "#B0B0B0"}
          />
        </TouchableOpacity>
      </View>
    );
  };

  const renderBookmarkItem = ({ item }: { item: BookmarkItem }) => {
    const isSelected = selectedPlace?.id === item.id;
    return (
      <TouchableOpacity
        style={[styles.card, isSelected && styles.selectedCard]}
        activeOpacity={0.8}
        onPress={() => handleSelectBookmark(item)}
      >
        <View style={[styles.cardIconBox, isSelected && styles.selectedCardIconBox]}>
          <Ionicons name="location" size={20} color="#FFFFFF" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardName, isSelected && { color: "#FFFFFF" }]}>{item.name}</Text>
          <Text style={[styles.cardAddr, isSelected && { color: "rgba(255,255,255,0.8)" }]}>{item.address}</Text>
          {!!item.category && (
            <Text style={[styles.cardCat, isSelected && { color: "rgba(255,255,255,0.65)" }]}>{item.category}</Text>
          )}
          {!!item.phone && (
            <Text style={[styles.cardPhone, isSelected && { color: "rgba(255,255,255,0.8)" }]}>{item.phone}</Text>
          )}
          {isSelected && (
            <TouchableOpacity
              style={styles.navToBtn}
              onPress={() => handleNavigateToPlace(item)}
            >
              <MaterialCommunityIcons name="map-marker-path" size={16} color={NAVY} />
              <Text style={styles.navToBtnText}>경로 탐색</Text>
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity onPress={() => handleRemoveBookmark(item.id)} style={{ padding: 4 }}>
          <Ionicons name="trash-outline" size={20} color={isSelected ? "rgba(255,255,255,0.6)" : "#CCCCCC"} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* 헤더 */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerIconBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={NAVY} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>즐겨찾기</Text>
        <TouchableOpacity style={styles.headerIconBtn} onPress={goHome}>
          <Ionicons name="home-outline" size={24} color={NAVY} />
        </TouchableOpacity>
      </View>

      {/* 검색 바 */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={20} color="#777" />
          <TextInput
            style={styles.searchInput}
            placeholder="장소 검색 후 즐겨찾기 추가"
            placeholderTextColor="#999"
            value={searchText}
            onChangeText={setSearchText}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
          {searchText.length > 0 && (
            <TouchableOpacity onPress={clearSearch}>
              <Ionicons name="close-circle" size={18} color="#A0A0A0" />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={styles.searchBtn} onPress={handleSearch}>
          <Text style={styles.searchBtnText}>검색</Text>
        </TouchableOpacity>
      </View>

      {showSearch ? (
        /* ── 검색 결과 뷰 ── */
        <View style={{ flex: 1 }}>
          <TouchableOpacity style={styles.backRow} onPress={clearSearch}>
            <Ionicons name="chevron-back" size={16} color={PRIMARY} />
            <Text style={styles.backRowText}>즐겨찾기 목록으로</Text>
          </TouchableOpacity>

          {searching ? (
            <View style={styles.centerBox}>
              <ActivityIndicator size="large" color={NAVY} />
              <Text style={styles.loadingText}>검색 중...</Text>
            </View>
          ) : (
            <FlatList
              data={searchResults}
              keyExtractor={item => item.id}
              renderItem={renderSearchResult}
              contentContainerStyle={{ paddingTop: 8, paddingBottom: 140 }}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <View style={styles.centerBox}>
                  <Ionicons name="search-circle-outline" size={52} color="#CCC" />
                  <Text style={styles.emptyText}>검색 결과가 없습니다</Text>
                </View>
              }
            />
          )}
        </View>
      ) : (
        /* ── 지도 + 즐겨찾기 목록 뷰 ── */
        <>
          {/* 카카오 지도 */}
          <View style={styles.mapCard}>
            <WebView
              ref={webViewRef}
              originWhitelist={["*"]}
              source={{ html: kakaoMapHtml }}
              javaScriptEnabled
              domStorageEnabled
              mixedContentMode="always"
              onLoadEnd={() => setMapLoaded(true)}
              style={{ flex: 1 }}
            />

            {/* 현위치 버튼 — 지도를 현재 GPS 위치로 이동 */}
            <TouchableOpacity
              style={styles.gpsButton}
              activeOpacity={0.85}
              onPress={moveToCurrentLocation}
            >
              <MaterialCommunityIcons name="crosshairs-gps" size={22} color={NAVY} />
            </TouchableOpacity>

            {selectedPlace && (
              <View style={styles.mapInfoBar}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.mapInfoName} numberOfLines={1}>{selectedPlace.name}</Text>
                  <Text style={styles.mapInfoAddr} numberOfLines={1}>{selectedPlace.address}</Text>
                </View>
                <TouchableOpacity style={styles.routeBtn} onPress={() => handleNavigateToPlace(selectedPlace)}>
                  <Text style={styles.routeBtnText}>경로 탐색</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          <Text style={styles.sectionTitle}>즐겨찾기 목록</Text>

          <FlatList
            data={bookmarks}
            keyExtractor={item => item.id}
            renderItem={renderBookmarkItem}
            contentContainerStyle={{ paddingTop: 4, paddingBottom: 140 }}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={styles.centerBox}>
                <Ionicons name="bookmark-outline" size={52} color={BORDER_GRAY} />
                <Text style={styles.emptyText}>
                  {"즐겨찾기한 장소가 없습니다\n위 검색창에서 장소를 추가하세요"}
                </Text>
              </View>
            }
          />
        </>
      )}

      {/* 하단 네비게이션 */}
      <View style={[styles.bottomNav, { bottom: 14 + insets.bottom }]}>
        <TouchableOpacity style={styles.navButton} onPress={goHome}>
          <Ionicons name="home-outline" size={30} color={NAVY} />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.navButton, styles.activeNavButton]}>
          <Feather name="bookmark" size={29} color="#FFFFFF" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={moveToCurrentLocation}>
          <MaterialCommunityIcons name="crosshairs-gps" size={32} color={NAVY} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={() => router.push("/settings")}>
          <Ionicons name="settings-outline" size={31} color={NAVY} />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

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

  headerIconBtn: {
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

  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 14,
    gap: 8,
  },

  searchBox: {
    flex: 1,
    height: 48,
    borderRadius: 16,
    backgroundColor: LIGHT_GRAY,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
  },

  searchInput: {
    flex: 1,
    height: "100%",
    marginLeft: 8,
    fontSize: 15,
    color: "#111",
  },

  searchBtn: {
    height: 48,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: NAVY,
    justifyContent: "center",
    alignItems: "center",
  },

  searchBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#FFFFFF",
  },

  backRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
  },

  backRowText: {
    fontSize: 14,
    fontWeight: "600",
    color: PRIMARY,
    marginLeft: 4,
  },

  mapCard: {
    height: 210,
    marginTop: 14,
    borderRadius: 22,
    overflow: "hidden",
    backgroundColor: LIGHT_GRAY,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    ...shadowStyle,
  },

  gpsButton: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    ...shadowStyle,
  },

  mapInfoBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(27,15,74,0.92)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },

  mapInfoName: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFFFFF",
  },

  mapInfoAddr: {
    fontSize: 12,
    color: "rgba(255,255,255,0.75)",
    marginTop: 2,
  },

  routeBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginLeft: 10,
  },

  routeBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFFFFF",
  },

  sectionTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: "#111111",
    marginTop: 18,
    marginBottom: 10,
  },

  card: {
    flexDirection: "row",
    backgroundColor: "#FFFFFF",
    padding: 14,
    borderRadius: 18,
    marginBottom: 10,
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    ...shadowStyle,
  },

  selectedCard: {
    backgroundColor: NAVY,
    borderColor: NAVY,
  },

  cardIconBox: {
    width: 40,
    height: 40,
    backgroundColor: NAVY,
    borderRadius: 13,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
    flexShrink: 0,
  },

  selectedCardIconBox: {
    backgroundColor: "rgba(255,255,255,0.18)",
  },

  cardName: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111111",
  },

  cardAddr: {
    fontSize: 12,
    color: TEXT_GRAY,
    marginTop: 3,
  },

  cardCat: {
    fontSize: 11,
    color: PRIMARY,
    fontWeight: "600",
    marginTop: 4,
  },

  cardPhone: {
    fontSize: 11,
    color: TEXT_GRAY,
    marginTop: 3,
  },

  navToBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 10,
    alignSelf: "flex-start",
  },

  navToBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: NAVY,
    marginLeft: 4,
  },

  bookmarkBtn: {
    padding: 4,
    marginLeft: 4,
  },

  centerBox: {
    marginTop: 50,
    alignItems: "center",
  },

  emptyText: {
    marginTop: 12,
    fontSize: 14,
    color: TEXT_GRAY,
    textAlign: "center",
    lineHeight: 22,
  },

  loadingText: {
    marginTop: 10,
    fontSize: 14,
    color: TEXT_GRAY,
  },

  bottomNav: {
    position: "absolute",
    left: 20,
    right: 20,
    height: 82,
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    ...Platform.select({
      ios:     { shadowColor: "#000", shadowOpacity: 0.14, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } },
      android: { elevation: 8 },
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