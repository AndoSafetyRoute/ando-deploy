// 신호 D — "가장 더디게 걸은 구간" 조회/저장 (독립 엔드포인트, 수집 동의 무관).
// 스키마·순수 로직은 src/utils/slowSegmentModel.ts, 화면은 SlowSegmentFeedbackScreen.

import { BASE_URL, getAuthToken } from "../api";
import { SLOW_SEGMENTS_PATH, SEGMENT_HARDSHIP_FEEDBACK_PATH } from "../personalization/config";
import type {
  SlowSegmentsResponse,
  SegmentHardshipPayload,
  SegmentHardshipResponse,
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
 * GET 으로 받은 스냅샷 필드를 그대로 되돌려 실어 보낸다 + was_uncomfortable(Q1) / hardship_score(Q2).
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
