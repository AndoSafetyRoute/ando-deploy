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
// AsyncStorage 저장이 계속 실패할 때, 재시도를 위해 메모리 버퍼를 비우지 않고
// 들고 있는 것도 한도가 있어야 한다 — 이 횟수를 넘기면 그 세션의 미저장분은
// 포기하고 버퍼를 비운다(무한정 누적 방지). 2분 간격 기준 최대 약 10분치.
const MAX_SAVE_RETRIES = 5;

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

/**
 * AsyncStorage에 실제로 쓰기 성공했는지 boolean으로 알려준다 — 예전엔 실패를
 * 완전히 삼켜서(catch에서 아무것도 안 함), 호출부(enqueuePending)가 "저장됐다"고
 * 착각하고 메모리 버퍼를 비웠다. 그러면 바로 뒤 drainCollectQueue()의
 * loadPending()이 이 실패를 반영 안 한 예전 상태를 읽어, 배치가 로그도 재시도도
 * 없이 완전히 사라졌다(9/17 왕복 세션 신호 A/B 0건 원인).
 */
async function savePending(list: PendingBatch[]): Promise<boolean> {
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
    const serialized = JSON.stringify(trimmed);
    // 디버그용, 검증 후 제거 예정 — 배치 크기와 저장 성공/실패 상관관계 확인용
    // (9/17 왕복 세션 신호 A/B 0건 조사).
    console.warn(`[collect][DEBUG] savePending 쓰기 시도 — batches=${trimmed.length} bytes=${serialized.length}`);
    await AsyncStorage.setItem(PENDING_KEY, serialized);
    return true;
  } catch (e: any) {
    console.error(`[collect] savePending 실패(배치 유실 가능) — ${String(e?.message ?? e).slice(0, 200)}`);
    return false;
  }
}

/** 저장 성공 여부를 그대로 돌려준다 — 실패 시 호출부(flush)가 메모리 버퍼를
 * 비우지 않고 다음 flush 때 재시도하도록 판단 근거로 쓴다. */
function enqueuePending(batch: PendingBatch): Promise<boolean> {
  return withQueueLock(async () => {
    const list = await loadPending();
    list.push(batch);
    return savePending(list);
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
  // enqueuePending(=AsyncStorage 저장)이 연속으로 실패한 횟수. flush()가 이걸
  // 보고 저장 실패 시 버퍼를 비울지(재시도 포기) 말지(다음 flush에서 재시도) 판단.
  private saveFailCount = 0;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? newSessionId();
    this.timer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
    // 디버그용, 검증 후 제거 예정 — 타이머가 실제로 등록되는지 확인
    // (9/17~ 왕복 세션 신호 A/B 0건, collect_batch_log max_seq=0 조사).
    console.warn(`[collect][DEBUG] CollectSession 생성 + 타이머 등록됨 session=${this.sessionId} intervalMs=${FLUSH_INTERVAL_MS}`);
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
        seq:                this.seq,
        slope_observations: this.slope,
        speed_samples:      this.speed,
        route_choice:       this.choice,
        segment_feedback:   this.seg,
        route_profile:      this.routeProfile,
      };
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
      // 예전엔 여기서 결과를 안 보고 무조건 버퍼를 비웠다 — savePending이 조용히
      // 실패하면(9/17 왕복 세션 원인) 방금 만든 batch가 로컬에도 안 남고 메모리
      // 버퍼도 이미 빈 상태라 완전히 사라졌다. 이제 저장 성공을 확인한 뒤에만
      // 비운다 — 실패하면 버퍼를 그대로 둬 다음 flush(2분 뒤 또는 다음 200행
      // 도달 시)가 누적된 채로 다시 저장을 시도한다(seq도 그대로 재사용).
      const saved = await enqueuePending(batch);
      if (saved) {
        this.seq += 1;
        this.slope = [];
        this.speed = [];
        this.choice = null;
        this.seg = [];
        this.routeProfile = null;
        this.saveFailCount = 0;
      } else {
        this.saveFailCount += 1;
        if (this.saveFailCount >= MAX_SAVE_RETRIES) {
          // 계속 실패하면 버퍼가 무한정 쌓이므로(메모리), 상한을 넘기면 이번
          // 미저장분은 포기하고 비운다 — MAX_PENDING_BATCHES(디스크 큐 상한)와
          // 같은 원칙의 메모리 버퍼 버전. 무통보 손실이므로 최소한 로그는 남긴다.
          console.error(
            `[collect] savePending ${MAX_SAVE_RETRIES}회 연속 실패 — session=${this.sessionId} ` +
            `미저장 ${this.bufferedRows()}행 포기(무한 누적 방지).`,
          );
          this.seq += 1;
          this.slope = [];
          this.speed = [];
          this.choice = null;
          this.seg = [];
          this.routeProfile = null;
          this.saveFailCount = 0;
        } else {
          console.warn(
            `[collect] enqueuePending 실패(${this.saveFailCount}/${MAX_SAVE_RETRIES}) — ` +
            `버퍼 유지, 다음 flush에서 재시도.`,
          );
        }
      }
    }

    if (final) {
      this.closed = true;
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    await drainCollectQueue(opts?.idToken);
  }
}
