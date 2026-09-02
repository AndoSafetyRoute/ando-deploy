// 3경로 비교(⑬) — 후보 정리 & 선택 로그 페이로드 (ando_ml_plan_v2 §6, 인계 §3.2)
//
// 문서가 못박은 것:
//   - §6.3 중복 병합: 노드(좌표) 열이 같은 후보끼리 합쳐 유니크한 것만 제시(1~3개).
//     같은 경로를 다르게 보여주면 가짜 선택이 쌓여 β·γ 추정이 오염된다.
//   - §6.5 라벨 절대 금지: 화면엔 "경로 A/B/C" 만. kind("type"/"distance"/"personal")는
//     로그에만 남기고 절대 표시하지 않는다. 표시 순서는 매번 무작위, shown_pos 로 기록.
//   - n_shown = 실제 제시 개수. 1개뿐이면 chosen_kind = null("비교 없음").
//
// 이 모듈은 순수 함수만 — 단위 검증 대상.

import { binCenter } from "./slopeBinTracker";
import type { RouteChoice, RouteChoiceCandidate } from "../api/collect";

export type CandidateRoute = {
  kind:          "type" | "distance" | "personal";
  coordinates:   [number, number][];               // [lng, lat]
  totalDistance: number;
  avgSlope:      number;
  estimatedTimeS: number;
  routeSegments: Array<{ slope?: number; length?: number; length_m?: number; slope_pct?: number }>;
};

/** 화면에 실제로 제시되는 후보 1개 — shown_pos(무작위 위치)와 원본을 함께 들고 있다. */
export type ShownCandidate = {
  shownPos:  number;             // 0,1,2 … 화면 위치 (0=경로 A)
  label:     string;             // "경로 A" 등 — 중립. kind 는 여기 절대 안 들어감
  route:     CandidateRoute;
  mergedKinds: CandidateRoute["kind"][];  // 병합된 원본 kind 들(로그용, 표시 금지)
};

const NEUTRAL_LABELS = ["경로 A", "경로 B", "경로 C", "경로 D"];

/** 좌표 열을 반올림해 경로 동일성 판정용 키로 만든다(§6.3). */
function routeKey(coords: [number, number][]): string {
  if (!coords?.length) return "";
  // 약 1e-5도(≈1m) 격자로 뭉쳐 GPS/부동소수 잡음이 다른 경로로 갈리지 않게.
  return coords.map(([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`).join(";");
}

/** 경사 히스토그램: routeSegments 를 0.5% bin 으로 묶어 길이 합. */
export function slopeProfile(route: CandidateRoute): { bin: number; length_m: number }[] {
  const acc = new Map<number, number>();
  for (const s of route.routeSegments ?? []) {
    const slope = Number(s.slope ?? s.slope_pct ?? 0);
    const len   = Number(s.length ?? s.length_m ?? 0);
    if (!(len > 0)) continue;
    const b = binCenter(slope);
    acc.set(b, (acc.get(b) ?? 0) + len);
  }
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bin, length_m]) => ({ bin, length_m: Math.round(length_m * 10) / 10 }));
}

/**
 * 후보 배열을 받아 ① 좌표 열이 같은 것끼리 병합하고 ② 무작위 순서로 배치해
 * 화면에 제시할 목록을 만든다. rng 는 검증용 주입구(기본 Math.random).
 */
export function buildComparison(
  candidates: CandidateRoute[],
  rng: () => number = Math.random,
): { shown: ShownCandidate[]; nShown: number } {
  // ① 병합 — 첫 등장 순서 유지, 같은 키면 kind 만 합침
  const byKey = new Map<string, { route: CandidateRoute; kinds: CandidateRoute["kind"][] }>();
  for (const c of candidates ?? []) {
    const k = routeKey(c.coordinates);
    const hit = byKey.get(k);
    if (hit) { if (!hit.kinds.includes(c.kind)) hit.kinds.push(c.kind); }
    else byKey.set(k, { route: c, kinds: [c.kind] });
  }
  const unique = [...byKey.values()];

  // ② Fisher–Yates 셔플 (§6.5 표시 순서 매번 무작위)
  const order = unique.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const shown: ShownCandidate[] = order.map((origIdx, pos) => ({
    shownPos:    pos,
    label:       NEUTRAL_LABELS[pos] ?? `경로 ${pos + 1}`,
    route:       unique[origIdx].route,
    mergedKinds: unique[origIdx].kinds,
  }));

  return { shown, nShown: shown.length };
}

/**
 * 선택 결과를 /collect/batch 의 route_choice 페이로드로 변환.
 * @param chosen 사용자가 고른 ShownCandidate. 비교 없이 진행했으면 null.
 */
export function buildRouteChoicePayload(
  shown: ShownCandidate[],
  chosen: ShownCandidate | null,
): RouteChoice {
  const candidates: RouteChoiceCandidate[] = shown.map((s) => ({
    // kind 는 로그에만. 병합된 경우 대표값(첫 kind) 사용.
    kind:      s.mergedKinds[0],
    profile:   slopeProfile(s.route),
    length_m:  Math.round((s.route.totalDistance ?? 0) * 10) / 10,
    shown_pos: s.shownPos,
  }));

  // n_shown 이 1이면 "비교 없음" → chosen_kind = null (§6.3)
  const chosenKind =
    shown.length <= 1 || !chosen ? null : chosen.mergedKinds[0];

  return { candidates, n_shown: shown.length, chosen_kind: chosenKind };
}
