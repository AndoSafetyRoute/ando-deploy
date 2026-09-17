// S2 회귀 테스트 — stopClassifier 순수 로직. 지시된 시나리오 1~7 그대로 재현.
// 실행: npx tsx scripts/stopClassifier_test.ts   (frontend/ 에서)

import {
  classifyWindow,
  classifyElapsed,
  aggregateRow,
  computeVStop,
  type GpsFix,
} from "../src/utils/stopClassifier";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

// 서울 근방 기준점 — 위경도 오프셋을 m 단위로 근사 변환해 fix 생성.
const BASE_LAT = 37.5, BASE_LON = 127.0;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((BASE_LAT * Math.PI) / 180);

function offset(distM: number, bearingDeg: number): { lat: number; lon: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(rad)) / M_PER_DEG_LAT;
  const dLon = (distM * Math.sin(rad)) / M_PER_DEG_LON;
  return { lat: BASE_LAT + dLat, lon: BASE_LON + dLon };
}

function fix(t_ms: number, distFromBaseM: number, accuracy: number | null, speed: number | null): GpsFix {
  const { lat, lon } = offset(distFromBaseM, 90);
  return { t_ms, lat, lon, accuracy_m: accuracy, speed_mps: speed };
}

const V_STOP = computeVStop(null); // 0.4 m/s 기본값

// ── 1) 정상 보행 1.2 m/s ──────────────────────────────────────────────────────
function testScenario1_normalWalk() {
  const fixes: GpsFix[] = [0, 2000, 4000, 6000].map((t) => fix(t, (t / 1000) * 1.2, 5, 1.2));
  const stepDelta = 8; // 6초 * 1.2m/s = 7.2m, 보폭 ~0.7m 기준 약 10보 — 여유 두고 8
  const r = classifyWindow(fixes, stepDelta, V_STOP, null);
  assert(r.stopClass === "moving", `정상보행이 moving 아님: ${r.stopClass}`);
  console.log("[1] 정상 보행 1.2m/s → moving");
}

// ── 2) 횡단보도 근처 40초 정지 (정확도 양호, 걸음 수 0) ─────────────────────────
function testScenario2_crossingStop() {
  const fixes: GpsFix[] = [0, 2000, 4000, 6000].map((t) => fix(t, 0, 5, 0));
  const r = classifyWindow(fixes, 0, V_STOP, 10 /* 횡단보도 10m 이내 */);
  assert(r.stopClass === "confirmed_stop", `횡단보도 정지가 confirmed_stop 아님: ${r.stopClass}`);
  assert(r.nearCrossing === true, "횡단보도 근접인데 nearCrossing=false");
  console.log("[2] 횡단보도 근처 정지(40초 중 6초 창, 걸음수0) → confirmed_stop, nearCrossing=true");
}

// ── 3) 25초 GPS 공백 ──────────────────────────────────────────────────────────
function testScenario3_gpsGap() {
  const fixes: GpsFix[] = [fix(0, 0, 5, 1.0), fix(25_000, 5, 5, 1.0)]; // 25s 공백
  const r = classifyWindow(fixes, 5, V_STOP, null);
  assert(r.stopClass === "gps_gap", `25초 공백인데 gps_gap 아님: ${r.stopClass}`);
  console.log("[3] 25초 GPS 공백 → gps_gap (걸음수 있어도 공백이 최우선)");
}

// ── 4) 60m 위치 점프 1회 ──────────────────────────────────────────────────────
function testScenario4_positionJump() {
  const fixes: GpsFix[] = [fix(0, 0, 5, 1.0), fix(2000, 60, 5, 1.0), fix(4000, 61, 5, 0.5)];
  const r = classifyWindow(fixes, 1, V_STOP, null); // 실제 걸음은 거의 없음(GPS 오차성 점프)
  assert(r.stopClass !== "confirmed_stop", `60m 점프인데 confirmed_stop으로 오판: ${r.stopClass}`);
  assert(r.stopClass === "uncertain", `60m 점프의 기대 분류는 uncertain: ${r.stopClass}`);
  console.log("[4] 60m 위치 점프 → uncertain (confirmed_stop으로 오판 안 함)");
}

// ── 5) accuracy 30m 구간 20초 ─────────────────────────────────────────────────
function testScenario5_lowAccuracy() {
  const fixes: GpsFix[] = [0, 6000, 12000, 18000].map((t) => fix(t, 0, 30, 0.1));
  const r = classifyWindow(fixes, 0, V_STOP, null);
  assert(r.stopClass === "uncertain", `저정확도(30m)인데 uncertain 아님: ${r.stopClass}`);
  console.log("[5] accuracy 30m(>15m 임계) → uncertain (정지처럼 보여도 신뢰 못함)");
}

// ── 6) 매우 느린 보행 0.5 m/s (정지로 오판 안 하는지) ────────────────────────────
function testScenario6_verySlowWalk() {
  const fixes: GpsFix[] = [0, 2000, 4000, 6000].map((t) => fix(t, (t / 1000) * 0.5, 5, 0.5));
  // 걸음 수 데이터 없음(null) — 속도(0.5 m/s)만으로 판정해야 하는 상황을 재현.
  const r = classifyWindow(fixes, null, V_STOP, null);
  assert(r.stopClass !== "confirmed_stop", `0.5m/s 저속보행을 정지로 오판: ${r.stopClass}`);
  console.log(`[6] 매우 느린 보행 0.5m/s(V_STOP=${V_STOP}) → ${r.stopClass} (confirmed_stop 아님)`);
}

// ── 7) 걸음 수 null(센서 없음) 버전의 시나리오 2 ────────────────────────────────
function testScenario7_crossingStopNullSteps() {
  const fixes: GpsFix[] = [0, 2000, 4000, 6000].map((t) => fix(t, 0, 5, 0));
  const r = classifyWindow(fixes, null, V_STOP, 10);
  assert(r.stopClass === "confirmed_stop", `걸음수 null이어도 정지 판정 가능해야 함: ${r.stopClass}`);
  assert(r.nearCrossing === true, "걸음수 null 케이스에서 nearCrossing 유실");
  console.log("[7] 걸음 수 null(센서 없음) + 횡단보도 정지 → confirmed_stop 유지(조건 생략 동작)");
}

// ── 집계 규칙 ─────────────────────────────────────────────────────────────────
function testAggregateInvalidatesOnGapOrUncertain() {
  const agg = aggregateRow(
    [
      { stopClass: "moving", durationMs: 2000, nearCrossing: false },
      { stopClass: "gps_gap", durationMs: 2000, nearCrossing: false },
    ],
    4000,
    false,
  );
  assert(agg.valid === false, "gps_gap 포함인데 valid=true");
  assert(agg.stopClass === "gps_gap", `최악 분류가 gps_gap이어야 함: ${agg.stopClass}`);
  console.log("[8] 집계: gps_gap 포함 → valid=false, stopClass=gps_gap(최악)");
}

function testAggregateDwellAndMoving() {
  const agg = aggregateRow(
    [
      { stopClass: "moving", durationMs: 3000, nearCrossing: false },
      { stopClass: "confirmed_stop", durationMs: 5000, nearCrossing: true },
      { stopClass: "moving", durationMs: 2000, nearCrossing: false },
    ],
    10_000,
    false,
  );
  assert(agg.valid === true, "moving+confirmed_stop만 있는데 valid=false");
  assert(agg.dwellMs === 5000, `dwellMs 계산 오류: ${agg.dwellMs}`);
  assert(agg.movingMs === 5000, `movingMs 계산 오류(10000-5000): ${agg.movingMs}`);
  assert(agg.nearCrossing === true, "nearCrossing 유실");
  console.log("[9] 집계: dwell_ms 누적 + moving_ms=elapsed-dwell 정상, valid=true");
}

function testAggregateFacilityFlagPassthrough() {
  const agg = aggregateRow([{ stopClass: "moving", durationMs: 1000, nearCrossing: false }], 1000, true);
  assert(agg.facility === true, "facility 플래그가 그대로 전달 안 됨");
  console.log("[10] 집계: facility 플래그(호출부 판단)는 그대로 전달");
}

// ── NavigationScreen의 catch-up/gapPendingAtStart로 status='skipped' 처리되는
// 상황(GPS 공백/큰 점프)을, 만약 그 unit을 그대로 classifyElapsed에 넣었다면
// 어떻게 되는지 확인 — "FE가 status='skipped'로 아예 안 보내는 것"과
// "stopClassifier가 그런 구간을 valid=false로 판정하는 것"이 서로 모순되지
// 않고 일관됨을 보장한다(둘 중 하나가 다르게 바뀌어도 서로 안전망이 되게).
function testSkippedUnitScenarios_wouldStayInvalid() {
  // gapPendingAtStart 상황 재현: unit 진행 중 25초 GPS 공백(SPEED_SAMPLE_MAX_GAP_S=20 초과)
  const gapFixes: GpsFix[] = [fix(0, 0, 5, 1.0), fix(25_000, 5, 5, 1.0), fix(27_000, 10, 5, 1.0)];
  const aggGap = classifyElapsed(gapFixes, 0, 27_000, computeVStop(null), () => 3, false, null);
  assert(aggGap.valid === false, `GPS 공백 unit인데 valid=true: ${JSON.stringify(aggGap)}`);

  // catch-up 상황 재현: 콜백 사이 60m 점프(여러 unit을 건너뜀) — 시간 공백은 없지만 공간이 튐
  const jumpFixes: GpsFix[] = [fix(0, 0, 5, 1.0), fix(2000, 60, 5, 1.0), fix(4000, 61, 5, 1.0)];
  const aggJump = classifyElapsed(jumpFixes, 0, 4000, computeVStop(null), () => 0, false, null);
  assert(aggJump.valid === false, `위치 점프 unit인데 valid=true: ${JSON.stringify(aggJump)}`);

  console.log("[11] catch-up/gapPendingAtStart로 skip되는 상황을 classifyElapsed에 넣어도 valid=false 일관됨");
}

testScenario1_normalWalk();
testScenario2_crossingStop();
testScenario3_gpsGap();
testScenario4_positionJump();
testScenario5_lowAccuracy();
testScenario6_verySlowWalk();
testScenario7_crossingStopNullSteps();
testAggregateInvalidatesOnGapOrUncertain();
testAggregateDwellAndMoving();
testAggregateFacilityFlagPassthrough();
testSkippedUnitScenarios_wouldStayInvalid();
console.log("\nALL OK");
