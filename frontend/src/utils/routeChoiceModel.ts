// 3경로 비교(⑬) — 후보 정리 & 선택 로그 페이로드 (ando_ml_plan_v2 §6, 인계 §3.2)
//
// 2026-09 제품 결정으로 표시 방식이 바뀌었다:
//   - (예전) §6.5 라벨 절대 금지 + §6.4 표시 순서 매번 무작위(위치 편향 방지, shown_pos 기록).
//   - (지금) 순서 고정 거리 우선 → 유형별 추천 → 사용자 맞춤형(CANDIDATE_ORDER), 라벨도
//     설명적으로 노출(CANDIDATE_LABELS). "순서가 매번 안 바뀌어도 되는 UX"라는 판단.
//   ⚠️ 이 변경으로 §6.4의 위치 편향 방지 근거는 더 이상 유효하지 않다 — chosen_kind 를
//      선택 편향(β·γ) 추정에 그대로 쓰려면 위치 고정 자체가 교란요인이 된다는 점을
//      학습 코드 쪽에서 감안해야 한다. 필요해지면 buildComparison 을 셔플 버전으로 되돌릴 것.
//   - §6.3 중복 병합은 유지: 노드(좌표) 열이 같은 후보끼리 합쳐 유니크한 것만 제시(1~3개).
//   - n_shown = 실제 제시 개수(사용자 맞춤형 "준비중" 자리는 미포함 — 화면 전용 표시라
//     BE 가 실제로 제시한 적 없는 후보를 제시했다고 로그에 남기면 안 됨). 1개뿐이면
//     chosen_kind = null("비교 없음").
//
// 이 모듈은 순수 함수만 — 단위 검증 대상.

import { binCenter } from "./slopeBinTracker";
import type { RouteChoice, RouteChoiceCandidate } from "../api/collect";
import type { MeasurementUnit } from "../api/routeApi";

export type CandidateRoute = {
  kind:          "type" | "distance" | "personal";
  coordinates:   [number, number][];               // [lng, lat]
  totalDistance: number;
  avgSlope:      number;
  estimatedTimeS: number;
  routeSegments: Array<{ slope?: number; length?: number; length_m?: number; slope_pct?: number }>;
  // 안내 화면의 zone 색칠 + 회전 음성안내에 필요 — 없으면 NavigationScreen 이
  // 구식 3%/8% 폴백 색칠로 떨어지고 waypoints 음성안내가 아예 안 나온다.
  navigation_segments?: any[];
  waypoints?: any[];
  // 측정 파이프라인 v2 — GPS 실측 제출 단위(routing/measurement_units.py). 없으면
  // NavigationScreen 이 실측 인덱스 체계를 못 만들어 submitSegment 자체가 불가능해진다.
  measurement_units?: MeasurementUnit[];
};

/** 화면에 실제로 제시되는 후보 1개. */
export type ShownCandidate = {
  shownPos:  number;             // 0,1,2 … 화면 위치 (CANDIDATE_ORDER 순서 고정)
  label:     string;             // CANDIDATE_LABELS[대표 kind]
  route:     CandidateRoute;
  mergedKinds: CandidateRoute["kind"][];  // 병합된 원본 kind 들
};

/** 표시 순서 고정: 거리 우선 → 유형별 추천 → 사용자 맞춤형. */
export const CANDIDATE_ORDER: CandidateRoute["kind"][] = ["distance", "type", "personal"];

/** 화면에 그대로 노출되는 설명적 라벨. */
export const CANDIDATE_LABELS: Record<CandidateRoute["kind"], string> = {
  distance: "최단",
  type:     "유형별 추천",
  personal: "사용자 맞춤형",
};

/** 병합된 kind 목록 중 CANDIDATE_ORDER 상 가장 앞선 것(정렬·라벨·로그의 대표값). */
export function primaryKind(kinds: CandidateRoute["kind"][]): CandidateRoute["kind"] {
  let best = kinds[0];
  let bestIdx = CANDIDATE_ORDER.indexOf(best);
  for (const k of kinds) {
    const idx = CANDIDATE_ORDER.indexOf(k);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) { best = k; bestIdx = idx; }
  }
  return best;
}

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
 * 후보 배열을 받아 좌표 열이 같은 것끼리 병합하고, CANDIDATE_ORDER 고정 순서로
 * 배치해 화면에 제시할 목록을 만든다. (예전 Fisher–Yates 셔플 제거 — 파일 상단 주석 참고.)
 */
export function buildComparison(
  candidates: CandidateRoute[],
): { shown: ShownCandidate[]; nShown: number } {
  // 병합 — 첫 등장 순서 유지, 같은 키면 kind 만 합침
  const byKey = new Map<string, { route: CandidateRoute; kinds: CandidateRoute["kind"][] }>();
  for (const c of candidates ?? []) {
    const k = routeKey(c.coordinates);
    const hit = byKey.get(k);
    if (hit) { if (!hit.kinds.includes(c.kind)) hit.kinds.push(c.kind); }
    else byKey.set(k, { route: c, kinds: [c.kind] });
  }
  const unique = [...byKey.values()];

  // 고정 순서 정렬 (대표 kind 기준)
  unique.sort((a, b) => CANDIDATE_ORDER.indexOf(primaryKind(a.kinds)) - CANDIDATE_ORDER.indexOf(primaryKind(b.kinds)));

  const shown: ShownCandidate[] = unique.map((u, pos) => ({
    shownPos:    pos,
    label:       CANDIDATE_LABELS[primaryKind(u.kinds)] ?? "경로",
    route:       u.route,
    mergedKinds: u.kinds,
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
    kind:      primaryKind(s.mergedKinds),
    profile:   slopeProfile(s.route),
    length_m:  Math.round((s.route.totalDistance ?? 0) * 10) / 10,
    shown_pos: s.shownPos,
  }));

  // n_shown 이 1이면 "비교 없음" → chosen_kind = null (§6.3)
  const chosenKind =
    shown.length <= 1 || !chosen ? null : primaryKind(chosen.mergedKinds);

  return { candidates, n_shown: shown.length, chosen_kind: chosenKind };
}
