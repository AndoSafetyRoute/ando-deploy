import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { createClient } from "@supabase/supabase-js";
import * as Location from "expo-location";
import { getBookmarks, addBookmark, removeBookmark, BookmarkItem } from "../src/utils/storage";
import { getAuthToken } from "../src/api";
import { getSearchHistory, saveSearchHistory, SearchHistoryItem } from "../src/api";

const NAVY = "#1B0F4A";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT_GRAY = "#666666";

const KAKAO_REST_API_KEY = process.env.EXPO_PUBLIC_KAKAO_REST_API_KEY;

const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
);

// 홈 화면과 같은 카테고리 목록 — 반경 내 전체 조회용.
const CATEGORIES = [
  { id: "wheelchair-charge", label: "휠체어 충전소", icon: "wheelchair-accessibility" as const },
  { id: "cafe", label: "카페", icon: "coffee" as const },
  { id: "restaurant", label: "음식점", icon: "silverware-fork-knife" as const },
];
const CATEGORY_GROUP_CODES: Record<string, string> = { cafe: "CE7", restaurant: "FD6" };
const NEARBY_SEARCH_RADIUS_M = 1500;
const DEFAULT_CENTER = { lat: 37.5665, lng: 126.978 }; // GPS 실패 시 폴백(서울시청)

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

type KakaoPlace = {
  id: string;
  place_name: string;
  address_name: string;
  road_address_name: string;
  phone: string;
  category_name: string;
  place_url: string;
  x: string; // longitude
  y: string; // latitude
};

type PlaceResult = {
  id: string;
  name: string;
  address: string;
  phone: string;
  category: string;
  placeUrl: string;
  latitude: number;
  longitude: number;
};

async function fetchWheelchairChargersNear(centerLat: number, centerLng: number): Promise<PlaceResult[]> {
  const { data, error } = await supabase
    .from("charging_stations")
    .select("name, lat, lng, address_road");
  if (error) throw error;

  return (data ?? [])
    .map((row: any) => ({
      id: `charger-${row.lat}-${row.lng}`,
      name: row.name,
      address: row.address_road || "주소 정보 없음",
      phone: "전화번호 정보 없음",
      category: "휠체어 충전소",
      placeUrl: "",
      latitude: row.lat,
      longitude: row.lng,
    }))
    .filter((p: PlaceResult) => haversineMeters(centerLat, centerLng, p.latitude, p.longitude) <= NEARBY_SEARCH_RADIUS_M);
}

async function fetchNearbyCategoryPlaces(
  categoryGroupCode: string,
  centerLat: number,
  centerLng: number,
): Promise<PlaceResult[]> {
  if (!KAKAO_REST_API_KEY) return [];
  const results: PlaceResult[] = [];

  for (let page = 1; page <= 3; page++) {
    const url =
      `https://dapi.kakao.com/v2/local/search/category.json` +
      `?category_group_code=${categoryGroupCode}` +
      `&x=${centerLng}&y=${centerLat}` +
      `&radius=${NEARBY_SEARCH_RADIUS_M}&sort=distance&page=${page}`;

    const response = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` } });
    if (!response.ok) break;

    const json = await response.json();
    const documents: any[] = json.documents ?? [];
    results.push(
      ...documents.map((doc) => ({
        id: doc.id,
        name: doc.place_name,
        address: doc.road_address_name || doc.address_name || "주소 정보 없음",
        phone: doc.phone || "전화번호 정보 없음",
        category: doc.category_name || "",
        placeUrl: doc.place_url || "",
        latitude: Number(doc.y),
        longitude: Number(doc.x),
      }))
    );

    if (json.meta?.is_end ?? true) break;
  }

  return results;
}

function fetchPlacesForCategory(categoryId: string, centerLat: number, centerLng: number): Promise<PlaceResult[]> {
  if (categoryId === "wheelchair-charge") return fetchWheelchairChargersNear(centerLat, centerLng);
  const groupCode = CATEGORY_GROUP_CODES[categoryId];
  if (groupCode) return fetchNearbyCategoryPlaces(groupCode, centerLat, centerLng);
  return Promise.resolve([]);
}

function getParam(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function formatHistoryDate(epochMs: number): string {
  if (!epochMs) return "";
  const d = new Date(epochMs);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `오늘 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export default function SearchScreen() {
  const params = useLocalSearchParams();

  const keyword = getParam(params.keyword);
  const mode = getParam(params.mode);

  const [searchText, setSearchText] = useState(keyword);
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [categoryLoading, setCategoryLoading] = useState(false);

  useEffect(() => {
    getBookmarks().then(items => {
      setBookmarkedIds(new Set(items.map(b => b.id)));
      setBookmarks(items);
    });

    // 검색기록은 계정(DB) 기반이라 로그인 안 돼있으면 조용히 빈 목록으로 둔다.
    getAuthToken()
      .then(token => (token ? getSearchHistory(token) : null))
      .then(items => { if (items) setHistory(items); })
      .catch(() => {});
  }, []);

  function placeResultToHistoryPayload(item: PlaceResult) {
    return {
      place_id:  item.id,
      name:      item.name,
      address:   item.address,
      latitude:  item.latitude,
      longitude: item.longitude,
      category:  item.category,
      phone:     item.phone !== "전화번호 정보 없음" ? item.phone : undefined,
    };
  }

  function historyItemToPlaceResult(item: SearchHistoryItem): PlaceResult {
    return {
      id: item.place_id,
      name: item.name,
      address: item.address,
      phone: item.phone || "전화번호 정보 없음",
      category: item.category,
      placeUrl: "",
      latitude: item.latitude,
      longitude: item.longitude,
    };
  }

  function bookmarkItemToPlaceResult(item: BookmarkItem): PlaceResult {
    return {
      id: item.id,
      name: item.name,
      address: item.address,
      phone: item.phone || "전화번호 정보 없음",
      category: item.category,
      placeUrl: "",
      latitude: item.latitude,
      longitude: item.longitude,
    };
  }

  const toggleBookmark = useCallback(async (item: PlaceResult) => {
    if (bookmarkedIds.has(item.id)) {
      await removeBookmark(item.id);
      setBookmarkedIds(prev => { const s = new Set(prev); s.delete(item.id); return s; });
    } else {
      const bm: BookmarkItem = {
        id:        item.id,
        name:      item.name,
        address:   item.address,
        latitude:  item.latitude,
        longitude: item.longitude,
        category:  item.category,
        phone:     item.phone !== "전화번호 정보 없음" ? item.phone : undefined,
        createdAt: Date.now(),
      };
      await addBookmark(bm);
      setBookmarkedIds(prev => new Set(prev).add(item.id));
    }
  }, [bookmarkedIds]);

  // 도착지 검색(mode=route-end)이면 이미 입력된 출발지 좌표를 중심으로,
  // 그 외(출발지 검색/일반 검색)엔 현재 GPS 위치를 중심으로 반경 내 카테고리를 조회한다.
  const resolveCategoryCenter = async (): Promise<{ lat: number; lng: number }> => {
    if (mode === "route-end") {
      const lat = Number(getParam(params.startLatitude));
      const lng = Number(getParam(params.startLongitude));
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }

    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return DEFAULT_CENTER;

      const loc: any = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
      return { lat: loc.coords.latitude, lng: loc.coords.longitude };
    } catch {
      try {
        const last = await Location.getLastKnownPositionAsync({});
        if (last) return { lat: last.coords.latitude, lng: last.coords.longitude };
      } catch {}
      return DEFAULT_CENTER;
    }
  };

  const handleSelectCategory = async (categoryId: string) => {
    if (selectedCategory === categoryId) {
      // 같은 칩을 다시 누르면 해제하고 검색 결과 비움
      setSelectedCategory(null);
      setResults([]);
      return;
    }

    setSelectedCategory(categoryId);
    setSearchText("");
    setResults([]);
    setCategoryLoading(true);
    try {
      const center = await resolveCategoryCenter();
      const places = await fetchPlacesForCategory(categoryId, center.lat, center.lng);
      setResults(places);
    } catch (e) {
      console.log("카테고리 검색 오류:", e);
      Alert.alert("오류", "카테고리 장소를 불러오지 못했습니다.");
    } finally {
      setCategoryLoading(false);
    }
  };

  const searchPlaces = async (query: string) => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setResults([]);
      return;
    }

    if (!KAKAO_REST_API_KEY) {
      Alert.alert(
        "API 키 없음",
        ".env에 EXPO_PUBLIC_KAKAO_REST_API_KEY를 넣어야 합니다."
      );
      return;
    }

    try {
      setLoading(true);

      const url =
        "https://dapi.kakao.com/v2/local/search/keyword.json" +
        `?query=${encodeURIComponent(trimmedQuery)}` +
        "&size=15";

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `KakaoAK ${KAKAO_REST_API_KEY}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log("Kakao API Error:", response.status, errorText);

        Alert.alert(
          "검색 실패",
          `카카오 장소 검색 요청 실패: ${response.status}`
        );
        return;
      }

      const data = await response.json();

      const mappedResults: PlaceResult[] = data.documents.map(
        (item: KakaoPlace) => ({
          id: item.id,
          name: item.place_name,
          address:
            item.road_address_name || item.address_name || "주소 정보 없음",
          phone: item.phone || "전화번호 정보 없음",
          category: item.category_name || "카테고리 정보 없음",
          placeUrl: item.place_url,
          latitude: Number(item.y),
          longitude: Number(item.x),
        })
      );

      setResults(mappedResults);
    } catch (error) {
      console.log("Search error:", error);
      Alert.alert("검색 오류", "장소 검색 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (keyword) {
      searchPlaces(keyword);
    }
  }, [keyword]);

  // 연관 검색어 — 타이핑하는 동안 디바운스 걸어서 자동으로 조회한다.
  // 검색 버튼/엔터(searchPlaces)와 달리 실패해도 Alert를 띄우지 않는다 —
  // 타이핑 중 일시적 오류마다 알림이 뜨면 방해된다. 응답이 왔을 때 이미
  // 더 최신 검색어로 재요청된 상태면(searchSeqRef 불일치) 결과를 버린다.
  const searchSeqRef = useRef(0);

  const searchPlacesQuiet = async (query: string) => {
    if (!KAKAO_REST_API_KEY) return;
    const seq = ++searchSeqRef.current;

    try {
      setLoading(true);
      const url =
        "https://dapi.kakao.com/v2/local/search/keyword.json" +
        `?query=${encodeURIComponent(query)}` +
        "&size=15";
      const response = await fetch(url, {
        headers: { Authorization: `KakaoAK ${KAKAO_REST_API_KEY}` },
      });
      if (!response.ok || seq !== searchSeqRef.current) return;

      const data = await response.json();
      if (seq !== searchSeqRef.current) return;

      const mappedResults: PlaceResult[] = data.documents.map(
        (item: KakaoPlace) => ({
          id: item.id,
          name: item.place_name,
          address: item.road_address_name || item.address_name || "주소 정보 없음",
          phone: item.phone || "전화번호 정보 없음",
          category: item.category_name || "카테고리 정보 없음",
          placeUrl: item.place_url,
          latitude: Number(item.y),
          longitude: Number(item.x),
        })
      );
      setResults(mappedResults);
    } catch {
      // 조용히 무시
    } finally {
      if (seq === searchSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed.length === 0) {
      setResults([]);
      return;
    }
    // 한 글자만으로는 결과가 너무 광범위해서 의미 있는 연관검색어가 되기 어렵다.
    if (trimmed.length < 2) return;

    const timer = setTimeout(() => { searchPlacesQuiet(trimmed); }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const moveToPlaceInfo = (place: PlaceResult) => {
    // 출발지/도착지 구분 없이 선택한 장소를 그대로 검색기록에 남긴다(best-effort).
    getAuthToken()
      .then(token => (token ? saveSearchHistory(placeResultToHistoryPayload(place), token) : null))
      .catch(() => {});

    const startName = getParam(params.startName);
    const startAddress = getParam(params.startAddress);
    const startLatitude = getParam(params.startLatitude);
    const startLongitude = getParam(params.startLongitude);

    const endName = getParam(params.endName);
    const endAddress = getParam(params.endAddress);
    const endLatitude = getParam(params.endLatitude);
    const endLongitude = getParam(params.endLongitude);

    // route-select에서 출발지 입력하러 온 경우
    if (mode === "route-start") {
      router.replace({
        pathname: "/route-select",
        params: {
          startName: place.name,
          startAddress: place.address,
          startLatitude: String(place.latitude),
          startLongitude: String(place.longitude),

          endName,
          endAddress,
          endLatitude,
          endLongitude,
        },
      });
      return;
    }

    // route-select에서 도착지 입력하러 온 경우
    if (mode === "route-end") {
      router.replace({
        pathname: "/route-select",
        params: {
          startName,
          startAddress,
          startLatitude,
          startLongitude,

          endName: place.name,
          endAddress: place.address,
          endLatitude: String(place.latitude),
          endLongitude: String(place.longitude),
        },
      });
      return;
    }

    // 일반 검색인 경우: 장소정보 화면으로 이동
    router.push({
      pathname: "/place-info",
      params: {
        id: place.id,
        name: place.name,
        address: place.address,
        phone: place.phone,
        category: place.category,
        placeUrl: place.placeUrl,
        latitude: String(place.latitude),
        longitude: String(place.longitude),
      },
    });
  };

  const handleSearch = () => {
    const trimmed = searchText.trim();

    if (!trimmed) {
      Alert.alert("검색어 입력", "검색할 장소를 입력해주세요.");
      return;
    }

    searchPlaces(trimmed);
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* 상단 검색 영역 */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => router.back()}
        >
          <Ionicons name="chevron-back" size={28} color={NAVY} />
        </TouchableOpacity>

        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={21} color="#777777" />

          <TextInput
            style={styles.searchInput}
            value={searchText}
            onChangeText={(t) => { setSearchText(t); if (selectedCategory) setSelectedCategory(null); }}
            placeholder={
              mode === "route-start"
                ? "출발지 검색"
                : mode === "route-end"
                ? "도착지 검색"
                : "장소 검색"
            }
            placeholderTextColor="#999999"
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />

          {searchText.length > 0 && (
            <TouchableOpacity onPress={() => setSearchText("")}>
              <Ionicons name="close-circle" size={20} color="#A0A0A0" />
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity style={styles.searchButton} onPress={handleSearch}>
          <Text style={styles.searchButtonText}>검색</Text>
        </TouchableOpacity>
      </View>

      {/* 북마크 바로가기 — 검색창 바로 아래, 누르면 그 장소를 바로 선택 */}
      {bookmarks.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.bookmarkRow}
          contentContainerStyle={styles.bookmarkRowContent}
        >
          {bookmarks.map((b) => (
            <TouchableOpacity
              key={b.id}
              style={styles.bookmarkChip}
              activeOpacity={0.8}
              onPress={() => moveToPlaceInfo(bookmarkItemToPlaceResult(b))}
            >
              <Ionicons name="bookmark" size={14} color={NAVY} />
              <Text style={styles.bookmarkChipText} numberOfLines={1}>
                {b.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* 카테고리로 찾기 — 도착지 검색이면 출발지 주변, 그 외엔 현재 위치 주변 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.categoryRow}
        contentContainerStyle={styles.categoryRowContent}
      >
        {CATEGORIES.map((c) => {
          const isSelected = selectedCategory === c.id;
          return (
            <TouchableOpacity
              key={c.id}
              style={[styles.categoryChip, isSelected && styles.categoryChipSelected]}
              activeOpacity={0.8}
              onPress={() => handleSelectCategory(c.id)}
            >
              <MaterialCommunityIcons
                name={c.icon}
                size={16}
                color={isSelected ? "#FFFFFF" : NAVY}
              />
              <Text style={[styles.categoryChipText, isSelected && styles.categoryChipTextSelected]}>
                {c.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* 검색어 안내 */}
      <View style={styles.summaryBox}>
        <Text style={styles.summaryTitle}>
          {mode === "route-start"
            ? "출발지 선택"
            : mode === "route-end"
            ? "도착지 선택"
            : "검색 결과"}
        </Text>

        <Text style={styles.summaryText}>
          {selectedCategory
            ? `${CATEGORIES.find(c => c.id === selectedCategory)?.label} · 주변 ${(NEARBY_SEARCH_RADIUS_M / 1000).toFixed(1)}km`
            : searchText.trim()
            ? `"${searchText.trim()}"에 대한 장소`
            : "검색어를 입력해 주세요"}
        </Text>
      </View>

      {/* 결과 영역 */}
      {loading || categoryLoading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={NAVY} />
          <Text style={styles.loadingText}>
            {categoryLoading ? "주변 장소를 찾는 중..." : "장소를 검색하는 중..."}
          </Text>
        </View>
      ) : !searchText.trim() && !selectedCategory && history.length > 0 ? (
        <FlatList
          data={history}
          keyExtractor={(item) => item.place_id}
          contentContainerStyle={styles.resultList}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <Text style={styles.historyHeader}>최근 검색</Text>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.resultCard}
              activeOpacity={0.8}
              onPress={() => moveToPlaceInfo(historyItemToPlaceResult(item))}
            >
              <View style={[styles.markerIconBox, { backgroundColor: TEXT_GRAY }]}>
                <Ionicons name="time-outline" size={22} color="#FFFFFF" />
              </View>

              <View style={styles.resultTextBox}>
                <Text style={styles.placeName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.placeAddress} numberOfLines={2}>
                  {item.address}
                </Text>
                <Text style={styles.historyDate}>{formatHistoryDate(item.searchedAt)}</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.resultList}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Ionicons name="search-circle-outline" size={58} color="#C5C5C5" />
              <Text style={styles.emptyTitle}>검색 결과가 없습니다</Text>
              <Text style={styles.emptyText}>
                장소명을 다시 입력하거나 다른 키워드로 검색해 주세요.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const saved = bookmarkedIds.has(item.id);
            return (
              <TouchableOpacity
                style={styles.resultCard}
                activeOpacity={0.8}
                onPress={() => moveToPlaceInfo(item)}
              >
                <View style={styles.markerIconBox}>
                  <Ionicons name="location" size={24} color="#FFFFFF" />
                </View>

                <View style={styles.resultTextBox}>
                  <Text style={styles.placeName} numberOfLines={1}>
                    {item.name}
                  </Text>

                  <Text style={styles.placeAddress} numberOfLines={2}>
                    {item.address}
                  </Text>

                  <View style={styles.metaRow}>
                    <Text style={styles.categoryText} numberOfLines={1}>
                      {item.category}
                    </Text>
                  </View>

                  {item.phone !== "전화번호 정보 없음" && (
                    <View style={styles.phoneRow}>
                      <Ionicons name="call-outline" size={14} color={TEXT_GRAY} />
                      <Text style={styles.phoneText}>{item.phone}</Text>
                    </View>
                  )}
                </View>

                {!mode ? (
                  <TouchableOpacity
                    style={styles.bookmarkBtn}
                    onPress={() => toggleBookmark(item)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons
                      name={saved ? "bookmark" : "bookmark-outline"}
                      size={22}
                      color={saved ? "#7C6FF7" : "#B0B0B0"}
                    />
                  </TouchableOpacity>
                ) : (
                  <Feather name="chevron-right" size={24} color="#B0B0B0" />
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}
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

  header: {
    height: 62,
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: LIGHT_GRAY,
    justifyContent: "center",
    alignItems: "center",
  },

  searchBox: {
    flex: 1,
    height: 52,
    borderRadius: 18,
    backgroundColor: LIGHT_GRAY,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
  },

  searchInput: {
    flex: 1,
    height: "100%",
    marginLeft: 8,
    fontSize: 16,
    color: "#111111",
  },

  searchButton: {
    height: 52,
    paddingHorizontal: 16,
    borderRadius: 18,
    backgroundColor: NAVY,
    justifyContent: "center",
    alignItems: "center",
  },

  searchButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#FFFFFF",
  },

  summaryBox: {
    marginTop: 18,
    marginBottom: 8,
  },

  summaryTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: "#111111",
  },

  summaryText: {
    marginTop: 5,
    fontSize: 14,
    color: TEXT_GRAY,
  },

  loadingBox: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },

  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: TEXT_GRAY,
  },

  resultList: {
    paddingTop: 8,
    paddingBottom: 30,
  },

  bookmarkRow: {
    flexGrow: 0,
    marginTop: 12,
  },

  bookmarkRowContent: {
    alignItems: "center",
    paddingRight: 8,
  },

  bookmarkChip: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 160,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    marginRight: 8,
    backgroundColor: LIGHT_GRAY,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    gap: 6,
  },

  bookmarkChipText: {
    fontSize: 13,
    fontWeight: "700",
    color: NAVY,
  },

  categoryRow: {
    flexGrow: 0,
    marginTop: 10,
  },

  categoryRowContent: {
    alignItems: "center",
    paddingRight: 8,
  },

  categoryChip: {
    flexDirection: "row",
    alignItems: "center",
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    marginRight: 8,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    gap: 6,
  },

  categoryChipSelected: {
    backgroundColor: NAVY,
    borderColor: NAVY,
  },

  categoryChipText: {
    fontSize: 13,
    fontWeight: "700",
    color: NAVY,
  },

  categoryChipTextSelected: {
    color: "#FFFFFF",
  },

  historyHeader: {
    fontSize: 13,
    fontWeight: "700",
    color: TEXT_GRAY,
    marginBottom: 10,
    marginLeft: 2,
  },

  historyDate: {
    marginTop: 6,
    fontSize: 11,
    color: "#999999",
  },

  resultCard: {
    minHeight: 118,
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    marginBottom: 14,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    ...shadowStyle,
  },

  markerIconBox: {
    width: 46,
    height: 46,
    borderRadius: 16,
    backgroundColor: NAVY,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },

  resultTextBox: {
    flex: 1,
  },

  bookmarkBtn: {
    padding: 4,
    marginLeft: 6,
  },

  placeName: {
    fontSize: 17,
    fontWeight: "800",
    color: "#111111",
  },

  placeAddress: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 18,
    color: "#444444",
  },

  metaRow: {
    marginTop: 9,
    alignSelf: "flex-start",
    maxWidth: "95%",
    backgroundColor: LIGHT_GRAY,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },

  categoryText: {
    fontSize: 11,
    color: TEXT_GRAY,
  },

  phoneRow: {
    marginTop: 7,
    flexDirection: "row",
    alignItems: "center",
  },

  phoneText: {
    marginLeft: 5,
    fontSize: 12,
    color: TEXT_GRAY,
  },

  emptyBox: {
    flex: 1,
    marginTop: 110,
    alignItems: "center",
    paddingHorizontal: 30,
  },

  emptyTitle: {
    marginTop: 14,
    fontSize: 18,
    fontWeight: "700",
    color: "#333333",
  },

  emptyText: {
    marginTop: 8,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 20,
    color: "#777777",
  },
});