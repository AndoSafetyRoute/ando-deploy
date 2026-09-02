// 개인 맞춤 경로 추천 — 신호 A~D 배치 수집 API (ando_ml_plan_v2 §3, 인계 §3.1)
//
// 개별 전환마다 POST를 쏘지 않는다. 세션 종료 시 1회 + 2분/200행마다 중간 플러시로
// /collect/batch 에 묶어서 보낸다. (uid, session_id, seq) 조합으로 서버가 멱등 처리하므로
// 네트워크 재시도 시 같은 배치를 그대로 다시 보내면 된다.
//
// 전송/오프라인 큐잉/플러시 타이밍은 utils/collectQueue.ts 가 담당하고,
// 이 파일은 순수하게 스키마 + HTTP 한 번만 책임진다.

import { BASE_URL, getAuthToken } from "../api";
import { COLLECT_BATCH_PATH } from "../personalization/config";

// ── 신호 A: 경사 bin별 통과 관측 ────────────────────────────────────────────────
export type SlopeObservation = {
  route_id?:     number | null;   // 서버 routes(id). 세션 시작 응답이 늦거나 실패하면 생략 가능
  slope_bin:     number;          // bin 중심값 (부호 포함, 0.5% 폭). 예: -2.5, 0, 2.5
  distance_m:    number;
  elapsed_ms:    number;
  stop_ms?:      number;          // bin 안에서 멈춰 있던 시간(추정). 생략 시 서버가 0 처리
  gps_sample_n:  number;
};

// ── 신호 B: 순간속도 원본 (판정값 저장 금지 — §3.8) ───────────────────────────
export type SpeedSample = {
  route_id?:      number | null;
  slope_bin:      number;
  sub_distance_m: number;         // 직전 GPS 픽스와의 거리(약 5~10m 조각)
  speed_ms:       number;         // 원본 순간속도. 감속 판정은 학습 시점에 v̄_flat로 계산
};

// ── 신호 C: 경로 선택 ─────────────────────────────────────────────────────────
export type RouteChoiceCandidate = {
  kind:      "type" | "distance" | "personal";
  profile:   { bin: number; length_m: number }[];   // 경사 히스토그램
  length_m:  number;
  shown_pos: number;             // 화면에 표시된 위치 (라벨/순서 편향 보정용)
};

export type RouteChoice = {
  candidates:   RouteChoiceCandidate[];
  n_shown:      number;
  chosen_kind?: "type" | "distance" | "personal" | null;   // null = "비교 없이 진행"
};

// ── 신호 D: 구간 주관 평가 ───────────────────────────────────────────────────
export type SegmentFeedback = {
  route_id?:   number | null;
  slope_mean:  number;
  length_m:    number;
  verdict:     -1 | 0 | 1;        // -1 불편 / 0 보통 / +1 편함
};

// ── 배치 요청 본문 ───────────────────────────────────────────────────────────
export type CollectBatch = {
  session_id:           string;
  seq:                  number;
  slope_observations?:  SlopeObservation[];
  speed_samples?:       SpeedSample[];
  route_choice?:        RouteChoice | null;
  segment_feedback?:    SegmentFeedback[];
};

export type CollectBatchResponse =
  | { ok: true;  duplicate: true }
  | { ok: true;  duplicate: false; saved: Record<string, number | boolean> }
  | { ok: false; reason?: string };

/**
 * /collect/batch 로 배치 1개를 전송한다.
 * - 401(인증 만료/미로그인)·네트워크 오류는 throw → 호출부(collectQueue)가 큐에 남겨 재시도.
 * - 200이면 그대로 반환. duplicate:true 도 "성공"으로 보고 큐에서 제거하면 된다.
 */
export async function postCollectBatch(
  body: CollectBatch,
  idToken?: string,
): Promise<CollectBatchResponse> {
  const token = idToken ?? (await getAuthToken());
  if (!token) throw new Error("no-auth-token");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${BASE_URL}${COLLECT_BATCH_PATH}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`collect/batch ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as CollectBatchResponse;
  } finally {
    clearTimeout(timer);
  }
}
