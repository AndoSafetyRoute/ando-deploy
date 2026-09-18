// 개인 맞춤 경로 추천 — 신호 A~D 배치 전송 큐 (인계 §5 ⑫)
//
// 요구사항:
//   - 개별 POST 금지. 세션 종료 시 1회 bulk + 2분/200행마다 중간 플러시.
//   - 오프라인 큐잉: 전송 실패한 배치는 AsyncStorage 에 남겨 다음 기회에 재전송.
//   - 멱등: 배치마다 (session_id, seq) 를 고정해 두고, 실패 시 "같은 배치를 그대로" 재전송.
//     서버가 (uid, session_id, seq) 로 중복을 무시하므로 중복 저장되지 않는다.
//
// 사용:
//   const session = new CollectSession();            // 안내 시작 시 1개 생성
//   session.addSlopeObservation({...});              // GPS 콜백에서 누적
//   session.addSpeedSample({...});
//   session.setRouteChoice({...});                   // 경로 비교 화면에서 1회
//   session.addSegmentFeedback({...});               // 구간 평가 화면에서
//   await session.flush({ final: true });            // 안내 종료 / 화면 언마운트 시

import {
  postCollectBatch,
  type CollectBatch,
  type SlopeObservation,
  type SpeedSample,
  type RouteChoice,
  type SegmentFeedback,
  type RouteProfile,
} from "../api/collect";

// RN 환경에선 네이티브 AsyncStorage, 그 외(단위 검증 등)에선 인메모리 대체.
// api.ts / NavigationScreen.tsx 가 firebase·expo-speech 에 쓰는 것과 같은 require 패턴.
let AsyncStorage: {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
};
try {
  AsyncStorage = require("@react-native-async-storage/async-storage").default;
} catch {
  const mem = new Map<string, string>();
  AsyncStorage = {
    getItem: async (k) => mem.get(k) ?? null,
    setItem: async (k, v) => { mem.set(k, v); },
  };
}

const IS_DEV = typeof __DEV__ !== "undefined" && __DEV__;

const PENDING_KEY = "@ando/collect_pending";
// 오프라인이 길어져도 스토리지가 무한정 커지지 않도록 상한을 둔다(오래된 것부터 버림).
const MAX_PENDING_BATCHES = 40;
// 중간 플러시 임계값
const FLUSH_INTERVAL_MS = 120_000;   // 2분
const FLUSH_ROW_LIMIT   = 200;       // 200행

type PendingBatch = CollectBatch;

// 큐(AsyncStorage 리스트)의 읽기-수정-쓰기를 직렬화하는 뮤텍스.
// enqueue 와 drain 이 동시에 load→save 하면 서로의 변경을 덮어써 배치가 유실될 수 있어,
// 큐를 만지는 모든 작업을 이 체인 하나에 태운다.
let queueLock: Promise<unknown> = Promise.resolve();
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn);
  queueLock = run.catch(() => {});
  return run;
}

let draining = false;
let drainRequested = false;

async function loadPending(): Promise<PendingBatch[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingBatch[]) : [];
  } catch {
    return [];
  }
}

// 오프라인이 길어져 큐 상한을 넘으면 오래된 배치부터 버린다 — 무통보 데이터
// 손실이므로 최소한 로그는 남긴다(이슈 #8). 파일럿 중 이 경고가 보이면
// MAX_PENDING_BATCHES 를 올리거나 참가자 네트워크 환경을 점검해야 한다.
let droppedBatchCount = 0;
export function getDroppedBatchCount(): number { return droppedBatchCount; }

async function savePending(list: PendingBatch[]): Promise<void> {
  try {
    if (list.length > MAX_PENDING_BATCHES) {
      const dropped = list.slice(0, list.length - MAX_PENDING_BATCHES);
      droppedBatchCount += dropped.length;
      const rows = dropped.reduce(
        (s, b) =>
          s + (b.slope_observations?.length ?? 0) + (b.speed_samples?.length ?? 0) +
          (b.segment_feedback?.length ?? 0) + (b.route_choice ? 1 : 0),
        0,
      );
      console.warn(
        `[collect] 큐 상한(${MAX_PENDING_BATCHES}) 초과 — 오래된 배치 ${dropped.length}개(약 ${rows}행) 폐기. ` +
        `누적 폐기 ${droppedBatchCount}개.`,
      );
    }
    const trimmed = list.slice(-MAX_PENDING_BATCHES);
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(trimmed));
  } catch (e: any) {
    // 디버그용, 검증 후 제거 예정 — 원래 "스토리지 실패는 조용히 무시"였는데,
    // 이 실패가 조용하면 바로 뒤 drainCollectQueue()의 loadPending()이 방금
    // 쓰려던 배치가 반영 안 된 예전 상태를 읽어 배치가 흔적 없이 사라질 수
    // 있다(9/17 왕복 세션 신호 A/B 0건 조사 중 발견). 최소한 로그로는 남긴다.
    console.warn(`[collect][DEBUG] savePending 실패(배치 유실 가능) — ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

function enqueuePending(batch: PendingBatch): Promise<void> {
  return withQueueLock(async () => {
    const list = await loadPending();
    list.push(batch);
    await savePending(list);
  });
}

/**
 * 큐에 쌓인 모든 배치를 순서대로 재전송한다. 성공(중복 포함)한 것만 큐에서 제거.
 * best-effort — 실패해도 throw 하지 않는다. 실행 중 다시 불리면 끝난 뒤 한 번 더 돈다.
 */
export async function drainCollectQueue(idToken?: string): Promise<void> {
  if (draining) { drainRequested = true; return; }
  draining = true;
  try {
    do {
      drainRequested = false;
      await withQueueLock(async () => {
        const pending = await loadPending();
        // 디버그용, 검증 후 제거 예정 — IS_DEV(__DEV__) 게이트 없이 항상 찍는다.
        // 배치가 만들어졌는지(flush 쪽 로그)와 큐에서 실제로 뭘 읽었는지를
        // 대조해 "만들었는데 여기서 안 보임"을 확정하기 위함.
        console.warn(`[collect][DEBUG] drainCollectQueue: pending=${pending.length}`);
        if (pending.length === 0) return;

        const kept: PendingBatch[] = [];
        let stop = false;
        for (const batch of pending) {
          if (stop) { kept.push(batch); continue; }
          try {
            const res = await postCollectBatch(batch, idToken);
            if (res.ok) {
              if (IS_DEV) console.log(`[collect] sent ${batch.session_id} seq=${batch.seq}` +
                ("duplicate" in res && res.duplicate ? " (duplicate, ignored by server)" : ""));
              continue;                  // 전송됨(또는 중복) → 큐에서 제거
            }
            kept.push(batch);            // ok:false → 남겨서 재시도
            stop = true;
          } catch (e: any) {
            // 인증 없음/네트워크 다운 등 — 첫 실패에서 멈추고 남은 건 순서대로 보존
            if (IS_DEV) console.log(`[collect] send failed, queued for retry (${pending.length}): ${String(e?.message ?? e).slice(0, 120)}`);
            kept.push(batch);
            stop = true;
          }
        }
        await savePending(kept);
      });
    } while (drainRequested);
  } finally {
    draining = false;
  }
}

// export — 측정 파이프라인 v2가 session_id를 개인화 동의와 무관하게 미리 발급해야
// 해서(WalkContent/RouteCompareScreen), CollectSession 생성 시점과 분리해 재사용한다.
export function newSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 단위 검증 전용 — 큐/뮤텍스 상태 초기화. 앱 코드에서는 호출하지 않는다. */
export async function __resetCollectQueueForTests(): Promise<void> {
  await withQueueLock(async () => { await savePending([]); });
  draining = false;
  drainRequested = false;
}

export class CollectSession {
  readonly sessionId: string;

  private seq = 0;
  private slope: SlopeObservation[] = [];
  private speed: SpeedSample[] = [];
  private choice: RouteChoice | null = null;
  private seg: SegmentFeedback[] = [];
  // 세션당 1회. 첫 flush 에 실려 나가고 그 뒤 null 로 비운다(BE 는 UPSERT).
  private routeProfile: RouteProfile | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? newSessionId();
    this.timer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
  }

  private bufferedRows(): number {
    return this.slope.length + this.speed.length + this.seg.length + (this.choice ? 1 : 0);
  }

  private maybeFlushBySize(): void {
    if (this.bufferedRows() >= FLUSH_ROW_LIMIT) void this.flush();
  }

  addSlopeObservation(o: SlopeObservation): void {
    if (this.closed) return;
    this.slope.push(o);
    this.maybeFlushBySize();
  }

  addSpeedSample(s: SpeedSample): void {
    if (this.closed) return;
    this.speed.push(s);
    this.maybeFlushBySize();
  }

  /** 경로 비교 1건 (세션당 1회). 이미 있으면 마지막 값으로 덮어쓴다. */
  setRouteChoice(c: RouteChoice): void {
    if (this.closed) return;
    this.choice = c;
    this.maybeFlushBySize();
  }

  /** 경로 형상 스냅샷 (세션당 1회). 다음 flush 에 실려 나가고 그 뒤 비워진다. */
  setRouteProfile(p: RouteProfile): void {
    if (this.closed) return;
    this.routeProfile = p;
  }

  addSegmentFeedback(f: SegmentFeedback): void {
    if (this.closed) return;
    this.seg.push(f);
    this.maybeFlushBySize();
  }

  /**
   * 버퍼에 쌓인 것을 배치 1개로 확정해 큐에 넣고, 큐 전체 전송을 시도한다.
   * @param opts.final true면 타이머를 멈추고 세션을 닫는다(이후 add* 는 무시).
   */
  async flush(opts?: { final?: boolean; idToken?: string }): Promise<void> {
    const final = opts?.final ?? false;

    // 디버그용, 검증 후 제거 예정 — IS_DEV 게이트 없이 항상 찍는다. flush()가
    // 실제로 몇 번 "호출"됐는지, 호출 시점에 버퍼가 비어 있었는지(=addSlopeObservation/
    // addSpeedSample이 애초에 안 불렸다는 뜻)를 다음 실기기 테스트에서 확정하기 위함
    // (9/17 왕복 세션 신호 A/B 0건 조사).
    console.warn(
      `[collect][DEBUG] flush() 호출 session=${this.sessionId} seq=${this.seq} ` +
      `slope=${this.slope.length} speed=${this.speed.length} seg=${this.seg.length} ` +
      `choice=${this.choice ? "Y" : "N"} profile=${this.routeProfile ? "Y" : "N"} final=${final}`,
    );

    if (this.bufferedRows() > 0 || this.routeProfile) {
      const batch: PendingBatch = {
        session_id:         this.sessionId,
        seq:                this.seq++,
        slope_observations: this.slope,
        speed_samples:      this.speed,
        route_choice:       this.choice,
        segment_feedback:   this.seg,
        route_profile:      this.routeProfile,
      };
      // 버퍼를 먼저 비운다 — 전송 실패해도 배치는 큐에 남으므로 유실 없음
      this.slope = [];
      this.speed = [];
      this.choice = null;
      this.seg = [];
      this.routeProfile = null;
      if (IS_DEV) {
        const means = batch.slope_observations?.map((o) => o.slope_mean) ?? [];
        const dist = batch.slope_observations?.reduce((s, o) => s + o.distance_m, 0) ?? 0;
        console.log(
          `[collect] flush ${batch.session_id} seq=${batch.seq}` +
          ` slopeObs=${batch.slope_observations?.length ?? 0}(means:${JSON.stringify(means)} Σ${dist.toFixed(1)}m)` +
          ` speed=${batch.speed_samples?.length ?? 0}` +
          ` choice=${batch.route_choice ? "Y" : "N"}` +
          ` segFb=${batch.segment_feedback?.length ?? 0}` +
          (final ? " [final]" : ""),
        );
      }
      await enqueuePending(batch);
    }

    if (final) {
      this.closed = true;
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    await drainCollectQueue(opts?.idToken);
  }
}
