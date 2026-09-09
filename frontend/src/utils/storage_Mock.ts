import AsyncStorage from '@react-native-async-storage/async-storage';

const BOOKMARKS_STORAGE_KEY = '@ando/mock_bookmarks_integrate_v2';
const CATEGORIES_STORAGE_KEY = '@ando/mock_categories_integrate_v2';

const defaultCategories = ["식당", "학교", "집", "학원", "여행지", "카페"];

const defaultDatabase: { [key: string]: any[] } = {
  식당: [
    { id: 1, name: "숙대앞 쌀국수", addr: "서울 용산구", info: "경사로 있음" },
    { id: 2, name: "효창공원 파스타", addr: "서울 용산구", info: "턱 없음" },
  ],
  학교: [
    { id: 3, name: "숙명여자대학교", addr: "서울 용산구", info: "엘리베이터 완비" },
  ],
  집: [
    { id: 4, name: "우리집", addr: "안전한 보금자리", info: "도착지" }
  ],
  학원: [], 여행지: [], 카페: []
};

/** 1. 카테고리 목록 읽어오기 */
export async function getCategoriesFromBackend(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(CATEGORIES_STORAGE_KEY);
    if (!raw) {
      await AsyncStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(defaultCategories));
      return defaultCategories;
    }
    return JSON.parse(raw);
  } catch (e) {
    return defaultCategories;
  }
}

/** 2. 새 카테고리 이름 추가하기 (상단 + 버튼 클릭 시) */
export async function addCategoryToBackend(newCategory: string): Promise<string[]> {
  try {
    const currentCats = await getCategoriesFromBackend();
    if (currentCats.includes(newCategory)) return currentCats; // 중복 방지

    currentCats.push(newCategory);
    await AsyncStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(currentCats));
    
    // 데이터베이스에도 해당 카테고리용 빈 배열 생성
    const currentDb = await getBookmarksFromBackend();
    if (!currentDb[newCategory]) {
      currentDb[newCategory] = [];
      await AsyncStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(currentDb));
    }

    return currentCats;
  } catch (e) {
    return defaultCategories;
  }
}

/** 3. 북마크 장소 데이터 가져오기 */
export async function getBookmarksFromBackend(): Promise<{ [key: string]: any[] }> {
  try {
    const rawData = await AsyncStorage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!rawData) {
      await AsyncStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(defaultDatabase));
      return defaultDatabase;
    }
    return JSON.parse(rawData);
  } catch (e) {
    return defaultDatabase;
  }
}

/** 4. 특정 카테고리에 진짜 장소 객체 추가하기 (검색 연동 시 사용) */
export async function addBookmarkToBackend(category: string, place: { name: string; addr: string; info: string }) {
  try {
    const currentDb = await getBookmarksFromBackend();
    const bookmarkRow = { id: Date.now(), ...place };

    if (!currentDb[category]) {
      currentDb[category] = [];
    }
    currentDb[category].unshift(bookmarkRow); // 최상단에 노출되도록 앞에 추가

    await AsyncStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(currentDb));
    return currentDb;
  } catch (e) {
    return defaultDatabase;
  }
}