// 신호 D — "가장 더디게 걸은 구간" 조회/저장 (독립 엔드포인트, 수집 동의 무관).
// 스키마·순수 로직은 src/utils/slowSegmentModel.ts, 화면은 SlowSegmentFeedbackScreen.

import { BASE_URL, getAuthToken } from "../api";
import { SLOW_SEGMENTS_PATH, SEGMENT_HARDSHIP_FEEDBACK_PATH } from "../personalization/config";
import type {
  SlowSegmentsResponse,
  SegmentHardshipPayload,
  SegmentHardshipResponse,
  Verdict,
} from "../utils/slowSegmentModel";

/**
 * GET /navigation/{routeId}/slow-segments
 * - 200 + eligible:false → 물어볼 구간 없음(정상). 그대로 반환.
 * - 404 → 소유 아님/없음. throw.
 * - 네트워크/5xx → 800ms 뒤 1회 재시도(안내 완료 직후 랭킹 계산 지연 대비).
 */
export async function getSlowSegments(
  routeId: number | string,
  idToken?: string,
  opts: { retry?: boolean } = {},
): Promise<SlowSegmentsResponse> {
  const token = idToken ?? (await getAuthToken());
  if (!token) throw new Error("no-auth-token");

  const once = async (): Promise<SlowSegmentsResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(`${BASE_URL}${SLOW_SEGMENTS_PATH(routeId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal:  controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`slow-segments ${res.status}: ${text.slice(0, 200)}`);
      }
      return (await res.json()) as SlowSegmentsResponse;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await once();
  } catch (e) {
    if (opts.retry === false) throw e;
    await new Promise((r) => setTimeout(r, 800));
    return once();
  }
}

/**
 * POST /navigation/{routeId}/segment-hardship-feedback  (upsert)
 * GET 으로 받은 스냅샷 필드를 그대로 되돌려 실어 보낸다 + verdict(1단계 3버튼: -1/0/+1).
 */
export async function postSegmentHardshipFeedback(
  routeId: number | string,
  body: SegmentHardshipPayload,
  idToken?: string,
): Promise<SegmentHardshipResponse> {
  const token = idToken ?? (await getAuthToken());
  if (!token) throw new Error("no-auth-token");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${BASE_URL}${SEGMENT_HARDSHIP_FEEDBACK_PATH(routeId)}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`segment-hardship-feedback ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as SegmentHardshipResponse;
  } finally {
    clearTimeout(timer);
  }
}

export type SegmentHardshipAnswerSummary = {
  seg_index:     number;
  seg_index_end: number;
  verdict:       Verdict;
};

export type GetSegmentHardshipFeedbackResponse = {
  route_id: number;
  answers:  SegmentHardshipAnswerSummary[];
};

/**
 * GET /navigation/{routeId}/segment-hardship-feedback
 * 이 경로에서 실제로 답한 D 신호(주관 평가) 목록 — RouteDetailScreen용.
 * seg_index는 unit_index다: navigation_measurements 기준(서버 소스) 구간에만
 * 안전하게 매칭된다. 로컬 폴백(routeSegments raw edge 인덱스) segments에는
 * 인덱스 체계가 달라 맞지 않으니, 호출측이 dataSource==='server'일 때만 불러야
 * 한다(측정 파이프라인 v2에서 이미 겪은 것과 같은 인덱스 불일치).
 */
export async function getSegmentHardshipFeedback(
  routeId: number | string,
  idToken?: string,
): Promise<GetSegmentHardshipFeedbackResponse> {
  const token = idToken ?? (await getAuthToken());
  if (!token) throw new Error("no-auth-token");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${BASE_URL}${SEGMENT_HARDSHIP_FEEDBACK_PATH(routeId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`segment-hardship-feedback(get) ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as GetSegmentHardshipFeedbackResponse;
  } finally {
    clearTimeout(timer);
  }
}
