// 개인화 화면들을 기존 흐름에 끼워넣는 진입 헬퍼 (플래그로 on/off).
//
// WIP 파일(WalkContent, NavigationScreen …)에는 이 함수를 "한 줄" 호출하는 것만 추가한다.
// 자세한 위치는 `docs/personalization-wiring.md` 의 PENDING_WIRE 목록 참고.
// 플래그가 전부 false 이면 이 함수들은 아무것도 안 하고 false 를 돌려준다.

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ROUTE_COMPARE_ENABLED,
  SEGMENT_FEEDBACK_ENABLED,
  ROUNDTRIP_HINT_ENABLED,
} from "./config";
import { pickFeedbackSegments } from "../utils/segmentFeedbackModel";
import { directionForSession, type WalkDirection } from "../utils/roundtripHint";

type Nav = { navigate: (screen: string, params?: Record<string, any>) => void };

/**
 * ⑬ — 도보 안내 시작 직전에 호출. 비교 화면을 띄웠으면 true(호출부는 return),
 * 아니면 false(호출부는 기존대로 Navigation 으로 진행).
 * PENDING_WIRE(walk-compare): WalkContent.handleStartNavigation 최상단.
 */
export function goToRouteCompareIfEnabled(
  navigation: Nav | undefined,
  params: Record<string, any>,
): boolean {
  if (!ROUTE_COMPARE_ENABLED || !navigation) return false;
  navigation.navigate("RouteCompare", params);
  return true;
}

/**
 * ⑭ — 만족도 입력(또는 건너뛰기) 뒤에 호출. 평가할 경사 구간이 있으면 구간 평가
 * 화면으로, 없으면(또는 플래그 off) 곧장 RouteDetail 로.
 * PENDING_WIRE(nav-segfeedback): NavigationScreen.handleRatingSubmit / handleRatingSkip 의
 *   `navigation.navigate("RouteDetail", …)` 자리.
 */
export function routeAfterRating(
  navigation: Nav | undefined,
  args: { serverRouteId: number | null; routeSegments: any[]; nextRouteId: string },
): void {
  if (!navigation) return;
  const hasSteep = SEGMENT_FEEDBACK_ENABLED && pickFeedbackSegments(args.routeSegments ?? []).length > 0;
  if (hasSteep) {
    navigation.navigate("SegmentFeedback", {
      routeSegments: JSON.stringify(args.routeSegments ?? []),
      serverRouteId: args.serverRouteId != null ? String(args.serverRouteId) : "",
      nextRouteId:   args.nextRouteId,
    });
  } else {
    navigation.navigate("RouteDetail", { routeId: args.nextRouteId });
  }
}

// ── ⑮ 왕복·방향 교대 ────────────────────────────────────────────────────────
const ROUNDTRIP_SEQ_KEY = "@ando/roundtrip_seq";

/** 지금 세션의 방향을 정하고(교대) 카운터를 1 올린다. 플래그 off 면 항상 forward. */
export async function nextRoundtripDirection(): Promise<WalkDirection> {
  if (!ROUNDTRIP_HINT_ENABLED) return "forward";
  let n = 0;
  try {
    n = Number((await AsyncStorage.getItem(ROUNDTRIP_SEQ_KEY)) ?? "0") || 0;
    await AsyncStorage.setItem(ROUNDTRIP_SEQ_KEY, String(n + 1));
  } catch { /* 스토리지 실패 시 forward */ }
  return directionForSession(n);
}
