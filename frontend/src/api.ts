// 에뮬레이터: 10.0.2.2 / 실기기(같은 WiFi): .env 의 EXPO_PUBLIC_ROUTE_API_URL 사용
// routeApi.ts와 반드시 같은 값을 봐야 한다 — 예전엔 이 파일만 별도로
// EXPO_PUBLIC_API_URL(다른 이름)+포트 5000(다른 값)을 써서, 로그인/소요시간
// 전송 등 이 파일이 담당하는 기능만 조용히 엉뚱한 주소로 실패하고 있었음.
export const BASE_URL: string =
  (process.env.EXPO_PUBLIC_ROUTE_API_URL as string | undefined) ?? 'http://10.0.2.2:8000';

console.log(`[Front] 백엔드 연결 대상: ${BASE_URL}`);

// Firebase 모듈은 동적 import — 환경에 따라 없을 수 있음
let _getApp: any = null;
let _getAuth: any = null;
let _getIdToken: any = null;
try {
  const firebaseApp  = require('@react-native-firebase/app');
  const firebaseAuth = require('@react-native-firebase/auth');
  _getApp     = firebaseApp.getApp;
  _getAuth    = firebaseAuth.getAuth;
  _getIdToken = firebaseAuth.getIdToken;
} catch { /* Firebase 미설치 환경 */ }

/** Firebase 현재 로그인 유저의 ID 토큰 반환 (만료 시 자동 갱신) */
export async function getAuthToken(): Promise<string | null> {
  try {
    if (!_getAuth || !_getIdToken) return null;
    const auth = _getAuth(_getApp());
    if (!auth.currentUser) return null;
    return await _getIdToken(auth.currentUser, false);
  } catch {
    return null;
  }
}

export interface UserInfo {
  uid:          string;
  email:        string;
  display_name: string;
  photo_url:    string;
  user_type:    string;
}

export async function loginToBackend(idToken: string): Promise<UserInfo> {
  console.log(`[Front→DB] POST ${BASE_URL}/auth/login 요청 중...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id_token: idToken }),
      signal:  controller.signal,
    });
    if (!res.ok) {
      const err = await res.json();
      console.error(`[Front→DB] 로그인 실패:`, err);
      throw new Error(err.detail || '백엔드 로그인 실패');
    }
    const user: UserInfo = await res.json();
    console.log(`[Front→DB] 로그인 성공 → uid: ${user.uid}, type: ${user.user_type}`);
    return user;
  } finally {
    clearTimeout(timer);
  }
}

// ── 마이페이지 API ────────────────────────────────────────────────────────────

export interface SegmentPayload {
  index:        number;
  distanceM:    number;
  slopePercent: number;  // 부호 포함 (양수=오르막, 음수=내리막)
  elapsedMs:    number;
  measured:     boolean; // true=GPS 실측, false=거리비례 추정
  zone?:        string;  // 'flat'|'optimal'|'warning'|'forbidden'
  direction?:   string;
}

export interface SaveRoutePayload {
  from_name:         string;
  to_name:           string;
  mode:              string;
  walker_type:       string;
  total_duration_ms: number;
  date:              string;
  segments:          SegmentPayload[];
}

/** 안내 완료 후 경로 + 구간 데이터를 서버에 저장 → serverRouteId 반환 */
export async function saveCompletedRoute(
  payload: SaveRoutePayload,
  idToken: string,
): Promise<{ route_id: number }> {
  const res = await fetch(`${BASE_URL}/user/routes`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('경로 서버 저장 실패');
  return res.json();
}

/** 마이페이지 — 서버에서 경로 목록 조회 (만족도 포함) */
export async function getUserRoutes(idToken: string): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/user/routes`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error('서버 경로 목록 조회 실패');
  return res.json();
}

/** 마이페이지 — 경로 삭제 (연결된 구간·만족도 기록도 서버에서 함께 삭제됨) */
export async function deleteUserRoute(serverRouteId: number, idToken: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/user/routes/${serverRouteId}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok && res.status !== 404) throw new Error('경로 서버 삭제 실패');
}

/** 회원 탈퇴 — 서버 DB 계정(+북마크 등 연쇄 데이터) 및 Firebase 계정 삭제 */
export async function deleteAccount(idToken: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/user/me`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error('회원 탈퇴 실패');
}

export interface UserStats {
  total_routes: number;
  total_distance_m: number;
  total_duration_ms: number;
  avg_slope_pct: number;
  avg_satisfaction: number | null;
}

export async function getUserStats(idToken: string): Promise<UserStats | null> {
  try {
    const res = await fetch(`${BASE_URL}/user/stats`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/** 설정에서 이동 유형 변경 시 서버에도 반영 */
export async function updateUserTypeOnServer(apiType: string, idToken: string): Promise<void> {
  await fetch(`${BASE_URL}/user/type`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body:    JSON.stringify({ user_type: apiType }),
  }).catch(() => {}); // best-effort
}

// ── 북마크 API ────────────────────────────────────────────────────────────────

export interface BookmarkPayload {
  place_id:  string;
  name:      string;
  address:   string;
  latitude:  number;
  longitude: number;
  category:  string;
  phone?:    string;
}

export async function getServerBookmarks(idToken: string): Promise<BookmarkPayload[]> {
  const res = await fetch(`${BASE_URL}/user/bookmarks`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error('북마크 목록 조회 실패');
  return res.json();
}

export async function addServerBookmark(payload: BookmarkPayload, idToken: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/user/bookmarks`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('북마크 서버 저장 실패');
}

export async function removeServerBookmark(placeId: string, idToken: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/user/bookmarks/${encodeURIComponent(placeId)}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok && res.status !== 404) throw new Error('북마크 서버 삭제 실패');
}

// ── 검색기록 API ──────────────────────────────────────────────────────────────
// 출발지/도착지 구분 없음 — 검색 후 선택한 장소를 그대로 기록.

export interface SearchHistoryPayload {
  place_id:  string;
  name:      string;
  address:   string;
  latitude:  number;
  longitude: number;
  category:  string;
  phone?:    string;
}

export interface SearchHistoryItem extends SearchHistoryPayload {
  searchedAt: number;
}

export async function getSearchHistory(idToken: string): Promise<SearchHistoryItem[]> {
  const res = await fetch(`${BASE_URL}/user/search-history`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) throw new Error('검색기록 조회 실패');
  return res.json();
}

/** 검색 결과 선택 시 best-effort로 기록 — 실패해도 검색 흐름을 막지 않는다 */
export async function saveSearchHistory(payload: SearchHistoryPayload, idToken: string): Promise<void> {
  await fetch(`${BASE_URL}/user/search-history`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body:    JSON.stringify(payload),
  }).catch(() => {});
}

/** 만족도 저장/수정 — 안내 직후 팝업과 마이페이지 상세 모두에서 호출 */
export async function submitFeedback(
  serverRouteId: number,
  rating: number,
  idToken: string,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/routes/${serverRouteId}/feedback`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body:    JSON.stringify({ rating }),
  });
  if (!res.ok) throw new Error('만족도 서버 저장 실패');
}

// ── 내비게이션 세션 API (방식 B) ──────────────────────────────────────────────

export interface NavStartPayload {
  from_name:      string;
  to_name:        string;
  mode:           string;
  walker_type:    string;
  total_segments: number;
  origin_lat?:    number | null;
  origin_lon?:    number | null;
  dest_lat?:      number | null;
  dest_lon?:      number | null;
}

export async function startNavigation(
  idToken: string,
  payload: NavStartPayload,
): Promise<{ route_id: number }> {
  const res = await fetch(`${BASE_URL}/navigation/start`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('내비게이션 세션 시작 실패');
  return res.json();
}

export async function submitSegment(
  routeId: number,
  seg: SegmentPayload,
  idToken: string,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/navigation/${routeId}/segment`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({
      index:       seg.index,
      distance_m:  seg.distanceM,
      slope_pct:   seg.slopePercent,
      elapsed_ms:  seg.elapsedMs,
      measured:    seg.measured,
      zone:        seg.zone,
      direction:   seg.direction,
    }),
  });
  if (!res.ok) throw new Error(`구간 ${seg.index} 저장 실패`);
}

export async function completeNavigation(
  routeId: number,
  totalDurationMs: number,
  idToken: string,
): Promise<{ route_id: number; total_length_m: number; avg_slope_pct: number; total_duration_ms: number }> {
  const res = await fetch(`${BASE_URL}/navigation/${routeId}/complete`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body:    JSON.stringify({ total_duration_ms: totalDurationMs }),
  });
  if (!res.ok) throw new Error('내비게이션 완료 처리 실패');
  return res.json();
}

export interface ZoneObservationPayload {
  zone_key:      string;
  zone?:         string;
  direction?:    string;
  slope_pct_avg: number;
  distance_m:    number;
  elapsed_ms:    number;
  gps_sample_n:  number;
}

/** zone 통과 완료 시 호출 — best-effort (실패해도 내비게이션 미중단) */
export async function submitZoneObservation(
  routeId: number,
  payload: ZoneObservationPayload,
  idToken: string,
): Promise<void> {
  await fetch(`${BASE_URL}/navigation/${routeId}/zone`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body:    JSON.stringify(payload),
  }).catch(() => {});
}