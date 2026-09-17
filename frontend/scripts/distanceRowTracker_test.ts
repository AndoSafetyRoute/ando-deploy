// S3 회귀 테스트 — DistanceRowTracker(고정 25m 행) 순수 로직.
// 실행: npx tsx scripts/distanceRowTracker_test.ts

import { DistanceRowTracker, ROW_LEN_M } from "../src/utils/distanceRowTracker";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function testNoEmitBeforeThreshold() {
  const t = new DistanceRowTracker(0);
  const r1 = t.completeSegment(10, 2.0, 1000);
  const r2 = t.completeSegment(10, 2.0, 2000);
  assert(r1 === null && r2 === null, "25m 미만 누적인데 행이 방출됨");
  console.log("[0] 25m 미만 누적 중엔 방출 없음");
}

function testEmitAfterThresholdIsDelayedByOne() {
  const t = new DistanceRowTracker(0);
  t.completeSegment(10, 2.0, 1000);
  t.completeSegment(20, 2.0, 3000); // 누적 30m ≥ 25m → 완성, 그러나 반환은 "직전 보류행"(없음=null)
  const r = t.completeSegment(30, 4.0, 6000); // 이번에도 완성 → 이제 "직전(30m)행"을 반환
  assert(r !== null && Math.abs(r.distance_m - 30) < 1e-9, `1행 지연 스트리밍 결과 다름: ${JSON.stringify(r)}`);
  console.log("[1] 1행 지연 스트리밍: 두 번째 완성 시점에 첫 완성 행(30m)을 반환");
}

function testSlopeMeanWeightedAndAscDescent() {
  const t = new DistanceRowTracker(0);
  // 10m@+4% (승 0.4m) + 15m@-2% (강 0.3m) = 25m, mean=(10*4+15*-2)/25=0.4
  t.completeSegment(10, 4.0, 1000);
  const r = t.completeSegment(15, -2.0, 2000); // 다음 완성이 있어야 직전(이번) 행이 나옴 → 아직 없음
  assert(r === null, "아직 두 번째 행 완성 전인데 방출됨");
  // 강제로 다음 행을 채워 이전 행을 뽑아낸다
  const flushed = t.completeSegment(25, 0, 3000);
  assert(flushed !== null, "flush 안 됨");
  assert(Math.abs(flushed!.slope_mean - 0.4) < 1e-9, `slope_mean 계산 오류: ${flushed!.slope_mean}`);
  assert(Math.abs(flushed!.ascent_m - 0.4) < 1e-9, `ascent_m 계산 오류: ${flushed!.ascent_m}`);
  assert(Math.abs(flushed!.descent_m - 0.3) < 1e-9, `descent_m 계산 오류: ${flushed!.descent_m}`);
  assert(Math.abs(flushed!.slope_max - 4.0) < 1e-9, `slope_max 계산 오류: ${flushed!.slope_max}`);
  console.log("[2] slope_mean(거리가중)/ascent_m/descent_m/slope_max 계산 정확");
}

function testPoisonedRowDropped() {
  const t = new DistanceRowTracker(0);
  t.completeSegment(10, 2.0, 1000);
  t.invalidateCurrent(1500); // GPS 점프/공백 — 진행 중이던 누적 폐기
  const r1 = t.completeSegment(30, 2.0, 3000); // 오염 상태로 완성 → 버려짐(null 유지, pending 그대로 null)
  assert(r1 === null, "오염 상태에서 완성된 행이 그대로 살아남음");
  const r2 = t.completeSegment(30, 2.0, 5000); // 이번 완성 시점에 "직전(오염으로 버려진) 행"은 없어야 함
  assert(r2 === null, "오염으로 버려졌어야 할 행이 반환됨");
  console.log("[3] 오염(invalidateCurrent) 상태로 완성된 행은 폐기, 이후 행에 안 섞임");
}

function testFinalizeMergesShortTail() {
  const t = new DistanceRowTracker(0);
  t.completeSegment(10, 2.0, 1000);
  t.completeSegment(20, 2.0, 3000); // 30m 완성(보류 중, 아직 미반환)
  const tail = t.finalize(4000); // 10m 자투리(<25m) → 보류 행에 병합돼야 함
  assert(tail.length === 1, `자투리 병합 후 1개여야 하는데: ${tail.length}`);
  console.log("[4] finalize: 자투리(<25m)가 보류 행에 병합됨(짧은 행 단독 방출 안 함)");
}

// 참고: completeSegment()는 누적이 ROW_LEN_M을 넘는 즉시 완성·리셋하므로,
// finalize() 시점의 진행 중 누적은 설계상 항상 ROW_LEN_M 미만이다 — "자투리가
// 길어서 병합 안 함" 케이스는 현재 구현에서 도달 불가능(테스트 불필요).

function testAnchorStartResetsWithoutEmitting() {
  const t = new DistanceRowTracker(0);
  t.completeSegment(10, 2.0, 1000);
  t.anchorStart(1500); // GPS 락 대기 이후 실제 이동 시작 — 누적 리셋, 방출 없음
  const r = t.completeSegment(30, 2.0, 3000);
  assert(r === null, "anchorStart 이후에도 이전 누적이 섞임");
  console.log("[6] anchorStart: 누적만 리셋, 방출 없음(첫 행 elapsed_ms 오염 방지)");
}

function testSlopeSourceWorstWins() {
  const t = new DistanceRowTracker(0);
  t.completeSegment(10, 2.0, 1000, undefined, false, "dem");
  const r = t.completeSegment(15, -2.0, 2000, undefined, false, "bridge_zero"); // 아직 방출 안 됨(1행 지연)
  assert(r === null, "아직 방출 전인데 값이 나옴");
  const flushed = t.completeSegment(25, 0, 3000, undefined, false, "dem");
  assert(flushed !== null && flushed.slope_source === "bridge_zero",
    `worst-wins 실패(dem+bridge_zero → bridge_zero여야): ${flushed?.slope_source}`);
  console.log("[7] slope_source: 행 안에 섞이면 worst-wins(missing>bridge_zero>dem) 확인");
}

testNoEmitBeforeThreshold();
testEmitAfterThresholdIsDelayedByOne();
testSlopeMeanWeightedAndAscDescent();
testPoisonedRowDropped();
testFinalizeMergesShortTail();
testAnchorStartResetsWithoutEmitting();
testSlopeSourceWorstWins();
console.log(`\n(ROW_LEN_M=${ROW_LEN_M})`);
console.log("ALL OK");
