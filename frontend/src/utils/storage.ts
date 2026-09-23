import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAuthToken, addServerBookmark, removeServerBookmark, getServerBookmarks } from '../api';

const ROUTES_KEY         = '@ando/routes';
const USER_TYPE_KEY      = '@ando/user_type';
const BOOKMARKS_KEY      = '@ando/bookmarks';
const SLOPE_MARKERS_KEY  = '@ando/show_slope_markers';

// ── 즐겨찾기 ─────────────────────────────────────────────────────────────────

export interface BookmarkItem {
  id:        string;
  name:      string;
  address:   string;
  latitude:  number;
  longitude: number;
  category:  string;
  phone?:    string;
  createdAt: number;
}

export async function getBookmarks(): Promise<BookmarkItem[]> {
  try {
    const raw = await AsyncStorage.getItem(BOOKMARKS_KEY);
    return raw ? (JSON.parse(raw) as BookmarkItem[]) : [];
  } catch { return []; }
}

export async function addBookmark(item: BookmarkItem): Promise<void> {
  const existing = await getBookmarks();
  const filtered = existing.filter(b => b.id !== item.id);
  await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify([item, ...filtered]));
  // 서버 동기화 (best-effort, 로그인 안 된 경우 무시)
  getAuthToken().then(token => {
    if (!token) return;
    addServerBookmark({
      place_id:  item.id,
      name:      item.name,
      address:   item.address,
      latitude:  item.latitude,
      longitude: item.longitude,
      category:  item.category,
      phone:     item.phone,
    }, token).catch(() => {});
  }).catch(() => {});
}

export async function removeBookmark(id: string): Promise<void> {
  const existing = await getBookmarks();
  await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify(existing.filter(b => b.id !== id)));
  // 서버 동기화 (best-effort)
  getAuthToken().then(token => {
    if (!token) return;
    removeServerBookmark(id, token).catch(() => {});
  }).catch(() => {});
}

/** 서버 북마크를 로컬 캐시로 동기화 (앱 시작 시 또는 북마크 화면 진입 시 호출) */
export async function syncBookmarksFromServer(): Promise<void> {
  try {
    const token = await getAuthToken();
    if (!token) return;
    const serverItems = await getServerBookmarks(token);
    const mapped: BookmarkItem[] = serverItems.map(s => ({
      id:        s.place_id,
      name:      s.name,
      address:   s.address,
      latitude:  s.latitude,
      longitude: s.longitude,
      category:  s.category,
      phone:     s.phone ?? undefined,
      createdAt: (s as any).createdAt ?? Date.now(),
    }));
    await AsyncStorage.setItem(BOOKMARKS_KEY, JSON.stringify(mapped));
  } catch {
    // 서버 실패 시 로컬 캐시 유지
  }
}

export const USER_TYPE_MAP: Record<string, string> = {
  '전동':    'electric_wheelchair',
  '수동':    'manual_wheelchair',
  '보행기':  'walker',
  '지팡이':  'cane',
  '고령자':  'elderly',
  '다리부상': 'leg_injury',
  // S6 — 실험 참가자(비보행약자) 그룹. 시설 정책은 AMBUL과 동일(계단 차단,
  // 에스컬레이터 우선). 슬로프 임계값은 backend routing/cost.py USER_TYPES
  // 참고 — 플레이스홀더 값이라 실측 전 재검토 필요.
  '일반':    'general',
};

export async function saveUserType(koreanType: string): Promise<void> {
  await AsyncStorage.setItem(USER_TYPE_KEY, koreanType);
}

export async function getUserType(): Promise<string> {
  return (await AsyncStorage.getItem(USER_TYPE_KEY)) ?? '수동';
}

// 지도 위 오르막/내리막 퍼센트 화살표 표시 여부 — 기본은 켜짐(true).
export async function getShowSlopeMarkers(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(SLOPE_MARKERS_KEY);
  return raw === null ? true : raw === 'true';
}

export async function setShowSlopeMarkers(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(SLOPE_MARKERS_KEY, String(enabled));
}

export function toApiUserType(koreanType: string): string {
  return USER_TYPE_MAP[koreanType] ?? 'manual_wheelchair';
}

// USER_TYPE_MAP의 역방향 조회. 길안내 화면에서 영문 API 유형(예: electric_wheelchair)으로
// 유형을 바꿨을 때, 마이페이지가 읽는 저장소 형식(한글 키)으로 되돌려 저장하기 위해 사용.
export function toKoreanUserType(apiType: string): string {
  const entry = Object.entries(USER_TYPE_MAP).find(([, v]) => v === apiType);
  return entry ? entry[0] : '수동';
}

// 구간 기준: 경사도에 따른 5m 단위 세그먼트
export interface SegmentTime {
  index:         number;  // 구간 번호 (0-based)
  distanceM:     number;  // 구간 거리 (미터, 기본 5m)
  slopePercent:  number;  // 경사도 (%)
  elapsedMs:     number;  // 해당 구간 소요 시간 (ms)
  measured: boolean;
  // RouteDetailScreen "걸은 경로" 지도용(서버 실측이 없을 때의 로컬 폴백). 이 필드
  // 추가 이전에 저장된 기록엔 없다 — 없으면 지도 대신 안내 문구.
  zone?:  string;
  start?: { latitude: number; longitude: number };
  end?:   { latitude: number; longitude: number };
}

export interface RouteRecord {
  id:              string;
  from:            string;
  to:              string;
  mode:            'walk' | 'transit' | 'car';
  walkerType:      string;
  date:            string;        // ISO string
  totalDurationMs: number;        // 전체 소요 시간 (ms)
  segments:        SegmentTime[];
  serverRouteId?:  number;        // 서버 동기화 완료 후 설정
}

/** 분 단위 소요시간을 사람이 읽기 좋은 형태로 — 60분 이하면 "38분", 넘으면 "1시간 20분" */
export function formatMinutes(min: number): string {
  const total = Math.max(0, Math.round(min));
  if (total < 60) return `${total}분`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
}

// 경사도에 따른 힘듦 레벨 판단 (5m 구간 기준)
export function getSlopeEffort(slopePercent: number): 'easy' | 'normal' | 'hard' {
  if (slopePercent <= 2) return 'easy';
  if (slopePercent <= 5) return 'normal';
  return 'hard';
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}초`;
  return `${min}분 ${sec}초`;
}

export async function saveRoute(record: RouteRecord): Promise<void> {
  const existing = await getRoutes();
  const updated  = [record, ...existing];
  await AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(updated));
}

export async function getRoutes(): Promise<RouteRecord[]> {
  const raw = await AsyncStorage.getItem(ROUTES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as RouteRecord[];
  } catch {
    return [];
  }
}

export async function updateSegments(id: string, segments: SegmentTime[], totalDurationMs: number): Promise<void> {
  const routes  = await getRoutes();
  const updated = routes.map(r => r.id === id ? { ...r, segments, totalDurationMs } : r);
  await AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(updated));
}

/** 서버 동기화 완료 후 serverRouteId를 로컬 레코드에 기록 */
export async function updateServerRouteId(id: string, serverRouteId: number): Promise<void> {
  const routes  = await getRoutes();
  const updated = routes.map(r => r.id === id ? { ...r, serverRouteId } : r);
  await AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(updated));
}

/** 서버에서 받은 경로 목록으로 로컬 캐시 전체 교체 */
export async function saveRoutes(routes: RouteRecord[]): Promise<void> {
  await AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(routes));
}

export async function deleteRoute(id: string): Promise<void> {
  const routes  = await getRoutes();
  const updated = routes.filter(r => r.id !== id);
  await AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(updated));
}

export function generateId(): string {
  return `route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// 로그인 계정과 무관하게 기기 하나에 저장되는 로컬 캐시라, 로그아웃/새 계정
// 로그인 시 지우지 않으면 이전 계정의 경로 기록·즐겨찾기가 새 계정에도 그대로
// 보인다. 로그아웃 직후와 회원가입 직후에 호출한다. (user_type은 기기 단위
// 설정에 가까워 계정과 무관하게 유지해도 되므로 제외)
export async function clearLocalUserData(): Promise<void> {
  await AsyncStorage.multiRemove([ROUTES_KEY, BOOKMARKS_KEY]);
}