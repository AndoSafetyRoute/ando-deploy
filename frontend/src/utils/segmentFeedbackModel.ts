// 구간 평가 화면 (⑭) — 경사 뚜렷한 구간 1~2개를 골라 "편함/보통/불편함" 을 받는다.
// ando_ml_plan_v2 §3.2 신호 D. 순수 로직만 — 단위 검증 대상.

import { binCenter } from "./slopeBinTracker";

export type RouteSeg = { slope?: number; slope_pct?: number; length?: number; length_m?: number };

export type FeedbackSegment = {
  slope_mean: number;   // 길이가중 평균 경사 (%)
  length_m:   number;
  startIdx:   number;   // routeSegments 배열 내 이 그룹의 시작 인덱스 (지도 하이라이트용)
  endIdx:     number;   // 끝 인덱스(포함)
  // route_id 는 화면에서 serverRouteId 로 채운다 (여기선 다루지 않음)
};

type Opts = {
  maxCount?:     number;  // 최대 몇 개 물어볼지 (기본 2)
  minSlopeAbs?:  number;  // 이 값 미만 경사는 "뚜렷하지 않음" 으로 제외 (기본 3%)
  minLenM?:      number;  // 이 값 미만 구간 제외 (기본 25m)
  minGapGroups?: number;  // 두 개를 고를 때 그룹 인덱스 최소 간격 (기본 2 = 사이에 최소 1개 그룹)
};

/** 연속 구간을 0.5% bin 이 같은 것끼리 묶어 길이가중 평균 경사 그룹으로. */
function groupByBin(segs: RouteSeg[]) {
  const groups: { startIdx: number; endIdx: number; slopeMean: number; lengthM: number }[] = [];
  let cur: { startIdx: number; endIdx: number; wSlope: number; lengthM: number; bin: number } | null = null;
  segs.forEach((s, i) => {
    const slope = Number(s.slope ?? s.slope_pct ?? 0);
    const len = Number(s.length ?? s.length_m ?? 0);
    if (!(len > 0)) return;
    const b = binCenter(slope);
    if (cur && cur.bin === b) {
      cur.wSlope += slope * len;
      cur.lengthM += len;
      cur.endIdx = i;
    } else {
      if (cur) groups.push({ startIdx: cur.startIdx, endIdx: cur.endIdx, slopeMean: cur.wSlope / cur.lengthM, lengthM: cur.lengthM });
      cur = { startIdx: i, endIdx: i, wSlope: slope * len, lengthM: len, bin: b };
    }
  });
  if (cur) groups.push({ startIdx: cur.startIdx, endIdx: cur.endIdx, slopeMean: cur.wSlope / cur.lengthM, lengthM: cur.lengthM });
  return groups;
}

/**
 * 평가를 물어볼 구간을 고른다. 경사 |평균| ≥ minSlopeAbs 이고 길이 ≥ minLenM 인 그룹 중
 * 영향도(|경사|×길이)가 큰 순으로, 서로 붙어있지 않게 최대 maxCount 개.
 * 없으면 빈 배열(→ 화면은 평가 단계를 건너뛴다).
 */
export function pickFeedbackSegments(segs: RouteSeg[], opts: Opts = {}): FeedbackSegment[] {
  const { maxCount = 2, minSlopeAbs = 3, minLenM = 25, minGapGroups = 2 } = opts;

  const groups = groupByBin(segs ?? [])
    .map((g, gi) => ({ ...g, gi }))
    .filter((g) => Math.abs(g.slopeMean) >= minSlopeAbs && g.lengthM >= minLenM)
    .sort((a, b) => Math.abs(b.slopeMean) * b.lengthM - Math.abs(a.slopeMean) * a.lengthM);

  const picked: typeof groups = [];
  for (const g of groups) {
    if (picked.length >= maxCount) break;
    if (picked.some((p) => Math.abs(p.gi - g.gi) < minGapGroups)) continue; // 너무 붙어있으면 건너뜀
    picked.push(g);
  }

  return picked
    .sort((a, b) => a.startIdx - b.startIdx) // 경로 진행 순서대로 물어보기
    .map((g) => ({
      slope_mean: Math.round(g.slopeMean * 10) / 10,
      length_m:   Math.round(g.lengthM * 10) / 10,
      startIdx:   g.startIdx,
      endIdx:     g.endIdx,
    }));
}

/** 응답 라벨 → verdict (-1/0/+1). 화면 탭에서 사용. */
export const VERDICT = { hard: -1, normal: 0, easy: 1 } as const;
export type VerdictLabel = keyof typeof VERDICT;
