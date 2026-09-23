"""
경사도 점수 & 엣지 비용 함수 + 유형별 파라미터 테이블

── S7: 세 경로 종류의 비용함수 정의 ──────────────────────────────────────────
  shortest(거리)   : length                              — set_edge_weights(alpha=0.0)
  type(유형별)      : length × f_type(slope) = slope_cost(slope, user_type, length)
                                                          — set_edge_weights(alpha=1.0)
  personal(맞춤형)  : c_u(e) — 아직 미구현(S8 예정, user_model_params 기반).
                       f_type과 user_type 피처를 쓰지 않는다는 게 S8의 요구사항.

  세 함수 모두 시설 정책(FACILITY_POLICY, is_facility_blocked)을 적용한다 —
  shortest(alpha=0)도 예외 없음. set_edge_weights()가 alpha 보간과
  무관하게 항상 덮어쓰는 방식으로 구현(코드 참고) — "차단"은 그래프에서 엣지를
  제거하는 대신 큰 유한 비용(FORBIDDEN_PENALTY × length)을 주는 기존 관례를
  그대로 따른다(경사 forbidden 처리와 동일 패턴, 우회 가드레일도 그대로 적용됨).
"""
from config import FORBIDDEN_PENALTY

# ──────────────────────────────────────────────────────────────────────────────
# 유형별 파라미터
# ──────────────────────────────────────────────────────────────────────────────
USER_TYPES = {
    "manual_wheelchair": {
        "label": "수동휠체어",
        "up":   {"g_opt": 5.0,  "g_warn": 8.33},
        "down": {"g_opt": 3.0,  "g_warn": 8.33},
        "r_up": 0.63, "r_down": 0.37,
    },
    "electric_wheelchair": {
        "label": "전동휠체어",
        "up":   {"g_opt": 6.0,  "g_warn": 8.33},
        "down": {"g_opt": 3.0,  "g_warn": 5.0},
        "r_up": 0.43, "r_down": 0.57,
    },
    "walker": {
        "label": "워커",
        "up":   {"g_opt": 5.0,  "g_warn": 8.0},
        "down": {"g_opt": 0.0,  "g_warn": 3.0},
        "r_up": 0.38, "r_down": 0.62,
    },
    "cane": {
        "label": "지팡이",
        "up":   {"g_opt": 8.0,  "g_warn": 12.0},
        "down": {"g_opt": 8.0,  "g_warn": 12.0},
        "r_up": 0.50, "r_down": 0.50,
    },
    "leg_injury": {
        "label": "다리 부상",
        "up":   {"g_opt": 0.0,  "g_warn": 5.0},
        "down": {"g_opt": 5.0,  "g_warn": 8.0},
        "r_up": 0.38, "r_down": 0.62,
    },
    "elderly": {
        "label": "고령자",
        "up":   {"g_opt": 5.0,  "g_warn": 8.0},
        "down": {"g_opt": 5.0,  "g_warn": 8.0},
        "r_up": 0.50, "r_down": 0.50,
    },
    # S6 — 실험 참가자(비보행약자) 그룹. 기존 6개 유형보다 훨씬 관대한 임계값
    # (비장애 보행자는 급경사에도 크게 지장 없다는 전제) — ⚠️ 근거 없는
    # 플레이스홀더(C등급, 임의값)다. 실제 파일럿 참가자 데이터로 재검토 필요
    # (S8/S10 개인화 학습이 유형 파라미터를 대체하기 전까지 fallback으로만 쓰임).
    "general": {
        "label": "일반",
        "up":   {"g_opt": 10.0, "g_warn": 20.0},
        "down": {"g_opt": 10.0, "g_warn": 20.0},
        "r_up": 0.50, "r_down": 0.50,
    },
}


# ──────────────────────────────────────────────────────────────────────────────
# 시설 정책 (S6.5) — 계단/에스컬레이터/엘리베이터
# ──────────────────────────────────────────────────────────────────────────────
# is_stairs(routing/segments.py NavSegment, routing/measurement_units.py
# MeasurementUnit)는 OSM 원본 highway=='steps' 태그 기반 "사실 필드"일 뿐이다
# (경사 임계값 기반 추정 아님 — 실측 결과 계단의 88.2%가 25% 미만 경사로 잡히고
# 25% 이상 경사의 97.1%가 계단이 아니라 경사와 계단은 대리지표가 될 수 없음이
# 확인됨). 차단 여부는 사실과 분리해 이 테이블에서만 결정한다 — 나중에 유형별로
# 달라져도(예: 특정 유형만 완화) 이 테이블만 고치면 되게.
# 지금은 6개 유형 전부 계단 차단(S7 시설 정책: WHEEL도 AMBUL도 계단 차단).
FACILITY_POLICY = {
    user_type: {"stairs": "block"}
    for user_type in USER_TYPES
}


def is_facility_blocked(user_type: str, is_stairs: bool) -> bool:
    """이 구간(사실 필드들)이 user_type에게 통행 불가인지 — 순수 정책 판정만.
    실제 엣지 비용 반영 방식(그래프에서 제거할지, 큰 유한 비용을 줄지)은
    호출측(S7, set_edge_weights/cch_engine.py)이 기존 관례(FORBIDDEN_PENALTY)에
    맞춰 정한다 — 이 함수는 "막아야 하는가"만 답한다."""
    if is_stairs and FACILITY_POLICY.get(user_type, {}).get("stairs") == "block":
        return True
    return False


def is_facility_blocked_for_any_type(is_stairs: bool) -> bool:
    """cch_engine.is_forbidden_for_any_type()와 같은 패턴 — 유형 무관 단일 안전
    거리 metric(경로②)에 쓴다. 6개 유형 중 하나라도 막으면 True(현재는 전부
    막으므로 is_stairs와 동치이지만, 유형별로 정책이 갈리면 자동으로 반영됨)."""
    return any(is_facility_blocked(ut, is_stairs) for ut in USER_TYPES)


def slope_score(g_abs: float, direction: str, user_type: str) -> float:
    """
    구간별 이차함수 점수 (0~100).

    ① 최적 (0 ≤ g ≤ g_opt) : S1(g) = 100 - a*g²,   a = 100*r / g_opt²
    ② 주의 (g_opt < g ≤ g_warn): S2(g) = S_opt - b*(g-g_opt)²
                                  S_opt = 100*(1-r),  b = S_opt/(g_warn-g_opt)²
    ③ 금지 (g > g_warn) : 0점

    g_opt = 0 특수 처리 (워커 내리막, 다리부상 오르막):
      최적 구간 없음 → S2(g) = 100 - b*g², b = 100/g_warn²
      (S2(0)=100, S2(g_warn)=0 양 끝 조건 만족)
    """
    params = USER_TYPES[user_type]
    th     = params[direction]
    g_opt  = th["g_opt"]
    g_warn = th["g_warn"]
    r      = params[f"r_{direction}"]
    S_opt  = 100.0 * (1.0 - r)

    if g_opt == 0.0:
        if g_abs == 0.0:
            return 100.0
        if g_abs <= g_warn:
            b = 100.0 / (g_warn ** 2) if g_warn > 0 else 0.0
            return max(100.0 - b * (g_abs ** 2), 0.0)
        return 0.0

    if g_abs <= g_opt:
        a = (100.0 * r) / (g_opt ** 2)
        return max(100.0 - a * (g_abs ** 2), 0.0)

    if g_abs <= g_warn:
        b = S_opt / ((g_warn - g_opt) ** 2)
        return max(S_opt - b * ((g_abs - g_opt) ** 2), 0.0)

    return 0.0


def slope_cost(g_percent: float, user_type: str, edge_length_m: float = 1.0) -> float:
    """
    부호 있는 경사도(%) → 엣지 비용.
      점수 = 0 (금지) → FORBIDDEN_PENALTY × length (기존 1e6에서 변경)
      점수 > 0        → length × (1 + penalty_ratio × 5)
    """
    direction = "up" if g_percent >= 0 else "down"
    g_abs     = abs(g_percent)
    score     = slope_score(g_abs, direction, user_type)

    if score == 0.0:
        return FORBIDDEN_PENALTY * edge_length_m

    penalty_ratio = (100.0 - score) / 100.0
    return edge_length_m * (1.0 + penalty_ratio * 5.0)


def classify_zone(slope_pct: float, direction: str, user_type: str) -> str:
    """
    구간 존 분류: flat | optimal | warning | forbidden
    """
    if direction == "flat":
        return "flat"
    params = USER_TYPES[user_type]
    th     = params[direction]
    g_abs  = abs(slope_pct)

    if g_abs <= th["g_opt"]:
        return "optimal"
    if g_abs <= th["g_warn"]:
        return "warning"
    return "forbidden"


def precompute_edge_costs(G) -> None:
    """
    서버 시작 시 1회 호출. 각 엣지에 유형별 slope_cost(alpha=1) 값을 캐시.
    이후 set_edge_weights()가 slope_cost() 재계산 없이 선형 보간만으로 동작.
    """
    for u, v, data in G.edges(data=True):
        length = data.get("length_m", 1.0)
        slope  = data.get("slope_pct", 0.0)
        for ut in USER_TYPES:
            data[f"_w1_{ut}"] = slope_cost(slope, ut, length)


def set_edge_weights(G, user_type: str, alpha: float = 1.0):
    """
    유형별 slope_cost를 'weight'로 설정.
    precompute_edge_costs() 호출 후에는 선형 보간만 수행 (slope_cost 재계산 없음).
    alpha=1.0 → 경사 비용 전체 반영 / alpha=0.0 → 순수 거리

    S7 — 시설 정책(계단 차단)은 alpha와 무관하게 항상 적용한다("세 비용 함수
    (shortest/type/personal) 모두 시설 정책 적용" 요구). alpha=0(순수 거리)
    이어도 계단 통과 불가 유형에게는 큰 유한 비용을 준다 — 이 페널티는
    slope_cost 보간(w1)과 별개 축이라 보간 이후 덮어쓴다.

    (구 routing/pathfinder.py에서 이전 — #4 CCH 전용화. facility_policy_test.py
    회귀테스트가 여전히 이 함수를 직접 쓴다.)
    """
    key = f"_w1_{user_type}"
    for u, v, data in G.edges(data=True):
        length = data["length_m"]
        w1 = data.get(key) or slope_cost(data.get("slope_pct", 0.0), user_type, length)
        weight = length + alpha * (w1 - length)
        if is_facility_blocked(user_type, data.get("highway") == "steps"):
            weight = max(weight, FORBIDDEN_PENALTY * length)
        data["weight"] = weight
