// GPS 원본 궤적 배치 큐 — 측정 파이프라인 v2 (POST /collect/gps-batch).
//
// utils/collectQueue.ts(CollectSession, 신호 A~D)와 같은 "주기적 플러시 + 크기
// 트리거" 구조를 따르지만 두 가지가 다르다:
//
//   1) 오프라인 AsyncStorage 재큐잉을 넣지 않았다 — gps_traces는 navigation_
//      measurements·신호 A/B로 이미 핵심 지표(실제 판정에 쓰이는 값)가 보존된
//      뒤에 남는 보조·검증용 원본이라, 전송 실패로 일부 유실돼도 감내할 수
//      있다고 판단했다(신호 A~D는 그 자체가 학습 데이터의 원천이라 유실을
//      감내 못 해 오프라인 큐가 필요했던 것과 다름). 필요해지면 collectQueue.ts의
//      오프라인 큐 인프라를 일반화해 재사용할 것 — 이번엔 범위를 넘는다고 판단.
//
//   2) 버퍼 크기/주기를 CollectSession의 것(FLUSH_INTERVAL_MS=120_000,
//      FLUSH_ROW_LIMIT=200)과 다르게 잡았다 — 그 값은 신호 A~D(이벤트당 드물게
//      1행)용으로 잡힌 것이고, GPS_WATCH_OPTIONS(distanceInterval 5m /
//      timeInterval 3000ms, 도보 속도 기준 실측 약 0.2~0.33Hz)로 200행을 채우려면
//      10분 넘게 걸려 중간 종료·크래시 시 유실 구간이 너무 커진다. GPS 전용으로
//      훨씬 짧은 주기(30초)·작은 크기(50행 ≈ 2.5~4분 분량)로 따로 잡는다.
const GPS_FLUSH_INTERVAL_MS = 30_000;
const GPS_FLUSH_ROW_LIMIT   = 50;

import { postGpsBatch, type GpsPoint } from "../api/gpsTrace";

export type GpsTracePoint = Omit<GpsPoint, "seq">;

export class GpsTraceBuffer {
  private readonly sessionId: string;
  private points: GpsPoint[] = [];
  private nextSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  /** @param startSeq leg 전환 handoff용 — 생략하면 0부터(신규 세션 기본). */
  constructor(sessionId: string, startSeq?: number) {
    this.sessionId = sessionId;
    this.nextSeq = startSeq ?? 0;
    this.timer = setInterval(() => { void this.flush(); }, GPS_FLUSH_INTERVAL_MS);
  }

  /** leg 전환 등 세션 연속 handoff용 — 다음 GpsTraceBuffer가 이어받을 seq(현재값). */
  getNextSeqForHandoff(): number { return this.nextSeq; }

  /** GPS 콜백에서 픽스 하나씩 누적 — 판정 로직(거리 계산 등)과 무관, push만 한다. */
  push(p: GpsTracePoint): void {
    if (this.closed) return;
    this.points.push({ ...p, seq: this.nextSeq++ });
    if (this.points.length >= GPS_FLUSH_ROW_LIMIT) void this.flush();
  }

  /** 중간 플러시(타이머/크기) 또는 종료 시(final:true) 호출. */
  async flush(opts: { final?: boolean } = {}): Promise<void> {
    if (this.points.length === 0) {
      if (opts.final) this.close();
      return;
    }
    const batch = this.points;
    this.points = [];
    try {
      await postGpsBatch(this.sessionId, batch);
    } catch {
      // best-effort — 전송 실패한 배치는 버린다(오프라인 재큐잉 없음, 위 설계 메모).
    }
    if (opts.final) this.close();
  }

  private close(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.closed = true;
  }
}
