// 개인화 계측(⑪⑫) 검증 — 관문의 결정론적 속성을 합성 경로/GPS 트레이스로 확인한다.
//   1. bin 경계가 0.5% 단위로 끊기는지
//   2. 거리·시간 합계가 경로 총합과 일치하는지
//   3. 배치 큐: seq 단조 증가 / 200행 자동 플러시 / 오프라인 보존→재전송 / 멱등(중복) / 순서 보존 / 뮤텍스
//
// 실행:  node scripts/verify_instrumentation.mjs
// (Node 23+ : .ts 타입 스트리핑으로 실제 소스를 그대로 import)

globalThis.__DEV__ = false;

import { SlopeBinTracker, binCenter } from "../src/utils/slopeBinTracker.ts";
import {
  CollectSession,
  drainCollectQueue,
  __resetCollectQueueForTests,
} from "../src/utils/collectQueue.ts";
import {
  buildComparison,
  buildRouteChoicePayload,
  slopeProfile,
} from "../src/utils/routeChoiceModel.ts";
import { pickFeedbackSegments, VERDICT } from "../src/utils/segmentFeedbackModel.ts";
import {
  directionForSession,
  orientEndpoints,
  roundtripHintText,
} from "../src/utils/roundtripHint.ts";

let pass = 0, fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else      { fail++; console.log(`  FAIL ${name}${detail ? "  — " + detail : ""}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// ─────────────────────────────────────────────────────────────────────────────
section("A. binCenter — 0.5% 단위, 부호 유지, -0 정규화");
check("0 → 0",           Object.is(binCenter(0), 0));
check("-0.0 → 0 (부호X)", Object.is(binCenter(-0.0), 0));
check("2.1 → 2.0",        binCenter(2.1) === 2.0);
check("2.4 → 2.5",        binCenter(2.4) === 2.5);
check("2.24 → 2.0",       binCenter(2.24) === 2.0);
check("2.25 → 2.5",       binCenter(2.25) === 2.5);
check("-2.3 → -2.5",      binCenter(-2.3) === -2.5);
check("-3.2 → -3.0",      binCenter(-3.2) === -3.0);
check("5.3 → 5.5",        binCenter(5.3) === 5.5);
check("NaN → 0",          binCenter(NaN) === 0);
check("모두 0.5 배수",     [0.1, -7.7, 3.33, 12.9].every((s) => Number.isInteger(binCenter(s) * 2)));

// ─────────────────────────────────────────────────────────────────────────────
section("B. SlopeBinTracker — 합성 경로 통과");
// (length_m, slope_pct)
const route = [
  [30, 0.0], [25, 0.1],        // bin 0        (합 55)
  [40, 2.1],                    // bin 2.0      (40)
  [35, 2.4],                    // bin 2.5      (35)
  [50, 5.3], [20, 5.4],        // bin 5.5      (70)
  [8,  5.1],                    // bin 5.0      (8)   ← 20m 미만도 버리지 않음
  [60, -3.2], [45, -3.0],     // bin -3.0     (105)
  [100, 0.0], [15, -0.2],     // bin 0        (115)
];
const totalDist = route.reduce((s, [l]) => s + l, 0);
const SPEED = 1.0; // m/s (합성)

const tracker = new SlopeBinTracker(route[0][1], 0);
let clock = 0;
const emitted = [];
for (let i = 0; i < route.length; i++) {
  const [len, slope] = route[i];
  // 구간당 GPS 콜백 2회 흉내
  tracker.noteGpsSample();
  tracker.noteGpsSample();
  clock += (len / SPEED) * 1000;
  const next = i + 1 < route.length ? route[i + 1][1] : null;
  const obs = tracker.completeSegment(len, next, clock, 42);
  if (obs) emitted.push(obs);
}
const tail = tracker.finalize(clock, 42);
if (tail) emitted.push(tail);

const expectBins  = [0, 2.0, 2.5, 5.5, 5.0, -3.0, 0];
const expectDist  = [55, 40, 35, 70, 8, 105, 115];
check("방출 bin 순서",       eq(emitted.map((o) => o.slope_bin), expectBins),
      JSON.stringify(emitted.map((o) => o.slope_bin)));
check("bin별 distance_m",    eq(emitted.map((o) => o.distance_m), expectDist),
      JSON.stringify(emitted.map((o) => o.distance_m)));
check("모든 slope_bin 0.5 배수", emitted.every((o) => Number.isInteger(o.slope_bin * 2)));
check("Σ distance_m == 경로 총합", emitted.reduce((s, o) => s + o.distance_m, 0) === totalDist,
      `${emitted.reduce((s, o) => s + o.distance_m, 0)} vs ${totalDist}`);
check("Σ elapsed_ms == 총 소요시간", emitted.reduce((s, o) => s + o.elapsed_ms, 0) === Math.round(totalDist / SPEED * 1000),
      `${emitted.reduce((s, o) => s + o.elapsed_ms, 0)} vs ${totalDist / SPEED * 1000}`);
check("elapsed_ms 각 구간 > 0",  emitted.every((o) => o.elapsed_ms > 0));
check("route_id 전달",           emitted.every((o) => o.route_id === 42));
check("20m 미만 구간도 포함(8m bin 5.0)", emitted.some((o) => o.slope_bin === 5.0 && o.distance_m === 8));
check("gps_sample_n: 2구간 그룹은 4, 1구간 그룹은 2",
      emitted[0].gps_sample_n === 4 && emitted[1].gps_sample_n === 2 && emitted[5].gps_sample_n === 4);

section("B2. anchorStart — 첫 bin elapsed 를 이동 시작 시각 기준으로");
const t2 = new SlopeBinTracker(0.0, 1000);
t2.noteGpsSample();
t2.anchorStart(5000);            // GPS 락에 4초 걸린 상황
const o2 = t2.completeSegment(20, 2.1, 8000, null); // 이동 3초
check("elapsed 는 8000-5000 = 3000", o2 && o2.elapsed_ms === 3000, JSON.stringify(o2));
check("anchor 후 gps_sample_n 리셋", o2 && o2.gps_sample_n === 0);

section("B3. finalize — 부분 bin 확정 & 이중 방출 방지");
const t3 = new SlopeBinTracker(0.0, 0);
t3.completeSegment(50, 0.1, 1000, null);   // 같은 bin, emit 없음
const f1 = t3.finalize(1000, null);
check("부분 bin 확정 (50m)",  f1 && f1.distance_m === 50);
check("두 번째 finalize 는 null", t3.finalize(2000, null) === null);

section("B4. stop_ms — bin별 누적 & 리셋, 반올림");
const t4 = new SlopeBinTracker(0.0, 0);
t4.noteStop(1200.4); t4.noteStop(800);
const s1 = t4.completeSegment(30, 2.1, 1000, null); // bin 0 종료
const s2 = t4.completeSegment(30, null, 2000, null); // bin 2.0 종료 (stop 없음)
check("bin0 stop_ms = round(2000.4) = 2000", s1 && s1.stop_ms === 2000, JSON.stringify(s1));
check("bin2.0 stop_ms = 0 (리셋됨)",           s2 && s2.stop_ms === 0);

section("B5. invalidateCurrent — GPS 점프/공백 시 진행 중 bin 무효화 (Q&A #5)");
// bin 0 을 걷다가 점프 → 그 bin 은 방출 안 되고, 다음 bin 부터 정상.
const t5 = new SlopeBinTracker(0.0, 0);
t5.completeSegment(30, 0.1, 1000, null);      // 같은 bin 누적
t5.invalidateCurrent(2000);                   // 점프 감지
const jp1 = t5.completeSegment(30, 2.1, 3000, null);  // bin 0 경계 — 오염되어 null
const jp2 = t5.completeSegment(30, 2.1, 4000, null);  // 같은 bin(2.0) 누적
const jp3 = t5.completeSegment(30, null, 5000, 7);    // bin 2.0 경계 — 정상 방출
check("오염된 bin 은 방출 안 됨", jp1 === null, JSON.stringify(jp1));
check("다음 bin 은 정상 방출", jp3 && jp3.slope_bin === 2.0 && jp3.distance_m === 60, JSON.stringify(jp3));
check("정상 방출 bin 은 점프 이후 시각 기준", jp3 && jp3.elapsed_ms === 2000);
// 점프 뒤 곧장 경로 끝 → finalize 도 null
const t6 = new SlopeBinTracker(0.0, 0);
t6.completeSegment(40, 0.1, 1000, null);
t6.invalidateCurrent(1500);
check("점프 후 finalize 는 null", t6.finalize(2000, null) === null);

// ─────────────────────────────────────────────────────────────────────────────
section("C. CollectSession + 배치 큐");

// mock fetch — /collect/batch 만 가로챈다
let fetchLog = [];
let fetchMode = "ok"; // ok | dup | throw | throw-once
function installFetch() {
  globalThis.fetch = async (url, opts) => {
    if (!String(url).endsWith("/collect/batch")) throw new Error("unexpected url " + url);
    const body = JSON.parse(opts.body);
    fetchLog.push(body);
    if (fetchMode === "throw") throw new Error("network down");
    if (fetchMode === "throw-once") { fetchMode = "ok"; throw new Error("network blip"); }
    const json = fetchMode === "dup"
      ? { ok: true, duplicate: true }
      : { ok: true, duplicate: false, saved: {} };
    return { ok: true, status: 200, json: async () => json, text: async () => "" };
  };
}
const TOK = "fake-id-token";
async function reset() { await __resetCollectQueueForTests(); fetchLog = []; fetchMode = "ok"; }
installFetch();

// C1 — 기본 flush: seq=0, 버퍼 비움
await reset();
{
  const cs = new CollectSession("sess-test-1");
  cs.addSlopeObservation({ slope_bin: 0,   distance_m: 55, elapsed_ms: 55000, stop_ms: 0, gps_sample_n: 4 });
  cs.addSlopeObservation({ slope_bin: 2.5, distance_m: 35, elapsed_ms: 40000, stop_ms: 0, gps_sample_n: 2 });
  cs.addSpeedSample({ slope_bin: 0, sub_distance_m: 6.2, speed_ms: 0.9 });
  await cs.flush({ idToken: TOK });
  check("C1 fetch 1회", fetchLog.length === 1);
  check("C1 session_id/seq", fetchLog[0]?.session_id === "sess-test-1" && fetchLog[0]?.seq === 0);
  check("C1 slope 2행 / speed 1행", fetchLog[0]?.slope_observations.length === 2 && fetchLog[0]?.speed_samples.length === 1);
  await cs.flush({ idToken: TOK });          // 빈 버퍼
  check("C1 빈 flush 는 전송/seq 소비 안 함", fetchLog.length === 1);
  cs.addSegmentFeedback({ slope_mean: 5.3, length_m: 50, verdict: -1 });
  await cs.flush({ idToken: TOK });
  check("C1 다음 배치 seq=1", fetchLog[1]?.seq === 1 && fetchLog[1]?.segment_feedback.length === 1);
  await cs.flush({ final: true, idToken: TOK });
  cs.addSlopeObservation({ slope_bin: 1, distance_m: 10, elapsed_ms: 1000, stop_ms: 0, gps_sample_n: 1 });
  await cs.flush({ idToken: TOK });
  check("C1 final 후 add* 무시", fetchLog.length === 2);
}

// C2 — 200행 자동 플러시 (배치 확정: seq 소비 + 버퍼 비움 + 큐 적재)
// 앱에서는 flush() 가 내부 getAuthToken() 으로 토큰을 얻지만, Node 검증에선 firebase 가
// 없어 자동 flush 의 전송은 실패한다 → 배치가 큐에 적재됐는지를 명시 drain 으로 확인.
await reset();
{
  const cs = new CollectSession("sess-test-2");
  for (let i = 0; i < 200; i++) cs.addSpeedSample({ slope_bin: 0, sub_distance_m: 5, speed_ms: 1 });
  await new Promise((r) => setTimeout(r, 10)); // 자동 flush(void) 의 enqueue 완료 대기
  await drainCollectQueue(TOK);
  check("C2 200행에서 배치 1개 자동 확정 (seq 0, speed 200행)",
        fetchLog.length === 1 && fetchLog[0]?.seq === 0 && fetchLog[0]?.speed_samples.length === 200,
        JSON.stringify(fetchLog.map((b) => [b.seq, b.speed_samples?.length])));
  fetchLog = [];
  cs.addSpeedSample({ slope_bin: 0, sub_distance_m: 5, speed_ms: 1 });
  await cs.flush({ final: true, idToken: TOK });
  check("C2 이후 add 는 다음 배치 seq=1", fetchLog[0]?.seq === 1 && fetchLog[0]?.speed_samples.length === 1);
}

// C3 — 오프라인: 실패 시 큐 보존 → 재전송
await reset();
{
  fetchMode = "throw";
  const cs = new CollectSession("sess-test-3");
  cs.addSlopeObservation({ slope_bin: 3, distance_m: 60, elapsed_ms: 60000, stop_ms: 0, gps_sample_n: 3 });
  await cs.flush({ final: true, idToken: TOK });
  check("C3 전송 시도함", fetchLog.length === 1);
  fetchLog = []; fetchMode = "ok";
  await drainCollectQueue(TOK);              // 재연결
  check("C3 재연결 시 재전송", fetchLog.length === 1 && fetchLog[0]?.session_id === "sess-test-3" && fetchLog[0]?.seq === 0);
  fetchLog = [];
  await drainCollectQueue(TOK);
  check("C3 재전송 후 큐 비었음", fetchLog.length === 0);
}

// C4 — 멱등: 서버가 duplicate 응답 → 큐에서 제거
await reset();
{
  fetchMode = "dup";
  const cs = new CollectSession("sess-test-4");
  cs.addSlopeObservation({ slope_bin: 0, distance_m: 20, elapsed_ms: 20000, stop_ms: 0, gps_sample_n: 2 });
  await cs.flush({ final: true, idToken: TOK });
  fetchLog = [];
  await drainCollectQueue(TOK);
  check("C4 duplicate 응답이면 큐에서 제거(재전송 안 함)", fetchLog.length === 0);
}

// C5 — 부분 실패 시 순서 보존 (배치1 OK, 배치2 이후 전부 보존)
await reset();
{
  const cs = new CollectSession("sess-test-5");
  cs.addSlopeObservation({ slope_bin: 0, distance_m: 10, elapsed_ms: 1, stop_ms: 0, gps_sample_n: 1 });
  await cs.flush({ idToken: TOK });                    // seq 0 → 즉시 OK 전송, 큐 비움
  fetchMode = "throw";
  cs.addSlopeObservation({ slope_bin: 1, distance_m: 10, elapsed_ms: 1, stop_ms: 0, gps_sample_n: 1 });
  await cs.flush({ idToken: TOK });                    // seq 1 → 실패, 큐에 남음
  cs.addSlopeObservation({ slope_bin: 2, distance_m: 10, elapsed_ms: 1, stop_ms: 0, gps_sample_n: 1 });
  await cs.flush({ final: true, idToken: TOK });       // seq 2 → 실패, 큐에 남음 (seq1 뒤)
  fetchLog = []; fetchMode = "ok";
  await drainCollectQueue(TOK);
  check("C5 남은 배치가 seq 순서대로 재전송", eq(fetchLog.map((b) => b.seq), [1, 2]), JSON.stringify(fetchLog.map((b) => b.seq)));
}

// C6 — 동시 flush (뮤텍스): 배치 유실 없음
await reset();
{
  // 느린 fetch 로 경합 유도
  globalThis.fetch = async (url, opts) => {
    fetchLog.push(JSON.parse(opts.body));
    await new Promise((r) => setTimeout(r, 15));
    return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: false, saved: {} }), text: async () => "" };
  };
  const cs = new CollectSession("sess-test-6");
  cs.addSlopeObservation({ slope_bin: 0, distance_m: 1, elapsed_ms: 1, stop_ms: 0, gps_sample_n: 1 });
  const p1 = cs.flush({ idToken: TOK });               // seq 0
  cs.addSlopeObservation({ slope_bin: 1, distance_m: 1, elapsed_ms: 1, stop_ms: 0, gps_sample_n: 1 });
  const p2 = cs.flush({ idToken: TOK });               // seq 1 (동시)
  await Promise.all([p1, p2]);
  await drainCollectQueue(TOK);
  const seqs = [...new Set(fetchLog.map((b) => b.seq))].sort();
  check("C6 두 배치(seq 0,1) 모두 전송, 유실 없음", eq(seqs, [0, 1]), JSON.stringify(fetchLog.map((b) => b.seq)));
  await cs.flush({ final: true, idToken: TOK });
  installFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
section("D. routeChoiceModel — 3경로 비교(⑬) 병합/무작위/페이로드");

const mkRoute = (kind, coords, segs, dist) => ({
  kind, coordinates: coords, totalDistance: dist,
  avgSlope: 0, estimatedTimeS: dist, routeSegments: segs,
});
const cA = mkRoute("type",     [[126.90, 37.50], [126.91, 37.51]], [{ slope: 2.1, length: 40 }, { slope: 5.3, length: 60 }], 300);
const cB = mkRoute("distance", [[126.90, 37.50], [126.905, 37.505], [126.91, 37.50]], [{ slope: 0.1, length: 280 }], 280);
const cC = mkRoute("personal", [[126.90, 37.50], [126.91, 37.51]], [{ slope: 2.4, length: 100 }], 300); // A와 좌표 동일 → 병합

// 고정 rng (셔플 결정론화)
let rngSeq = [0.99, 0.01, 0.5, 0.5];
let rngi = 0;
const rng = () => rngSeq[(rngi++) % rngSeq.length];

const { shown, nShown } = buildComparison([cA, cB, cC], rng);
check("D 좌표 동일한 type+personal 병합 → 2개",  nShown === 2, `nShown=${nShown}`);
check("D shown_pos 0..n-1 연속",                 shown.map((s) => s.shownPos).join() === "0,1");
{
  const banned = ["type", "distance", "personal", "맞춤", "거리 우선", "거리우선"];
  const labelsOk = shown.every((s) => /^경로 [A-Z]$/.test(s.label))
    && shown.every((s) => !banned.some((w) => s.label.includes(w)));
  check("D 라벨은 중립(경로 A/B…) — kind/라벨 노출 없음", labelsOk);
}
check("D 병합된 후보는 mergedKinds 2개",          shown.some((s) => s.mergedKinds.length === 2 && s.mergedKinds.includes("type") && s.mergedKinds.includes("personal")));

const merged = shown.find((s) => s.mergedKinds.length === 2);
const prof = slopeProfile(merged.route);
check("D slopeProfile bin 은 0.5 배수, 길이 합 보존",
      prof.every((p) => Number.isInteger(p.bin * 2)) &&
      Math.round(prof.reduce((s, p) => s + p.length_m, 0)) === 100);

// 선택 페이로드
const chosen = shown[1];
const payload = buildRouteChoicePayload(shown, chosen);
check("D payload n_shown == 2",                 payload.n_shown === 2);
check("D payload candidates 에 shown_pos 보존", payload.candidates.map((c) => c.shown_pos).sort().join() === "0,1");
check("D payload chosen_kind 은 선택 후보의 kind", payload.chosen_kind === chosen.mergedKinds[0]);
check("D payload.candidates[].profile 존재",     payload.candidates.every((c) => Array.isArray(c.profile)));

// 후보가 1개뿐이면 "비교 없음" → chosen_kind = null
const one = buildComparison([cA], rng);
const p1 = buildRouteChoicePayload(one.shown, one.shown[0]);
check("D 후보 1개면 n_shown=1, chosen_kind=null", p1.n_shown === 1 && p1.chosen_kind === null);

// 무작위성: rng 를 바꾸면 순서가 바뀐다(위치 편향 방지 근거)
rngi = 0; rngSeq = [0.01, 0.01];
const shX = buildComparison([cA, cB], rng).shown;
rngi = 0; rngSeq = [0.99, 0.99];
const shY = buildComparison([cA, cB], rng).shown;
check("D rng 에 따라 표시 순서가 달라짐",
      shX[0].route.kind !== shY[0].route.kind);

// ─────────────────────────────────────────────────────────────────────────────
section("E. segmentFeedbackModel — 구간 평가(⑭) 대상 선정");
{
  // (slope, length) — 완만 / 급오르막(같은 bin 두 구간이 그룹) / 완만 / 급내리막 / 완만
  const segs = [
    { slope: 0.2, length: 80 },
    { slope: 6.1, length: 40 }, { slope: 6.2, length: 50 },  // 둘 다 bin 6.0 → 그룹(합 90, |mean|~6.16)
    { slope: 0.1, length: 120 },
    { slope: -5.4, length: 70 },                              // bin -5.5
    { slope: 1.0, length: 30 },
  ];
  const picked = pickFeedbackSegments(segs);
  check("E 2개 선정",                       picked.length === 2, JSON.stringify(picked));
  check("E 경로 진행 순서대로 (오르막 먼저)", picked[0].slope_mean > 0 && picked[1].slope_mean < 0);
  check("E slope_mean 은 길이가중 평균 근사", Math.abs(picked[0].slope_mean - 6.16) < 0.1, `got ${picked[0].slope_mean}`);
  check("E length_m 는 그룹 합",             picked[0].length_m === 90 && picked[1].length_m === 70, JSON.stringify(picked));
  check("E 완만한 경로면 빈 배열",           pickFeedbackSegments([{ slope: 0.3, length: 500 }]).length === 0);
  check("E 짧은 급경사(25m 미만) 제외",      pickFeedbackSegments([{ slope: 9, length: 15 }]).length === 0);
  check("E maxCount 1 이면 1개",             pickFeedbackSegments(segs, { maxCount: 1 }).length === 1);
  check("E VERDICT 매핑",                    VERDICT.hard === -1 && VERDICT.normal === 0 && VERDICT.easy === 1);
}

section("F. roundtripHint — 왕복·방향 교대(⑮)");
{
  check("F 짝수 세션=forward, 홀수=reverse",
        directionForSession(0) === "forward" && directionForSession(1) === "reverse" && directionForSession(4) === "forward");
  const o = orientEndpoints("forward", "A", "B");
  const r = orientEndpoints("reverse", "A", "B");
  check("F forward 는 그대로, reverse 는 스왑", o.start === "A" && o.goal === "B" && r.start === "B" && r.goal === "A");
  check("F 문구에 방향 반영",
        roundtripHintText("reverse", "집", "공원").includes("공원 → 집") &&
        roundtripHintText("forward", "집", "공원").includes("집 → 공원"));
  check("F 문구에 왕복 권유 포함", roundtripHintText("forward").includes("왕복"));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
