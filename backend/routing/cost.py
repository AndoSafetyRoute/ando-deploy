"""
경사도 점수 & 엣지 비용 함수 + 유형별 파라미터 테이블
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
}


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
