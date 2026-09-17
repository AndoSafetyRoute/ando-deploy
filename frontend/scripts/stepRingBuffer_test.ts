// S1 회귀 테스트 — StepRingBuffer 순수 로직(React Native/센서 의존 없음).
// backend/scripts/*_test.py와 같은 패턴: 함수형 테스트 + assert, 프레임워크 없음.
//
// 실행: npx tsx scripts/stepRingBuffer_test.ts   (frontend/ 에서, devDependency tsx)

import { StepRingBuffer } from "../src/utils/stepRingBuffer";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function testBasicInterpolation() {
  const buf = new StepRingBuffer();
  buf.push({ t_ms: 0, cumulative: 0 });
  buf.push({ t_ms: 1000, cumulative: 2 });
  buf.push({ t_ms: 2000, cumulative: 4 });
  const steps = buf.stepsBetween(500, 1500);
  // t=500 → 1(보간), t=1500 → 3(보간) → 차이 2
  assert(steps !== null && Math.abs(steps - 2) < 1e-9, `보간 결과 예상과 다름: ${steps}`);
  console.log("[0] 기본 선형보간:", steps);
}

function testInsufficientSamplesReturnsNull() {
  const buf = new StepRingBuffer();
  assert(buf.stepsBetween(0, 1000) === null, "샘플 0개일 때 null 아님");
  buf.push({ t_ms: 0, cumulative: 0 });
  assert(buf.stepsBetween(0, 1000) === null, "샘플 1개일 때 null 아님");
  console.log("[1] 샘플 부족 시 null(0으로 단정 안 함) 확인");
}

function testWindowEviction() {
  const buf = new StepRingBuffer();
  for (let i = 0; i <= 120; i++) {
    buf.push({ t_ms: i * 1000, cumulative: i });
  }
  // 마지막 push가 t=120000 → 60초 창이면 t<60000 샘플은 버려져야 함(경계 하나는 유지)
  assert(buf.size() <= 62, `링버퍼 크기 초과: ${buf.size()}`);
  console.log("[2] 60초 윈도우 초과분 축출 확인, size=", buf.size());
}

function testOutOfRangeClampsToEdge() {
  const buf = new StepRingBuffer();
  buf.push({ t_ms: 1000, cumulative: 5 });
  buf.push({ t_ms: 2000, cumulative: 10 });
  // 범위 밖 t0(500)는 첫 샘플값(5)으로 클램프 → steps(500~1500)=보간(1500)-5
  const steps = buf.stepsBetween(500, 1500);
  assert(steps !== null && Math.abs(steps - 2.5) < 1e-9, `범위 밖 클램프 결과 다름: ${steps}`);
  console.log("[3] 버퍼 범위 밖 t는 가장자리 샘플로 클램프:", steps);
}

function testZeroStepsWhenStationary() {
  const buf = new StepRingBuffer();
  buf.push({ t_ms: 0, cumulative: 100 });
  buf.push({ t_ms: 5000, cumulative: 100 }); // 5초간 걸음 수 변화 없음(정지)
  const steps = buf.stepsBetween(0, 5000);
  assert(steps === 0, `정지 구간인데 0이 아님: ${steps}`);
  console.log("[4] 걸음 수 변화 없는 구간(정지)은 0 — S2 stopClassifier의 '걸음 수 증가=0' 조건용");
}

function testOutOfOrderSampleIgnored() {
  const buf = new StepRingBuffer();
  buf.push({ t_ms: 2000, cumulative: 10 });
  buf.push({ t_ms: 1000, cumulative: 5 }); // 역행 — 무시돼야 함
  assert(buf.size() === 1, `역행 샘플이 무시되지 않음: size=${buf.size()}`);
  console.log("[5] 시간 역행 샘플 무시 확인");
}

testBasicInterpolation();
testInsufficientSamplesReturnsNull();
testWindowEviction();
testOutOfRangeClampsToEdge();
testZeroStepsWhenStationary();
testOutOfOrderSampleIgnored();
console.log("\nALL OK");
