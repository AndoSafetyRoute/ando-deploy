// S1 — 걸음 수 링버퍼 순수 로직(React Native/expo-sensors 의존 없음 — 헤드리스
// 테스트 대상). 센서 연결은 utils/stepTracker.ts가 담당.

const RING_WINDOW_MS = 60_000;

export type StepSample = { t_ms: number; cumulative: number };

export class StepRingBuffer {
  private samples: StepSample[] = [];

  push(sample: StepSample): void {
    if (this.samples.length > 0 && sample.t_ms < this.samples[this.samples.length - 1].t_ms) {
      return; // 시간 역행 샘플은 무시(방어적 — 정상 흐름에선 발생 안 함)
    }
    this.samples.push(sample);
    const cutoff = sample.t_ms - RING_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[1].t_ms <= cutoff) this.samples.shift();
  }

  /** 현재 버퍼에 있는 샘플 수(테스트/디버그용). */
  size(): number {
    return this.samples.length;
  }

  /**
   * t0~t1 구간의 걸음 수 증가분. 경계 시각은 앞뒤 기록 사이를 선형보간.
   * 샘플이 2개 미만이거나 판정 불가면 null(0으로 단정하면 "정지"와 "측정 못
   * 함"이 구분 안 됨 — S2 stopClassifier가 이 null을 "걸음 수 조건 생략"으로
   * 처리해야 하는 이유).
   */
  stepsBetween(t0: number, t1: number): number | null {
    if (this.samples.length < 2) return null;
    const v0 = this.interpolate(t0);
    const v1 = this.interpolate(t1);
    if (v0 == null || v1 == null) return null;
    return Math.max(0, v1 - v0);
  }

  private interpolate(t: number): number | null {
    const s = this.samples;
    const first = s[0], last = s[s.length - 1];
    if (t <= first.t_ms) return first.cumulative;
    if (t >= last.t_ms) return last.cumulative;
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1];
      if (a.t_ms <= t && t <= b.t_ms) {
        const span = b.t_ms - a.t_ms;
        if (span <= 0) return a.cumulative;
        const frac = (t - a.t_ms) / span;
        return a.cumulative + frac * (b.cumulative - a.cumulative);
      }
    }
    return null;
  }
}
