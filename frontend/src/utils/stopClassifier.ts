// S2 — 저속 구간 판정 통합. 신호 A 행과 D 측정 단위(navigation_measurements)가
// 반드시 이 함수를 통해서만 '정지'를 판정한다 — P0-2의 NEAR_STOP_SPEED_MS
// 단일 판정(순간속도만 봄)을 대체한다. React Native/센서 의존 없는 순수 로직
// (utils/stepRingBuffer.ts와 동일 원칙 — 헤드리스 테스트 대상).
//
// 판정은 "창"(CLASSIFY_WINDOW_SEC 길이) 단위로 하고, 여러 창을 모아 "행"(신호 A)
// 또는 "측정 단위"(신호 D)를 집계한다 — aggregateRow() 참고.

export type StopClass = "moving" | "gps_gap" | "uncertain" | "confirmed_stop";

export type GpsFix = {
  t_ms: number;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  speed_mps: number | null; // 기기 제공값(위치 차분 아님 — api.ts gpsTraceBuffer와 동일 원칙)
};

// ── config 상수 (근거 등급 — docs/config_reference.md에 기록) ─────────────────
export const GAP_SEC = 20;              // C — 기존 SPEED_SAMPLE_MAX_GAP_S와 동일값 유지
export const STEP_MOVING_MIN = 3;       // C — 창 길이(5~6s) 동안 3걸음 이상이면 이동으로 간주
export const MIN_SAMPLES = 3;           // C — 이보다 적으면 판정 근거 부족
export const ACC_STOP_MAX = 15;         // C — 미터. 이보다 부정확하면 "정지"를 확신 못 함
export const SPREAD_STOP_MAX = 5;       // C — 미터. 창 안 GPS 픽스들의 최대 상호거리
export const NEAR_CROSSING_MAX_M = 15;  // C
export const V_STOP_FLOOR = 0.3;        // C — m/s
export const V_STOP_PERSONAL_RATIO = 0.4;
export const V_STOP_DEFAULT = 0.4;      // m/s — 개인 평지속도 없을 때
// 판정 창 길이 — S0 목표(콜백 간격 중앙값 ≤2s) 달성 전제. 실측 전까지 5~6s권장 중 상단.
export const CLASSIFY_WINDOW_SEC = 6;

/** 개인화된 정지 속도 임계값. 개인 평지 속도 없으면 기본값. */
export function computeVStop(personalFlatSpeedMps: number | null): number {
  if (personalFlatSpeedMps == null || !(personalFlatSpeedMps > 0)) return V_STOP_DEFAULT;
  return Math.max(V_STOP_FLOOR, V_STOP_PERSONAL_RATIO * personalFlatSpeedMps);
}

function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(sa));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type ClassifyResult = { stopClass: StopClass; nearCrossing: boolean };

/**
 * 판정 순서(스펙 고정 — 순서를 바꾸면 안 됨):
 *   1) 연속 샘플 간 최대 간격 > GAP_SEC → gps_gap
 *   2) 걸음 수 증가 ≥ STEP_MOVING_MIN → moving
 *   3) 샘플 수 < MIN_SAMPLES 또는 평균 accuracy > ACC_STOP_MAX → uncertain
 *   4) 위치 퍼짐 < SPREAD_STOP_MAX AND 기기 속도 중앙값 < vStop(없으면 생략)
 *      AND 걸음 수 증가 = 0(null이면 생략) → confirmed_stop
 *   5) 그 외 → uncertain
 *
 * stepDelta: 창 구간의 걸음 수 증가(StepTracker.stepsBetween 결과) — null이면
 * "걸음 수 조건 생략"(센서 없음/거부와 "0걸음 확인함"을 구분).
 * crossingDistM: 가장 가까운 횡단보도 노드까지 거리(m) — 데이터 소스 미확정
 * (그래프에 횡단보도 태그가 없음, 확인 불가 — TODO 참고). null이면 near_crossing
 * 판정 자체를 생략(false).
 */
export function classifyWindow(
  fixes: GpsFix[],
  stepDelta: number | null,
  vStop: number,
  crossingDistM: number | null,
): ClassifyResult {
  if (fixes.length < 2) {
    return { stopClass: "uncertain", nearCrossing: false };
  }

  // 1) GPS 공백
  let maxGapSec = 0;
  for (let i = 1; i < fixes.length; i++) {
    maxGapSec = Math.max(maxGapSec, (fixes[i].t_ms - fixes[i - 1].t_ms) / 1000);
  }
  if (maxGapSec > GAP_SEC) {
    return { stopClass: "gps_gap", nearCrossing: false };
  }

  // 2) 걸음 수로 이동 확정
  if (stepDelta != null && stepDelta >= STEP_MOVING_MIN) {
    return { stopClass: "moving", nearCrossing: false };
  }

  // 3) 불확실(표본 부족/저정확도)
  const accs = fixes.map((f) => f.accuracy_m).filter((a): a is number => a != null);
  const avgAcc = accs.length ? accs.reduce((s, a) => s + a, 0) / accs.length : null;
  if (fixes.length < MIN_SAMPLES || (avgAcc != null && avgAcc > ACC_STOP_MAX)) {
    return { stopClass: "uncertain", nearCrossing: false };
  }

  // 4) 확정 정지
  let spread = 0;
  for (let i = 0; i < fixes.length; i++) {
    for (let j = i + 1; j < fixes.length; j++) {
      spread = Math.max(spread, haversineM(fixes[i], fixes[j]));
    }
  }
  const speeds = fixes.map((f) => f.speed_mps).filter((s): s is number => s != null);
  const speedOk = speeds.length === 0 || median(speeds) < vStop;
  const stepsOk = stepDelta == null || stepDelta === 0;
  if (spread < SPREAD_STOP_MAX && speedOk && stepsOk) {
    const nearCrossing = crossingDistM != null && crossingDistM <= NEAR_CROSSING_MAX_M;
    return { stopClass: "confirmed_stop", nearCrossing };
  }

  // 5) 그 외
  return { stopClass: "uncertain", nearCrossing: false };
}

// ── 집계 (A 행, D 측정 단위 공통) ────────────────────────────────────────────

export type ClassifiedWindow = { stopClass: StopClass; durationMs: number; nearCrossing: boolean };

// "최악"= 데이터 신뢰도가 가장 낮은 상태. gps_gap(완전 결측) > uncertain(애매) >
// confirmed_stop/moving(둘 다 확실히 안다 — 이동 여부만 다름, 결측 없음).
const SEVERITY: Record<StopClass, number> = {
  moving: 0,
  confirmed_stop: 0,
  uncertain: 1,
  gps_gap: 2,
};

export function worstStopClass(windows: ClassifiedWindow[]): StopClass {
  if (windows.length === 0) return "uncertain";
  return windows.reduce(
    (worst, w) => (SEVERITY[w.stopClass] > SEVERITY[worst] ? w.stopClass : worst),
    windows[0].stopClass,
  );
}

export type RowAggregate = {
  stopClass: StopClass;
  valid: boolean;
  dwellMs: number;
  movingMs: number;
  facility: boolean;
  nearCrossing: boolean;
};

/**
 * 집계 규칙(스펙 고정):
 *   gps_gap 또는 uncertain 포함 → valid=false(삭제 아님, 플래그만)
 *   confirmed_stop → dwell_ms 누적, moving_ms = elapsed_ms − dwell_ms
 *   시설 간선 위(호출부가 판단해 전달) → facility=true
 */
/**
 * 구간(신호 A 행 또는 D 측정 단위) 전체를 CLASSIFY_WINDOW_SEC 창으로 잘라
 * 각각 classifyWindow()로 판정한 뒤 aggregateRow()로 합친다 — 호출부(NavigationScreen)가
 * 매번 창을 손수 안 잘라도 되게 하는 편의 함수. fixes는 시간순 정렬 가정.
 */
export function classifyElapsed(
  fixes: GpsFix[],
  startMs: number,
  endMs: number,
  vStop: number,
  getStepDelta: (t0: number, t1: number) => number | null,
  isFacility: boolean,
  crossingDistM: number | null,
): RowAggregate {
  const inRange = fixes.filter((f) => f.t_ms >= startMs && f.t_ms <= endMs);
  const windowMs = CLASSIFY_WINDOW_SEC * 1000;
  const windows: ClassifiedWindow[] = [];
  for (let t = startMs; t < endMs; t += windowMs) {
    const winEnd = Math.min(t + windowMs, endMs);
    const winFixes = inRange.filter((f) => f.t_ms >= t && f.t_ms <= winEnd);
    const stepDelta = getStepDelta(t, winEnd);
    const { stopClass, nearCrossing } = classifyWindow(winFixes, stepDelta, vStop, crossingDistM);
    windows.push({ stopClass, durationMs: winEnd - t, nearCrossing });
  }
  return aggregateRow(windows, endMs - startMs, isFacility);
}

export function aggregateRow(
  windows: ClassifiedWindow[],
  elapsedMs: number,
  isFacility: boolean,
): RowAggregate {
  const stopClass = worstStopClass(windows);
  const hasBadWindow = windows.some((w) => w.stopClass === "gps_gap" || w.stopClass === "uncertain");
  const dwellMs = windows
    .filter((w) => w.stopClass === "confirmed_stop")
    .reduce((sum, w) => sum + w.durationMs, 0);
  const movingMs = Math.max(0, elapsedMs - dwellMs);
  const nearCrossing = windows.some((w) => w.nearCrossing);
  return {
    stopClass,
    valid: !hasBadWindow,
    dwellMs,
    movingMs,
    facility: isFacility,
    nearCrossing,
  };
}
