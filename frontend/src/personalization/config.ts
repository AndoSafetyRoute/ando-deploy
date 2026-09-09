// 개인화 파일럿 — 연결 스위치 & 백엔드 계약 상수 (한 곳에 모음)
//
// BE 구현/동료 WIP 가 준비되면 손대야 할 곳은 두 군데뿐이다:
//   1) 이 파일의 플래그를 켜고, 계약 상수(경로·필드명)가 실제와 다르면 여기서 고친다.
//   2) `docs/personalization-wiring.md` 의 PENDING_WIRE 목록대로 WIP 파일에 한 줄씩 추가한다.
//      (`git grep "PENDING_WIRE"` 로 전부 나온다)
//
// 원칙: 이 플래그들이 전부 false 이면 앱 동작은 지금과 100% 동일하다(안전한 커밋).

// ── 기능 플래그 ──────────────────────────────────────────────────────────────
/**
 * ⑬ 3경로 비교 화면을 도보 경로 흐름에 넣는다.
 * BE(ando-BE/gdy/personalization-v2)가 candidateRoutes 에 type+distance 2장을
 * 항상 채우므로 코드는 준비됐다. 다만 이 플래그는 **파일럿 3세션 로그 전수 검증
 * (⑪⑫ 관문) + 라이브 BE end-to-end 확인 후** true 로 바꾼다 (인계 §관문).
 * false 인 동안 도보 흐름은 지금과 100% 동일하다.
 */
export const ROUTE_COMPARE_ENABLED = false;

/** ⑮ 안내 시작 시 왕복·방향 교대 안내 배너를 띄운다. BE 무관 — 활성. */
export const ROUNDTRIP_HINT_ENABLED = true;

/**
 * 신호 D — 안내 종료 후, BE 가 미리 계산해 둔 "1m당 소요시간(pace) 상위
 * min(10, 유효구간수)" 구간에 대해 구간마다:
 *   Q1 "소요시간 상위 구간이에요. 불편했나요?" 예/아니오
 *   Q1=예 → Q2 "힘듦 정도 1~10점"
 * 을 묻는 `SlowSegmentFeedbackScreen`. 기존 구간평가 화면(편함/보통/불편함)을 **대체**한다.
 * 저장은 수집 동의와 무관한 독립 엔드포인트(always-on).
 *
 * ON (2026-09-07). BE 엔드포인트(GET/POST /navigation/{id}/slow-segments,
 * segment-hardship-feedback = ando-BE gdy/deploy-v2@b181217, Supabase 마이그레이션
 * 3개 실행 완료)가 라이브가 아니면 화면 mount 시 GET 이 404 → 1회 재시도 후
 * 조용히 RouteDetail 로 통과한다(크래시 없음). BE 라이브 시 자동으로 화면이 뜬다.
 */
export const SLOW_SEGMENT_FEEDBACK_ENABLED = true;

// 신호 D 엔드포인트 (BE: ando-BE-pers · 독립 · Bearer 필수 · 소유자 검증). 계약 잠금.
export const SLOW_SEGMENTS_PATH = (routeId: number | string) =>
  `/navigation/${routeId}/slow-segments`;
export const SEGMENT_HARDSHIP_FEEDBACK_PATH = (routeId: number | string) =>
  `/navigation/${routeId}/segment-hardship-feedback`;

// ── 백엔드 계약 (인계 §3.1 / ando-BE app.py) ────────────────────────────────
// 실제 응답/스펙과 이름이 다르면 여기 상수만 고치면 나머지 코드가 따라간다.
export const COLLECT_BATCH_PATH   = "/collect/batch";
export const ROUTE_PATH           = "/route";
export const ROUTE_CANDIDATES_KEY = "candidates";        // 요청 필드: "single" | "compare"
export const ROUTE_CANDIDATES_COMPARE = "compare";
export const CANDIDATE_ROUTES_FIELD = "candidateRoutes"; // 응답 배열 키

/** candidateRoutes[i] 의 필드명. BE 가 snake_case 로 바꾸면 여기만 수정. */
export const CANDIDATE_FIELD = {
  kind:           "kind",
  coordinates:    "coordinates",
  totalDistance:  "totalDistance",
  avgSlope:       "avgSlope",
  estimatedTimeS: "estimatedTimeS",
  routeSegments:  "routeSegments",
} as const;

// ── 계측 상수 (문서 §3.4 / §4, 팀 Q&A #5) ──────────────────────────────────
// 전부 C등급(근거 없음) — 이 값으로 시작하고 파일럿 로그로 사후 조정한다.
export const SLOPE_BIN_WIDTH_PCT = 0.5;   // ando_ml_plan_v2 §4 설계상수 — 고정

// 직전 GPS 픽스와의 공백이 이보다 길면: 순간속도 표본 제외 + 진행 중이던 bin
// 관측 전체 무효화(invalidateCurrent). 보행 1.2m/s 로 10초면 12m 이동이라 그
// 사이 경사가 여러 bin 을 지날 수 있어 귀속이 모호해진다 (Q&A #5: 30→10).
export const SPEED_SAMPLE_MAX_GAP_S = 10;

// 직전 픽스에서 이보다 크게 튀면 점프(지하도·고층 사이 등)로 보고: 그 표본만이
// 아니라 진행 중이던 bin 관측 전체를 무효화한다 — 점프 앞뒤로 거리·시간이
// 오염돼 있어 "그 샘플만 버리기"로는 부족 (Q&A #5).
export const SPEED_SAMPLE_MAX_JUMP_M = 100;

// 순간속도가 이 값 미만이면 "사실상 정지"로 보고 그 시간을 stop_ms 로 누적한다.
// GPS 정지 지터가 초당 0.1~0.3m 라 그 아래는 정지로 봐야 함(보수적).
// ⚠️ 이건 stop_ms 계산 전용이다. 신호 B(감속) 판정은 v̄_flat×40% 로 학습 시점에
//    오프라인 계산하며 이 상수와 무관하다 (이름이 비슷하니 혼동 금지, Q&A #5).
export const NEAR_STOP_SPEED_MS = 0.15;
