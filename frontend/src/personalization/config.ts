import * as Location from "expo-location";

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

// RouteDetailScreen — navigation_measurements(BE 실측) 조회. 동의 무관하게
// 호출은 가능하나, 동의 안 했거나 서버 저장 실패면 segments가 빈 배열로 온다.
export const ROUTE_MEASUREMENTS_PATH = (routeId: number | string) =>
  `/navigation/${routeId}/measurements`;

// ── 백엔드 계약 (인계 §3.1 / ando-BE app.py) ────────────────────────────────
// 실제 응답/스펙과 이름이 다르면 여기 상수만 고치면 나머지 코드가 따라간다.
export const COLLECT_BATCH_PATH   = "/collect/batch";
// beginCollection() 시점에 독립적으로 sessions 행을 만든다 — /navigation/start의
// session_id 파라미터(동의 모달 응답을 기다리지 않고 즉시 나감)에만 기대면 "동의가
// unknown이었다가 뒤늦게 granted"된 첫 걸음의 세션이 영영 유실된다(실측: uid 9명·
// route 102개 중 session 1건). 두 경로 모두 session_id가 PK라 중복 호출은 안전.
export const COLLECT_SESSION_START_PATH = "/collect/session/start";
// S0 보완 — 정확도 fallback 첫 픽스 단계 기록. sessions 행이 있어야 의미가
// 있어 collectSessionIdRef(=동의 granted 시에만 존재)가 있을 때만 호출된다 —
// 신호 A/B와 같은 동의 게이트를 자연히 따름(호출부 NavigationScreen.tsx 참고).
export const COLLECT_SESSION_GPS_FIX_PATH = "/collect/session/gps-fix";
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

// ── 측정 파이프라인 v2 — 세션(sessions 테이블) 계약 ─────────────────────────
// /navigation/start 에 session_id 와 함께 실어 보내는 두 값. app.json/package.json
// 의 semver 릴리스 버전과는 별개로, MEASUREMENT_SCHEMA_VERSION 은 "이 클라이언트가
// session_id/measurement_units/gps-batch 등 이 파이프라인 자체를 어떤 모양으로
// 보내는지"의 버전이다 — 앱 배포 없이 프로토콜만 바뀌는 일은 없지만, 나중에 BE가
// schema_ver 로 옛 클라이언트를 분기 처리해야 할 때를 대비해 앱 버전과 분리해 둔다.
// 이 파이프라인의 필드·엔드포인트가 하위호환 없이 바뀔 때만 올린다(패치 배포마다 X).
export const APP_VERSION = "1.0.0";               // package.json/app.json version과 동일하게 유지
export const MEASUREMENT_SCHEMA_VERSION = 1;

// ── 계측 상수 (문서 §3.4 / §4, 팀 Q&A #5) ──────────────────────────────────
// 전부 C등급(근거 없음) — 이 값으로 시작하고 파일럿 로그로 사후 조정한다.
export const SLOPE_BIN_WIDTH_PCT = 0.5;   // ando_ml_plan_v2 §4 설계상수 — 고정

// 직전 GPS 픽스와의 공백이 이보다 길면: 순간속도 표본 제외 + 진행 중이던 bin
// 관측 전체 무효화(invalidateCurrent). 원래 10초(Q&A #5: 30→10)였으나 실기기
// 세션(sess-1789364304261-iy39nwa8, route 169) gps_traces 실측에서 콜백 간격
// dt 가 중앙값 6.9s·p75 12.9s·5s 미만 표본 0건으로 나왔다 — GPS_WATCH_OPTIONS
// .timeInterval=3000ms은 실기기(OS 배터리 최적화 + distanceInterval 조합)에서
// 전혀 보장되지 않고, dt>=10s 콜백이 42%(33/78)라 10s 임계값은 "정상 콜백
// 지연"을 전부 공백으로 오판정해 unitGapPendingRef를 사실상 상시 true로
// 만들고 있었다(navigation_measurements 전량 status='skipped' 원인). 20s로
// 올려 정상 분포(p75=12.9s)는 통과시키되, 관측된 실제 이상치(27.7s, 아마
// 터널/실내 등 진짜 GPS 유실)는 여전히 걸러지는 수준으로 잡는다.
export const SPEED_SAMPLE_MAX_GAP_S = 20;

// S3 — GPS 점프 판정을 고정거리(100m) 기준에서 암묵속도/정확도 기준으로 교체.
// 이유: 100m 고정값은 콜백 간격이 늘어나면(dt 커짐) 정상 보행도 점프로 오판정
// 하고, 반대로 dt가 짧으면 실제 순간이동(GPS 오차)도 못 걸러낸다 — d 자체가
// 아니라 "암묵 속도"(d/dt, 보행이 물리적으로 낼 수 없는 속도)로 판정해야
// dt에 무관하게 일관된 기준이 된다. accuracy 기준은 속도가 우연히 그럴듯해도
// 위치 자체가 부정확하면(저정확도 픽스가 큰 도약을 만들 수 있음) 같이 걸러내기
// 위함. 값 자체는 임의(C등급) — 도보 순간최고속도를 넉넉히 웃도는 선.
export const IMPLIED_SPEED_JUMP_MPS = 3.0;
export const JUMP_ACCURACY_MAX_M = 20;

// 순간속도가 이 값 미만이면 "사실상 정지"로 보고 그 시간을 stop_ms 로 누적한다.
// GPS 정지 지터가 초당 0.1~0.3m 라 그 아래는 정지로 봐야 함(보수적).
// ⚠️ 이건 stop_ms 계산 전용이다. 신호 B(감속) 판정은 v̄_flat×40% 로 학습 시점에
//    오프라인 계산하며 이 상수와 무관하다 (이름이 비슷하니 혼동 금지, Q&A #5).
export const NEAR_STOP_SPEED_MS = 0.15;

// ── S0(GPS 수신 간격 개선) ──────────────────────────────────────────────────
// 목표: 안내 중 콜백 간격 중앙값 ≤2s. 기존 Balanced/timeInterval=3000ms/
// distanceInterval=5m는 실기기 세션(sess-1789364304261-iy39nwa8, route 169)
// 실측에서 중앙값 6.9s·p75 12.9s로 목표에 크게 못 미쳤다(위 SPEED_SAMPLE_MAX_GAP_S
// 주석 인용) — OS 배터리 최적화가 timeInterval 하한을 지키지 않는 상황에서
// Balanced 정확도·5m 이동 요구가 콜백을 추가로 늦춘 것으로 추정된다(실기기
// 미검증 추정 — 근거 C등급).
// BestForNavigation은 GPS 칩에 가장 짧은 갱신주기를 요청해 OS 스케줄링 여유를
// 줄인다. timeInterval을 요청 가능한 하한(1000ms)으로 좁힌다.
export const GPS_ACCURACY = Location.Accuracy.BestForNavigation;
export const GPS_TIME_INTERVAL_MS = 1000;
// S0 보완(2026-09) — 1m에서 0으로 변경. 정지 중에도 콜백이 계속 와야 S2의
// stopClassifier가 '정지'(계속 콜백은 오는데 위치가 안 바뀜)와 'GPS 공백'
// (콜백 자체가 끊김)을 구분할 수 있다 — distanceInterval>0이면 정지 중엔
// timeInterval만으로 콜백이 오길 기대해야 하는데, expo-location 구현상
// distanceInterval 조건이 우선시돼 정지 중 콜백이 거의 안 오는 사례가
// 있었다(팀 실측 근거는 아직 없음 — C등급, S0 재검증 시 확인).
export const GPS_DISTANCE_INTERVAL_M = 0;

// ── S0 보완: 첫 위치 fallback 단계 ──────────────────────────────────────────
// BestForNavigation은 실내·건물 인근에서 GPS 하드웨어 단독 픽스를 기다리다
// 첫 위치가 무한 대기에 빠질 수 있다(옛 Accuracy.High 회피 사유와 동일 문제,
// 더 심할 수 있음). 첫 콜백이 FIRST_FIX_TIMEOUT_S 안에 안 오면 정확도를
// 단계적으로 낮춰 watch를 재시작한다 — High → (그래도 없으면) Balanced.
// 근거 C등급(시간값 임의) — 에뮬레이터로는 이 타임아웃 자체를 검증할 수 없음
// (에뮬레이터는 geo fix 즉시 반영이라 "무한 대기" 상황이 재현 안 됨) →
// docs/device_verification_pending.md.
export const FIRST_FIX_TIMEOUT_S = 15;
export const GPS_ACCURACY_FALLBACK_1 = Location.Accuracy.High;
export const GPS_ACCURACY_FALLBACK_2 = Location.Accuracy.Balanced;
