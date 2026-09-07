// 신호 D — "가장 더디게 걸은 구간"(1m당 소요시간 pace 순위)에 대한 게이트형 평가.
// 순수 로직만(단위 검증 대상). HTTP 는 src/api/slowSegments.ts, 화면은
// src/screens/route/SlowSegmentFeedbackScreen.tsx.
//
// 흐름(사용자 최종 확정 · 잠금): 구간마다
//   Q1 "소요시간 상위 10위 구간이에요. 불편했나요?"  예 / 아니오      (was_uncomfortable)
//   Q2 Q1="예" 일 때만 → "힘듦 정도 1~10점"                         (hardship_score ∈ 1..10)
//      Q1="아니오" 면 Q2 없이 다음 구간 (hardship_score = null)
//
// 순위/필터는 BE(complete_navigation 시점에 미리 계산)에서 끝나 있고, GET 은
// pace 상위 min(10, 유효구간수) 를 그대로 준다. BE 가 그래프 엣지(~5~10m)를 경사
// bin(±1%p)으로 묶어 "사람이 인지하는 구간"으로 만든 뒤 순위를 매기므로, 한 항목은
// routeSegments[seg_index .. seg_index_end] 범위를 가리킨다. FE 는 받은 스냅샷
// 필드를 그대로 되돌려 싣고 Q1/Q2 만 얹어 POST 한다.

export type SlowSegment = {
  rank:          number;   // 1 = 가장 느린(오래 걸린) 구간
  seg_index:     number;   // 묶은 구간의 시작 엣지 인덱스 (routeSegments 배열)
  seg_index_end: number;   // 묶은 구간의 끝 엣지 인덱스(포함) — 지도 하이라이트/설명용
  distance_m:    number;   // 묶은 구간 길이 합
  slope_pct:     number;   // 부호 있는 길이가중 평균 경사(%)
  direction:     "up" | "down" | "flat" | string;
  zone:          string;   // "flat" | "optimal" | "warning" | "forbidden" ...
  name?:         string;
  elapsed_ms:    number;   // 묶은 구간 실측 소요 합
  pace_s_per_m:  number;   // (elapsed_ms/1000) / distance_m
};

export type SlowSegmentsMeta = {
  total_segments:  number;   // 묶인 구간 수
  sloped_segments: number;   // 경사 있는(|slope|≥0.5%) 구간 수
  ranked:          number;   // 실제 순위 매긴 수 = min(10, sloped_segments)
};

export type SlowSegmentsResponse = {
  eligible:  boolean;
  route_id:  number;
  segments:  SlowSegment[];
  reason?:   "no_measured_segments" | "no_sloped_segments" | "route_not_completed" | string;
  meta?:     SlowSegmentsMeta;
};

export const HARDSHIP_MIN = 1;
export const HARDSHIP_MAX = 10;

// POST 한 건 — GET 스냅샷 필드를 그대로 되돌려 싣고 Q1/Q2 추가.
export type SegmentHardshipAnswer = {
  seg_index:         number;
  seg_index_end:     number;
  rank:              number;
  pace_s_per_m:      number;
  elapsed_ms:        number;
  distance_m:        number;
  slope_pct:         number;
  zone:              string;
  was_uncomfortable: boolean;        // Q1 (불편했나요) — 예=true
  hardship_score:    number | null;  // Q2 — 1..10 정수. was_uncomfortable=false 면 null
};

export type SegmentHardshipPayload = {
  session_id: string | null;
  answers:    SegmentHardshipAnswer[];
};

export type SegmentHardshipResponse = { ok: boolean; count: number };

/** GET 응답이 "물어볼 구간이 있는" 상태인지. 아니면 화면은 조용히 건너뛴다. */
export function hasSlowSegments(r?: SlowSegmentsResponse | null): boolean {
  return !!r && r.eligible === true && Array.isArray(r.segments) && r.segments.length > 0;
}

/** 1..10 정수로 강제. 범위 밖/NaN 이면 null. */
export function clampHardship(v: unknown): number | null {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < HARDSHIP_MIN || n > HARDSHIP_MAX) return null;
  return n;
}

/**
 * 한 구간 응답이 "완료"인지.
 *  - Q1=아니오 → 그걸로 완료
 *  - Q1=예    → 1..10 점수도 있어야 완료
 *  - Q1 미응답 → 미완
 */
export function isSegmentAnswerComplete(
  wasUncomfortable: boolean | undefined,
  hardshipScore: number | null | undefined,
): boolean {
  if (wasUncomfortable === false) return true;
  if (wasUncomfortable === true)  return clampHardship(hardshipScore) !== null;
  return false;
}

/**
 * GET 구간 목록 + Q1/Q2 응답 → POST 본문.
 *  - Q1 이 아직 boolean 이 아닌(미응답) 구간은 제외.
 *  - Q1=아니오 면 hardship_score = null 로 고정.
 *  - 순서는 입력(=rank) 순 유지.
 */
export function buildSegmentAnswers(
  segments: SlowSegment[],
  uncomfortableByIndex: Record<number, boolean | undefined>,
  scoreByIndex: Record<number, number | null | undefined>,
  sessionId?: string | null,
): SegmentHardshipPayload {
  const answers: SegmentHardshipAnswer[] = (Array.isArray(segments) ? segments : [])
    .filter((s) => typeof uncomfortableByIndex?.[s.seg_index] === "boolean")
    .map((s) => {
      const was_uncomfortable = uncomfortableByIndex[s.seg_index] as boolean;
      const hardship_score = was_uncomfortable ? clampHardship(scoreByIndex?.[s.seg_index]) : null;
      return {
        seg_index:     s.seg_index,
        seg_index_end: s.seg_index_end,
        rank:          s.rank,
        pace_s_per_m:  s.pace_s_per_m,
        elapsed_ms:    s.elapsed_ms,
        distance_m:    s.distance_m,
        slope_pct:     s.slope_pct,
        zone:          s.zone,
        was_uncomfortable,
        hardship_score,
      };
    });
  return { session_id: sessionId ?? null, answers };
}

/** 안내 실측 소요(초) — 구간 설명의 "약 N분 걸음" 에 쓴다. */
export function measuredSeconds(s: Pick<SlowSegment, "elapsed_ms">): number {
  const ms = Number(s?.elapsed_ms) || 0;
  return ms > 0 ? ms / 1000 : 0;
}

/** 화면 표시용 — pace 를 사람이 읽게. */
export function fmtPace(paceSPerM: number): string {
  const p = Number(paceSPerM) || 0;
  if (!(p > 0)) return "-";
  return p >= 1 ? `1m에 ${p.toFixed(1)}초` : `${Math.round(p * 100) / 100}초/m`;
}
