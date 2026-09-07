// 구간 설명 — 평가 화면에서 "이 구간이 경로의 어디인지 / 얼마나 센 경사인지 /
// 얼마나 걸었는지" 를 사람이 읽을 수 있는 문구로 만든다. 순수 로직만(단위 검증 대상).
//
// routeSegments 배열 + 대상 구간 인덱스(범위)를 받아 위치·세기·예상소요를 계산한다.
// 구/신 구간평가 화면 어디서든 재사용 (표시 컴포넌트는 이 결과만 렌더).

export type DescSeg = {
  slope?:     number;
  slope_pct?: number;
  length?:    number;
  length_m?:  number;
};

// FE 표시용 근사 보행속도. BE 의 ZONE_SPEED_DEFAULTS 는 FE 에 없어 상수로 근사한다.
// (안내 실측 pace 가 있으면 화면에서 그걸 우선 쓰고, 없을 때의 폴백)
export const WALK_SPEED_MS = 1.1;

const segLen = (s: DescSeg) => Number(s?.length ?? s?.length_m ?? 0) || 0;
const segSlope = (s: DescSeg) => Number(s?.slope ?? s?.slope_pct ?? 0) || 0;

export type SegmentLocation = {
  distFromStartM:    number;  // 경로 시작점 → 이 구간 시작까지 누적 거리(m)
  segLenM:           number;  // 이 구간(startIdx~endIdx) 길이 합(m)
  totalM:            number;  // 경로 전체 길이(m)
  progressStartFrac: number;  // distFromStartM / totalM        (0~1, totalM=0 이면 0)
  progressMidFrac:   number;  // 구간 중간 지점 기준 진행률       (0~1)
};

/** routeSegments[startIdx..endIdx] 의 위치·길이를 경로 전체 대비로 계산. */
export function locateSegment(
  segs: DescSeg[],
  startIdx: number,
  endIdx: number = startIdx,
): SegmentLocation {
  const arr = Array.isArray(segs) ? segs : [];
  const total = arr.reduce((a, s) => a + segLen(s), 0);

  if (arr.length === 0) {
    return { distFromStartM: 0, segLenM: 0, totalM: 0, progressStartFrac: 0, progressMidFrac: 0 };
  }

  const last = arr.length - 1;
  const lo = clampInt(startIdx, 0, last, 0);
  const hi = clampInt(endIdx, lo, last, lo);

  let before = 0;
  for (let i = 0; i < lo && i < arr.length; i++) before += segLen(arr[i]);

  let within = 0;
  for (let i = lo; i <= hi && i < arr.length; i++) within += segLen(arr[i]);

  const frac = (d: number) => (total > 0 ? Math.min(1, Math.max(0, d / total)) : 0);

  return {
    distFromStartM:    round1(before),
    segLenM:           round1(within),
    totalM:            round1(total),
    progressStartFrac: frac(before),
    progressMidFrac:   frac(before + within / 2),
  };
}

export type SlopeSeverity = {
  direction: "오르막" | "내리막" | "평지";
  // 절대 경사 버킷: >=8 매우 가파른 / >=5 가파른 / >=3 뚜렷한 / >=1 완만한 / <1 거의 평지
  tier: "매우 가파른" | "가파른" | "뚜렷한" | "완만한" | "거의 평지";
  label: string;   // 예: "가파른 오르막", "거의 평지 구간"
};

export function slopeSeverity(slopePct: number): SlopeSeverity {
  const s = Number(slopePct) || 0;
  const a = Math.abs(s);
  const direction: SlopeSeverity["direction"] = a < 1 ? "평지" : s > 0 ? "오르막" : "내리막";
  const tier: SlopeSeverity["tier"] =
    a >= 8 ? "매우 가파른" : a >= 5 ? "가파른" : a >= 3 ? "뚜렷한" : a >= 1 ? "완만한" : "거의 평지";
  const label = direction === "평지" ? "거의 평지 구간" : `${tier} ${direction}`;
  return { direction, tier, label };
}

/** 길이(m)/보행속도 → 근사 도보 소요. measuredSeconds 가 있으면 그걸 우선. */
export function estWalkDuration(
  lengthM: number,
  opts: { speedMs?: number; measuredSeconds?: number } = {},
): { seconds: number; text: string; measured: boolean } {
  const measured = Number.isFinite(opts.measuredSeconds) && (opts.measuredSeconds as number) > 0;
  const speed = opts.speedMs && opts.speedMs > 0 ? opts.speedMs : WALK_SPEED_MS;
  const seconds = measured
    ? Math.round(opts.measuredSeconds as number)
    : Math.round((Number(lengthM) || 0) / speed);
  return { seconds, text: fmtDuration(seconds), measured };
}

// ── 문구 포매터 ──────────────────────────────────────────────────────────────

export function fmtDistanceM(m: number): string {
  const v = Number(m) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}km` : `${Math.round(v)}m`;
}

export function fmtProgressPct(frac: number): string {
  const p = Math.round((Number(frac) || 0) * 100);
  return `${Math.min(100, Math.max(0, p))}%`;
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `약 ${s}초`;
  const m = Math.floor(s / 60);
  const rest = Math.round((s - m * 60) / 10) * 10;
  return rest === 0 || rest === 60 ? `약 ${m + (rest === 60 ? 1 : 0)}분` : `약 ${m}분 ${rest}초`;
}

/** "N개 중 k번째" (1-based). total 이 없으면 "k번째". */
export function orderText(orderNo1Based: number, total?: number): string {
  const k = Math.max(1, Math.trunc(Number(orderNo1Based) || 1));
  const n = Number(total);
  return Number.isFinite(n) && n > 0 ? `${n}개 중 ${k}번째` : `${k}번째`;
}

export type SegmentDescription = {
  locationText: string;   // "출발 후 약 350m · 전체의 40% 지점"
  orderLine:    string;   // "평가 구간 3개 중 2번째"
  severity:     SlopeSeverity;
  metaText:     string;   // "가파른 오르막 6.2% · 90m · 약 1분 20초"
  loc:          SegmentLocation;
};

/**
 * 화면 한 장에 넣을 설명 문구 묶음. slopePct/lengthM 은 대상 구간의 대표값
 * (그룹이면 길이가중 평균 경사·길이 합). measuredSeconds 는 안내 실측이 있을 때만.
 */
export function describeSegment(args: {
  segs: DescSeg[];
  startIdx: number;
  endIdx?: number;
  slopePct: number;
  lengthM: number;
  orderNo1Based: number;
  totalTargets?: number;
  measuredSeconds?: number;
}): SegmentDescription {
  const { segs, startIdx, slopePct, lengthM, orderNo1Based, totalTargets } = args;
  const endIdx = args.endIdx ?? startIdx;
  const loc = locateSegment(segs, startIdx, endIdx);
  const severity = slopeSeverity(slopePct);
  const dur = estWalkDuration(lengthM, { measuredSeconds: args.measuredSeconds });

  const locationText =
    `출발 후 ${fmtDistanceM(loc.distFromStartM)} · 전체의 ${fmtProgressPct(loc.progressStartFrac)} 지점`;
  const orderLine = `평가 구간 ${orderText(orderNo1Based, totalTargets)}`;
  const slopeStr = `${slopePct > 0 ? "오르막" : slopePct < 0 ? "내리막" : "평지"} ${Math.abs(Number(slopePct) || 0).toFixed(1)}%`;
  const metaText = `${severity.label} · ${slopeStr} · ${fmtDistanceM(lengthM)} · ${dur.text}${dur.measured ? " 걸음" : ""}`;

  return { locationText, orderLine, severity, metaText, loc };
}

function round1(n: number) { return Math.round((Number(n) || 0) * 10) / 10; }

function clampInt(v: number, lo: number, hi: number, fallback: number) {
  const n = Number.isFinite(v) ? Math.trunc(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
}
