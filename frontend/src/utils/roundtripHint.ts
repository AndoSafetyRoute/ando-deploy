// 왕복·방향 교대 안내 (⑮) — ando_ml_plan_v2 §3.5
//
// "A→B 에서 오르막이던 구간이 B→A 에서 같은 크기의 내리막이 된다. 목적지를 억지로
//  바꾸지 않아도 내리막 데이터가 대칭으로 자동 확보." → 세션마다 출발 방향을 절반씩 교대해
//  안내하고, 왕복을 권한다.
//
// 순수 로직만. 카운터 영속화는 호출부(AsyncStorage)가 담당하고 여기엔 넣지 않는다.

export type WalkDirection = "forward" | "reverse";

/** n번째 개인화 세션(0,1,2,…)의 출발 방향. 짝수=정방향, 홀수=역방향. */
export function directionForSession(sessionCount: number): WalkDirection {
  return sessionCount % 2 === 0 ? "forward" : "reverse";
}

/**
 * 방향에 맞춰 출발/도착을 스왑해서 돌려준다.
 * forward 면 그대로, reverse 면 origin↔dest 를 바꾼다.
 */
export function orientEndpoints<T>(dir: WalkDirection, origin: T, dest: T): { start: T; goal: T } {
  return dir === "forward" ? { start: origin, goal: dest } : { start: dest, goal: origin };
}

/** 배너에 띄울 안내 문구. */
export function roundtripHintText(dir: WalkDirection, fromName?: string, toName?: string): string {
  const a = fromName || "출발지";
  const b = toName || "도착지";
  const legText = dir === "forward" ? `${a} → ${b}` : `${b} → ${a}`;
  return (
    `이번 세션은 ${legText} 방향으로 안내합니다.\n` +
    `가능하면 왕복으로 걸어 주세요 — 반대 방향에서 같은 경사가 내리막으로 잡혀 데이터가 대칭이 됩니다.`
  );
}
