// 경사도 → zone(flat/optimal/warning/forbidden) 분류 — 유형별 임계값 기준.
//
// 기존엔 이 로직이 NavigationScreen.tsx에만 있고(안내 중 지도 색·음성 안내용),
// 마이페이지/경로상세는 완전히 별도의 고정 2%/5% 3단계(평지/완만/급경사,
// storage.ts getSlopeEffort)를 써서 같은 앱 안에 경사 분류가 두 벌 존재했다
// (안내 중엔 유형별 4단계 초록/노랑/주황/빨강, 다녀온 뒤 요약엔 유형 무관 3단계).
// 사용자 확인 후 요약 화면도 이 유형별 4단계로 통일한다 — 이 파일이 그 유일한
// 소스(SSOT)다. NavigationScreen.tsx도 이 파일을 import해서 쓴다(값 중복 제거).
//
// 백엔드 routing/cost.py USER_TYPES(g_opt/g_warn)를 그대로 미러링 — 값이 바뀌면
// 여기도 같이 갱신해야 한다(레포에 SSOT가 둘이라는 중복 유지비용은 있으나, 폴백
// 경로까지 API 왕복 없이 즉시 칠해야 해서 감수).
export const SLOPE_ZONE_THRESHOLDS: Record<
  string,
  { up: { g_opt: number; g_warn: number }; down: { g_opt: number; g_warn: number } }
> = {
  manual_wheelchair:   { up: { g_opt: 5.0, g_warn: 8.33 }, down: { g_opt: 3.0, g_warn: 8.33 } },
  electric_wheelchair: { up: { g_opt: 6.0, g_warn: 8.33 }, down: { g_opt: 3.0, g_warn: 5.0  } },
  walker:              { up: { g_opt: 5.0, g_warn: 8.0  }, down: { g_opt: 0.0, g_warn: 3.0  } },
  cane:                { up: { g_opt: 8.0, g_warn: 12.0 }, down: { g_opt: 8.0, g_warn: 12.0 } },
  leg_injury:          { up: { g_opt: 0.0, g_warn: 5.0  }, down: { g_opt: 5.0, g_warn: 8.0  } },
  elderly:             { up: { g_opt: 5.0, g_warn: 8.0  }, down: { g_opt: 5.0, g_warn: 8.0  } },
};

export const SLOPE_FLAT_THRESHOLD_PCT = 0.5; // backend config.py FLAT_THRESHOLD와 동일

export type SlopeZoneKey = "flat" | "optimal" | "warning" | "forbidden";

// RouteRecord.walkerType은 두 출처가 섞여 있다: 로컬에서 막 만든 기록은
// USER_TYPE_MAP의 한글 키("고령자" 등, storage.ts toApiUserType 대상)이고,
// 서버 동기화된 기록(get_user_routes → walkerType)은 이미 영문 API 키
// ("elderly" 등, routes.walker_type 컬럼 원문)다. 여기서 한 번에 흡수한다 —
// 이미 영문 키면 그대로, 아니면 toApiUserType으로 변환, 그래도 없으면 elderly.
function resolveThresholdKey(walkerType?: string): string {
  if (walkerType && SLOPE_ZONE_THRESHOLDS[walkerType]) return walkerType;
  if (walkerType) {
    // 순환 참조 방지를 위해 storage.ts를 import하지 않고 인라인 매핑만 재사용.
    const KOREAN_MAP: Record<string, string> = {
      전동: "electric_wheelchair",
      수동: "manual_wheelchair",
      보행기: "walker",
      지팡이: "cane",
      고령자: "elderly",
      다리부상: "leg_injury",
    };
    const mapped = KOREAN_MAP[walkerType];
    if (mapped && SLOPE_ZONE_THRESHOLDS[mapped]) return mapped;
  }
  return "elderly";
}

/** 절대 경사(부호 포함 slopePercent) + 유형 → zone key. 안내 중 지도 색과 동일 판정. */
export function classifySlopeZone(slopePercent: number, walkerType?: string): SlopeZoneKey {
  const abs = Math.abs(Number(slopePercent) || 0);
  if (abs < SLOPE_FLAT_THRESHOLD_PCT) return "flat";
  const direction = slopePercent > 0 ? "up" : "down";
  const th = SLOPE_ZONE_THRESHOLDS[resolveThresholdKey(walkerType)][direction];
  if (abs <= th.g_opt) return "optimal";
  if (abs <= th.g_warn) return "warning";
  return "forbidden";
}

// 마이페이지 "경사도별 소요 시간" 전용 — 오르막/내리막을 나눠서 보여주기로
// 결정(경로상세 "구간별 난이도 요약"은 그대로 4단계 유지, 여긴 마이페이지만).
// forbidden은 실측상 사실상 안 나와서(임계값이 넓어 도달하기 어려움) 별도 칸을
// 만들지 않고, 혹시 나오더라도 데이터를 안 버리도록 같은 방향의 warning 칸에
// 합산한다 — "칸이 없다"와 "그 칸이 0"을 구분하지 않기로 한 선택.
export type MyPageSlopeZoneKey =
  | "flat" | "up_optimal" | "up_warning" | "down_optimal" | "down_warning";

export function classifySlopeZoneForMyPage(
  slopePercent: number,
  walkerType?: string,
): MyPageSlopeZoneKey {
  const zone = classifySlopeZone(slopePercent, walkerType);
  if (zone === "flat") return "flat";
  const dir = slopePercent > 0 ? "up" : "down";
  return zone === "forbidden" ? `${dir}_warning` : `${dir}_${zone}`;
}

// 오르막은 안내 중 지도 색(ZONE_COLORS)과 같은 난색 계열(노랑→주황) 유지,
// 내리막은 별도의 한색 계열(하늘→파랑)로 분리 — "오르막/내리막이 같은 색이면
// 방향을 못 알아본다"는 피드백 반영. 이 팔레트는 마이페이지 5단계 전용이고
// ZONE_COLORS(안내 중 지도·경로상세 4단계)는 건드리지 않는다 — 두 화면은
// 이미 서로 다른 요약(마이페이지=방향별 5단계, 경로상세=4단계)을 쓰기로
// 결정했다(2026-09).
export const MYPAGE_ZONE_COLORS: Record<MyPageSlopeZoneKey, string> = {
  flat:         "#4CAF50", // 평지 — 초록(ZONE_COLORS.flat과 동일)
  up_optimal:   "#FDD835", // 오르막 완만 — 노랑(ZONE_COLORS.optimal과 동일)
  up_warning:   "#FF9800", // 오르막 주의 — 주황(ZONE_COLORS.warning과 동일)
  down_optimal: "#4FC3F7", // 내리막 완만 — 하늘색
  down_warning: "#1E88E5", // 내리막 주의 — 파랑(더 진하게, 완만과 구분)
};
