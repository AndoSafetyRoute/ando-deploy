// 신호 D — "가장 더디게 걸은 구간"(1m당 소요시간 pace 순위)에 대한 게이트형 평가.
// 순수 로직만(단위 검증 대상). HTTP 는 src/api/slowSegments.ts, 화면은
// src/screens/route/SlowSegmentFeedbackScreen.tsx.
//
// 흐름(1단계 3버튼 — 2026-09 재설계, 이전 2단계 was_uncomfortable+hardship_score
// 설계 대체): 구간마다
//   "이 구간, 어떠셨나요?"  편했어요(+1) / 보통이었어요(0) / 힘들었어요(-1)  (verdict)
//
// 재설계 이유 — ① 예/아니오 2지선다는 "보통"과 "평지보다 편했다"를 구분 못 해
// s_u(g) 보정항이 음의 방향(더 편함) 데이터를 아예 못 받는 커버리지 구멍이었다
// (내리막처럼 속도는 빠른데 체감은 힘들 수 있는 비대칭 구간을 놓침). ② 10점
// 척도는 명목상 해상도일 뿐 s_u(g)가 저차 보정항(매듭 3개 수준)이라 못 씀. ③
// 지금 병목은 정밀도가 아니라 응답률(2단계 인터랙션 → 경로당 탭 최대 10회를
// 1단계 최대 5회로 줄임). 3점이 부족하면(예: "힘들었어요" 응답이 과밀해 구분이
// 안 되면) 그때 5점으로 확장 — 3→5는 쉽지만 반대는 데이터를 버려야 한다.
//
// 순위/필터는 BE(complete_navigation 시점에 미리 계산)에서 끝나 있고, GET 은
// pace 상위 min(10, 유효구간수) 를 그대로 준다. BE 가 그래프 엣지(~5~10m)를 경사
// bin(±1%p)으로 묶어 "사람이 인지하는 구간"으로 만든 뒤 순위를 매기므로, 한 항목은
// routeSegments[seg_index .. seg_index_end] 범위를 가리킨다. FE 는 받은 스냅샷
// 필드를 그대로 되돌려 싣고 verdict 만 얹어 POST 한다.

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
  pace_s_per_m:  number;   // (elapsed_ms/1000) / distance_m (S4부터 이동시간 기준)
  // S4 — 순위(rank) + 무작위 대조(random) 구성. asked_by로 구분. 화면 표시
  // 순서는 rank가 아니라 question_order(순위/대조를 섞음 — 버튼 순서는 항상 고정
  // 이라 이 순서와 무관). rank_position은 asked_by==='random'이면 null.
  asked_by:       "rank" | "random";
  question_order: number;
  rank_position:  number | null;
};

export type SlowSegmentsMeta = {
  total_segments:    number;   // 묶인 구간 수
  eligible_segments: number;   // 질문 후보 구간 수(valid AND NOT facility, GPS 이상치 제외)
  ranked:            number;   // 순위 문항 수 = min(SLOW_SEG_MAX_RANKED, eligible_segments)
  random_asked?:     number;   // 무작위 대조 문항 수 = min(SLOW_SEG_RANDOM, 남은 유효 단위)
  target_total?:     number;   // 목표 문항 수(5+2=7)
  asked_total?:      number;   // 실제 문항 수(target_total 미만이면 유효 단위 부족)
};

export type SlowSegmentsResponse = {
  eligible:  boolean;
  route_id:  number;
  segments:  SlowSegment[];
  reason?:   "no_measured_segments" | "no_eligible_segments" | "route_not_completed" | string;
  meta?:     SlowSegmentsMeta;
};

export type Verdict = -1 | 0 | 1; // -1 힘들었어요 / 0 보통이었어요 / +1 편했어요

// POST 한 건 — GET 스냅샷 필드를 그대로 되돌려 싣고 verdict 추가.
export type SegmentHardshipAnswer = {
  seg_index:         number;
  seg_index_end:     number;
  rank:              number;
  pace_s_per_m:      number;
  elapsed_ms:        number;
  distance_m:        number;
  slope_pct:         number;
  zone:              string;
  verdict:           Verdict;
  // S4 — 이 응답이 순위 문항이었는지 무작위 대조였는지(모델 학습 시 구분 필요).
  asked_by:          "rank" | "random";
  rank_position:     number | null;
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

/** 한 구간 응답이 "완료"인지 — 3버튼 중 하나를 눌렀으면 그걸로 끝(추가 질문 없음). */
export function isSegmentAnswerComplete(verdict: Verdict | undefined): boolean {
  return verdict === -1 || verdict === 0 || verdict === 1;
}

/**
 * GET 구간 목록 + verdict 응답 → POST 본문.
 *  - 아직 안 누른(undefined) 구간은 제외.
 *  - 순서는 입력(=rank) 순 유지.
 */
export function buildSegmentAnswers(
  segments: SlowSegment[],
  verdictByIndex: Record<number, Verdict | undefined>,
  sessionId?: string | null,
): SegmentHardshipPayload {
  const answers: SegmentHardshipAnswer[] = (Array.isArray(segments) ? segments : [])
    .filter((s) => isSegmentAnswerComplete(verdictByIndex?.[s.seg_index]))
    .map((s) => ({
      seg_index:     s.seg_index,
      seg_index_end: s.seg_index_end,
      rank:          s.rank,
      pace_s_per_m:  s.pace_s_per_m,
      elapsed_ms:    s.elapsed_ms,
      distance_m:    s.distance_m,
      slope_pct:     s.slope_pct,
      zone:          s.zone,
      verdict:       verdictByIndex[s.seg_index] as Verdict,
      asked_by:      s.asked_by,
      rank_position: s.rank_position,
    }));
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
