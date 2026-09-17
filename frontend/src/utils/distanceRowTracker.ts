// S3 — 신호 A 행 구조 변경. slopeBinTracker.ts(0.5% bin 변화 기준 방출)를
// 대체한다 — 행 방출 기준이 "경사 bin 변화"가 아니라 "고정 거리(ROW_LEN_M)".
// bin은 더 이상 FE 책임이 아니다(학습 시점에 slope_mean으로 계산) — 여기서는
// 연속값(slope_mean/slope_max/ascent_m/descent_m)만 만든다.
//
// React 와 무관한 순수 클래스(slopeBinTracker.ts와 동일 원칙) — 헤드리스 테스트 대상.

export const ROW_LEN_M = 25;

export type DistanceRowObservation = {
  route_id?:   number | null;
  distance_m:  number;
  slope_mean:  number;   // 거리가중평균(부호 있음, %)
  slope_max:   number;   // 절댓값 최대(%)
  ascent_m:    number;   // Σ max(0, 구간 length*slope/100)
  descent_m:   number;   // Σ max(0, -구간 length*slope/100)
  elapsed_ms:  number;
  // 절대 시각(ms, Date.now() 기준) — 호출부가 recentFixesRef에서 이 구간에
  // 해당하는 GPS 픽스를 다시 슬라이스해 stopClassifier에 넣을 때 필요
  // (elapsed_ms만으론 "몇 시부터 몇 시까지"를 복원할 수 없음).
  start_ms:    number;
  end_ms:      number;
  // 이 행을 구성한 raw edge 중 하나라도 계단(S6.5 is_stairs)이면 true.
  facility:    boolean;
};

function mergeObservations(a: DistanceRowObservation, b: DistanceRowObservation): DistanceRowObservation {
  const dist = a.distance_m + b.distance_m;
  const wsum = a.slope_mean * a.distance_m + b.slope_mean * b.distance_m;
  return {
    route_id:    a.route_id ?? b.route_id,
    distance_m:  dist,
    slope_mean:  dist > 0 ? wsum / dist : 0,
    slope_max:   Math.max(a.slope_max, b.slope_max),
    ascent_m:    a.ascent_m + b.ascent_m,
    descent_m:   a.descent_m + b.descent_m,
    elapsed_ms:  a.elapsed_ms + b.elapsed_ms,
    start_ms:    Math.min(a.start_ms, b.start_ms),
    end_ms:      Math.max(a.end_ms, b.end_ms),
    facility:    a.facility || b.facility,
  };
}

export class DistanceRowTracker {
  private startTime: number;
  private dist = 0;
  private wsum = 0;
  private slopeMax = 0;
  private ascent = 0;
  private descent = 0;
  private facility = false;
  private poisoned = false;
  // 방금 완성된 행을 바로 내보내지 않고 한 틱 보류한다 — 경로 끝의 자투리
  // (<ROW_LEN_M)를 "다음 행"이 아니라(스트리밍이라 다음 행이 없을 수 있음)
  // 직전에 보류해 둔 이 행에 병합하기 위함(finalize() 참고).
  private pending: DistanceRowObservation | null = null;

  constructor(startTime: number) {
    this.startTime = startTime;
  }

  /** GPS 점프/장시간 공백 — 진행 중이던 행을 무효화(다음 경계까지 미방출). */
  invalidateCurrent(now: number): void {
    this.poisoned = true;
    this.resetAccum(now);
  }

  /** "실제 이동 시작" 시점에 타이밍 재설정(콜백 2회차) — GPS 락 대기 배제. */
  anchorStart(now: number): void {
    this.resetAccum(now);
  }

  private resetAccum(now: number): void {
    this.dist = 0; this.wsum = 0; this.slopeMax = 0; this.ascent = 0; this.descent = 0;
    this.facility = false;
    this.startTime = now;
  }

  /**
   * 구간(raw edge) 하나를 누적하고, 누적 거리가 ROW_LEN_M 이상이면 완성된
   * 행을 만든다. 반환값은 "이번에 완성된 행"이 아니라 "직전에 보류돼 있던
   * 행"이다(1행 지연 스트리밍 — pending 필드 주석 참고). 오염된 상태로
   * 완성된 행은 버려진다(다음 경계부터 다시 시작).
   * isStairs: 이 raw edge(S6.5 is_stairs) — 행 안 어느 하나라도 true면 facility=true.
   */
  completeSegment(
    segLengthM: number,
    slopePct: number,
    now: number,
    routeId?: number | null,
    isStairs = false,
  ): DistanceRowObservation | null {
    const len = segLengthM > 0 ? segLengthM : 0;
    this.dist += len;
    this.wsum += slopePct * len;
    this.slopeMax = Math.max(this.slopeMax, Math.abs(slopePct));
    if (isStairs) this.facility = true;
    const deltaElevM = (slopePct / 100) * len;
    if (deltaElevM > 0) this.ascent += deltaElevM; else this.descent += -deltaElevM;

    if (this.dist < ROW_LEN_M) return null;

    const completed = this.poisoned ? null : this.snapshot(now, routeId);
    this.poisoned = false;
    this.resetAccum(now);

    const toEmit = this.pending;
    this.pending = completed;
    return toEmit;
  }

  /**
   * 안내 종료/언마운트 — 보류 중이던 행 + 진행 중이던 자투리를 정리해 배열로
   * 반환(0~2개). completeSegment()가 누적이 ROW_LEN_M을 넘는 즉시 완성·리셋
   * 하므로, 여기 남은 자투리(this.dist)는 항상 ROW_LEN_M 미만이다 — 그래서
   * 보류 행이 있으면 항상 거기 병합한다(스펙: "잔여 구간이 최소 거리 미만이면
   * 다음 행에 병합" — 스트리밍 특성상 "직전 행에 병합"으로 구현, 결과는 동일
   * 하게 "짧은 행이 단독으로 남지 않는다").
   */
  finalize(now: number, routeId?: number | null): DistanceRowObservation[] {
    const tail = (!this.poisoned && this.dist > 0) ? this.snapshot(now, routeId) : null;
    const out: DistanceRowObservation[] = [];

    if (this.pending && tail) {
      out.push(mergeObservations(this.pending, tail));
    } else if (this.pending) {
      out.push(this.pending);
    } else if (tail) {
      out.push(tail);
    }

    this.pending = null;
    this.dist = 0;
    return out;
  }

  private snapshot(now: number, routeId?: number | null): DistanceRowObservation {
    return {
      route_id:   routeId ?? undefined,
      distance_m: this.dist,
      slope_mean: this.dist > 0 ? this.wsum / this.dist : 0,
      slope_max:  this.slopeMax,
      ascent_m:   this.ascent,
      descent_m:  this.descent,
      elapsed_ms: Math.max(0, now - this.startTime),
      start_ms:   this.startTime,
      end_ms:     now,
      facility:   this.facility,
    };
  }
}
