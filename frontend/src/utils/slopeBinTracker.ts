// 개인화 계측 — 경사 bin 추적 (인계 §5 ⑪, ando_ml_plan_v2 §3.2 신호 A)
//
// NavigationScreen 의 GPS 콜백/구간완료 이벤트를 받아, 0.5% 폭 bin 이 바뀌는
// 시점마다 관측 1행(slope_bin, distance_m, elapsed_ms, stop_ms, gps_sample_n)을
// 만들어 낸다. React 와 무관한 순수 클래스라 단위 검증이 가능하다.
//
// 불변식(관문 검증 대상):
//   - 방출되는 모든 slope_bin 은 0.5 의 배수(부호 포함)
//   - Σ distance_m == 통과한 구간 길이의 합
//   - Σ elapsed_ms == (마지막 방출 시각 - 시작 시각)  ※ 시작 앵커 이후 기준

export const SLOPE_BIN_WIDTH = 0.5;

/** 부호를 유지한 0.5% bin 중심값. 곡선 c_u(g) 가 부호 있는 경사 위에서 정의되므로 오르막/내리막 구분. */
export function binCenter(slopePct: number): number {
  const c = Math.round((Number(slopePct) || 0) / SLOPE_BIN_WIDTH) * SLOPE_BIN_WIDTH;
  return c === 0 ? 0 : c; // -0 정규화
}

export type SlopeObservation = {
  route_id?:     number | null;
  slope_bin:     number;
  distance_m:    number;
  elapsed_ms:    number;
  stop_ms:       number;
  gps_sample_n:  number;
};

export class SlopeBinTracker {
  private bin: number;
  private startTime: number;
  private dist = 0;
  private gpsN = 0;
  private stopMs = 0;
  // GPS 점프/장시간 공백을 만나면 켜진다. 진행 중이던 bin 은 거리·시간이 오염돼
  // 있으므로, 다음 bin 경계까지 누적분을 버리고 관측을 방출하지 않는다 (Q&A #5).
  private poisoned = false;

  constructor(firstSlopePct: number, startTime: number) {
    this.bin = binCenter(firstSlopePct);
    this.startTime = startTime;
  }

  /**
   * GPS 점프(> MAX_JUMP_M) 또는 장시간 공백(> MAX_GAP_S) 감지 시 호출.
   * 지금 누적 중인 bin 구간 전체를 무효화한다 — completeSegment/finalize 는
   * 다음 bin 경계가 새로 시작될 때까지 관측을 방출하지 않는다.
   */
  invalidateCurrent(now: number): void {
    this.poisoned = true;
    this.dist = 0;
    this.gpsN = 0;
    this.stopMs = 0;
    this.startTime = now;
  }

  /** 현재 누적 중인 bin 중심값 (순간속도 표본 귀속용) */
  get currentBin(): number {
    return this.bin;
  }

  /** GPS 콜백 1회 — 현재 bin 표본 수 +1 */
  noteGpsSample(): void {
    this.gpsN += 1;
  }

  /** 현재 bin 안에서 사실상 멈춰 있던 시간 누적 (ms) */
  noteStop(ms: number): void {
    if (ms > 0) this.stopMs += ms;
  }

  /**
   * "실제 이동 시작" 시점에 첫 bin 타이밍을 다시 맞춘다(콜백 2회차).
   * GPS 락 대기 시간이 첫 bin 속도에 섞이지 않도록.
   */
  anchorStart(now: number): void {
    this.startTime = now;
    this.dist = 0;
    this.gpsN = 0;
    this.stopMs = 0;
  }

  /**
   * 구간 하나를 통과 완료. 이 구간 길이를 현재 bin 에 누적하고,
   * 다음 구간이 다른 bin 이거나 경로의 마지막이면 관측 1행을 반환하며 다음 bin 으로 리셋한다.
   * @param nextSlopePct 다음 구간 경사(%). 마지막 구간이면 null.
   */
  completeSegment(
    segLengthM: number,
    nextSlopePct: number | null,
    now: number,
    routeId?: number | null,
  ): SlopeObservation | null {
    this.dist += segLengthM > 0 ? segLengthM : 0;

    const nextBin = nextSlopePct === null ? null : binCenter(nextSlopePct);
    const isBinEnd = nextBin !== this.bin || nextSlopePct === null;
    if (!isBinEnd) return null;

    // 오염된 bin: 관측을 버리고 다음 bin 부터 깨끗하게 다시 시작.
    const obs = this.poisoned ? null : this.snapshot(now, routeId);
    this.poisoned = false;
    this.bin = nextBin ?? 0;
    this.startTime = now;
    this.dist = 0;
    this.gpsN = 0;
    this.stopMs = 0;
    return obs;
  }

  /**
   * 안내 종료 / 화면 언마운트 — 진행 중이던 부분 bin 을 관측 1행으로 확정한다.
   * 누적 거리가 없으면 null. 호출 후 내부 거리만 0으로 비워 이중 방출을 막는다.
   */
  finalize(now: number, routeId?: number | null): SlopeObservation | null {
    if (this.dist <= 0 || this.poisoned) return null;
    const obs = this.snapshot(now, routeId);
    this.dist = 0;
    return obs;
  }

  private snapshot(now: number, routeId?: number | null): SlopeObservation {
    return {
      route_id:     routeId ?? undefined,
      slope_bin:    this.bin,
      distance_m:   this.dist,
      elapsed_ms:   Math.max(0, now - this.startTime),
      stop_ms:      Math.round(this.stopMs),
      gps_sample_n: this.gpsN,
    };
  }
}
