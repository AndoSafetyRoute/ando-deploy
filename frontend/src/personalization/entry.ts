// 개인화 화면들을 기존 흐름에 끼워넣는 진입 헬퍼 (플래그로 on/off).
//
// WIP 파일(WalkContent, NavigationScreen …)에는 이 함수를 "한 줄" 호출하는 것만 추가한다.
// 자세한 위치는 `docs/personalization-wiring.md` 의 PENDING_WIRE 목록 참고.
// 플래그가 전부 false 이면 이 함수들은 아무것도 안 하고 false 를 돌려준다.

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  SLOW_SEGMENT_FEEDBACK_ENABLED,
  ROUNDTRIP_HINT_ENABLED,
} from "./config";
import { directionForSession, type WalkDirection } from "../utils/roundtripHint";

type Nav = { navigate: (screen: string, params?: Record<string, any>) => void };

// ⑬ 거리우선/유형별 후보는 이제 별도 RouteCompare 화면이 아니라 도보 탭
// "경로 선택" 시트(WalkContent)에서 바로 고른다 — goToRouteCompareIfEnabled 제거됨.

/**
 * 신호 D — 만족도 입력(또는 건너뛰기) 뒤에 호출. 플래그가 켜져 있고 route_id 가
 * 있으면 `SlowSegmentFeedbackScreen`(pace 상위 구간 게이트형 평가)으로, 아니면
 * 곧장 RouteDetail 로. 물어볼 구간 유무(eligible)는 화면이 마운트 시 GET 으로 판정해
 * 없으면 스스로 통과하므로 여기선 확인하지 않는다.
 *
 * PENDING_WIRE(nav-segfeedback): NavigationScreen.handleRatingSubmit / handleRatingSkip.
 * 호출부는 신규 화면 진입 전 `await syncToServer()`(= completeNavigation) 해야 한다
 * (BE 가 완료 시점에 랭킹을 계산하므로).
 */
export function routeAfterRating(
  navigation: Nav | undefined,
  args: { serverRouteId: number | null; routeSegments: any[]; nextRouteId: string; sessionId?: string | null },
): void {
  if (!navigation) return;
  if (SLOW_SEGMENT_FEEDBACK_ENABLED && args.serverRouteId != null) {
    navigation.navigate("SlowSegmentFeedback", {
      routeSegments: JSON.stringify(args.routeSegments ?? []),
      serverRouteId: String(args.serverRouteId),
      nextRouteId:   args.nextRouteId,
      sessionId:     args.sessionId ?? "",
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
