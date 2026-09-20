// 개인 맞춤 경로 추천 — 신호 A~D 배치 수집 API (ando_ml_plan_v2 §3, 인계 §3.1)
//
// 개별 전환마다 POST를 쏘지 않는다. 세션 종료 시 1회 + 2분/200행마다 중간 플러시로
// /collect/batch 에 묶어서 보낸다. (uid, session_id, seq) 조합으로 서버가 멱등 처리하므로
// 네트워크 재시도 시 같은 배치를 그대로 다시 보내면 된다.
//
// 전송/오프라인 큐잉/플러시 타이밍은 utils/collectQueue.ts 가 담당하고,
// 이 파일은 순수하게 스키마 + HTTP 한 번만 책임진다.

import { BASE_URL, getAuthToken } from "../api";
import {
  COLLECT_BATCH_PATH,
  COLLECT_SESSION_START_PATH,
  COLLECT_SESSION_GPS_FIX_PATH,
} from "../personalization/config";

// ── 신호 A: 고정거리(25m) 행 관측(S3 — 0.5% bin 방출을 대체) ────────────────────
export type SlopeObservation = {
  route_id?:     number | null;   // 서버 routes(id). 세션 시작 응답이 늦거나 실패하면 생략 가능
  distance_m:    number;
  slope_mean:    number;          // 거리가중평균(부호 있음, %). bin은 학습 시점에 계산.
  slope_max:     number;          // 절댓값 최대(%)
  ascent_m:      number;
  descent_m:     number;
  elapsed_ms:    number;
  gps_sample_n:  number;
  // S2(stopClassifier) 집계 — utils/stopClassifier.ts::aggregateRow() 결과 그대로.
  step_delta?:      number | null;
  stop_class?:      "moving" | "gps_gap" | "uncertain" | "confirmed_stop";
  dwell_ms?:        number;
  moving_ms?:       number;
  avg_gps_accuracy?: number | null;
  device_model?:    string | null;
  near_crossing?:   boolean;
  facility?:        boolean;
  valid?:           boolean;
  // stop_class==="uncertain"일 때만 채워짐 — 사후 역추적용(2026-09).
  uncertain_reason?: "low_sample" | "low_accuracy" | "step_deadzone" | "other" | null;
  // S6 — 이 행(worst-wins 집계, utils/distanceRowTracker.ts)의 slope 신뢰도.
  slope_source?:    "dem" | "bridge_zero" | "missing";
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

// ── 경로 형상 스냅샷 (세션당 1회) ────────────────────────────────────────────
// /navigation/start 가 실패해 route_id 가 없어도 "그 세션이 어떤 경로였나"를
// 잃지 않도록, 세션 첫 배치에만 실어 보낸다. BE 는 session_route_profile 에 UPSERT.
export type RouteProfile = {
  route_id?:       number | null;
  total_length_m?: number;
  segments:        { slope: number; length_m: number }[];   // 부호 있는 경사(%)
  coordinates?:    [number, number][];                      // [[lng,lat], ...] (선택)
};

// ── 배치 요청 본문 ───────────────────────────────────────────────────────────
export type CollectBatch = {
  session_id:           string;
  seq:                  number;
  slope_observations?:  SlopeObservation[];
  speed_samples?:       SpeedSample[];
  route_choice?:        RouteChoice | null;
  segment_feedback?:    SegmentFeedback[];
  route_profile?:       RouteProfile | null;
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
// ── 세션 시작 (독립 — /navigation/start와 순서 무관) ────────────────────────
export type CollectSessionStart = {
  sessionId:  string;
  walkerType: string;
  appVersion: string;
  schemaVer:  number;
};

/**
 * /collect/session/start 로 sessions 행을 생성한다. beginCollection() 시점(동의
 * 확정 즉시)에 best-effort로 부른다 — 실패해도 던지지 않고 호출부가 삼킨다.
 * session_id가 PK라 재시도/중복 호출은 서버가 멱등 처리(ON CONFLICT DO NOTHING).
 */
export async function startCollectSession(
  body: CollectSessionStart,
  idToken?: string,
): Promise<void> {
  const token = idToken ?? (await getAuthToken());
  if (!token) throw new Error("no-auth-token");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${BASE_URL}${COLLECT_SESSION_START_PATH}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id:  body.sessionId,
        walker_type: body.walkerType,
        app_version: body.appVersion,
        schema_ver:  body.schemaVer,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`collect/session/start ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export type GpsFixStageReport = {
  sessionId: string;
  stage:     string;   // 'best_nav' | 'high' | 'balanced' | 'none'
  fixMs:     number;   // watch 시작~첫 픽스 수신까지(ms)
};

/**
 * S0 보완 — 정확도 fallback으로 첫 픽스를 받은 단계와 소요시간을 sessions에
 * 기록(분석 시 "이 세션이 어느 정확도 단계로 시작됐는지" 구분용). 세션당 1회,
 * 첫 픽스 수신 직후 호출. 실패해도 던지지 않는다(진단용 부가 정보라 안내
 * 흐름을 막을 이유가 없음 — 다른 best-effort 호출과 동일 원칙).
 */
export async function reportGpsFixStage(
  body: GpsFixStageReport,
  idToken?: string,
): Promise<void> {
  const token = idToken ?? (await getAuthToken());
  if (!token) return;
  try {
    await fetch(`${BASE_URL}${COLLECT_SESSION_GPS_FIX_PATH}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: body.sessionId,
        stage:      body.stage,
        fix_ms:     body.fixMs,
      }),
    });
  } catch {
    /* best-effort */
  }
}

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
