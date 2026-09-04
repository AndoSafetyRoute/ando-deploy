"""
Zone 기반 개인화 속도 추정 모듈.

레퍼런스:
  - SCIRE Project: Wheelchair Propulsion on Non-Level Surfaces
  - IMU 실측 연구 (PMC 2023): 수동휠체어 실생활 평균 0.43 m/s
  - Tobler(1993) / Findings(2022): GPS 궤적 기반 Tobler 파라미터 개인화
  - Strava GAP: (zone, distance, time) 누적 후 EMA 업데이트
"""
from __future__ import annotations

# zone_key 목록
ZONE_KEYS = [
    "flat",
    "up_optimal", "up_warning", "up_forbidden",
    "down_optimal", "down_warning", "down_forbidden",
]

# 기본 속도(m/s) — 문헌 기반 + IMU 실측 보정
# 수동휠체어 flat 0.65: 실험실 1.17 m/s × 실생활 보정 0.56
ZONE_SPEED_DEFAULTS: dict[str, dict[str, float]] = {
    "manual_wheelchair": {
        "flat":           0.65,
        "up_optimal":     0.52,
        "up_warning":     0.39,
        "up_forbidden":   0.22,
        "down_optimal":   0.68,
        "down_warning":   0.59,
        "down_forbidden": 0.50,
    },
    "electric_wheelchair": {
        "flat":           1.10,
        "up_optimal":     1.00,
        "up_warning":     0.77,
        "up_forbidden":   0.55,
        "down_optimal":   1.10,
        "down_warning":   0.99,
        "down_forbidden": 0.88,
    },
    "walker": {
        "flat":           0.70,
        "up_optimal":     0.56,
        "up_warning":     0.42,
        "up_forbidden":   0.28,
        "down_optimal":   0.73,
        "down_warning":   0.63,
        "down_forbidden": 0.52,
    },
    "cane": {
        "flat":           0.65,
        "up_optimal":     0.52,
        "up_warning":     0.39,
        "up_forbidden":   0.26,
        "down_optimal":   0.65,
        "down_warning":   0.55,
        "down_forbidden": 0.45,
    },
    "leg_injury": {
        "flat":           0.70,
        "up_optimal":     0.56,
        "up_warning":     0.42,
        "up_forbidden":   0.28,
        "down_optimal":   0.70,
        "down_warning":   0.60,
        "down_forbidden": 0.49,
    },
    "elderly": {
        "flat":           0.80,
        "up_optimal":     0.64,
        "up_warning":     0.48,
        "up_forbidden":   0.32,
        "down_optimal":   0.84,
        "down_warning":   0.72,
        "down_forbidden": 0.60,
    },
}

_EMA_MIN_ALPHA = 0.05   # 누적 20+회부터 신규 관측 5%만 반영 (안정화)
# 첫 관측(n=0)의 alpha 상한. 1/(n+1)=1.0 이면 관측 1건이 유형 기본값을 완전히
# 덮어써, 희귀 zone 에서 GPS 노이즈 1건이 프로파일을 오염시킨다. 첫 관측은
# prior 50% + 관측 50% 로만 반영한다 (data-collection-plan §1.4, 이슈 P2).
_EMA_START_ALPHA_CAP = 0.5
_SPEED_MIN    = 0.05    # m/s 하한 (완전 정지 제외)
_SPEED_MAX    = 2.50    # m/s 상한 (뛰는 속도 초과 제외)
_MIN_ELAPSED_S = 3.0    # 너무 빠른 통과 제외 (GPS 점프 방어)
_MIN_GPS_N    = 3       # 신뢰할 최소 GPS 샘플 수


def get_zone_key(zone: str | None, direction: str | None) -> str:
    """zone + direction → zone_key 변환"""
    if not zone or zone == "flat" or not direction or direction == "flat":
        return "flat"
    d = "up" if direction == "up" else "down"
    if zone == "optimal":
        return f"{d}_optimal"
    if zone == "warning":
        return f"{d}_warning"
    if zone == "forbidden":
        return f"{d}_forbidden"
    return "flat"


def validate_observation(
    distance_m: float,
    elapsed_ms: int,
    gps_sample_n: int,
    stop_ms: int = 0,
) -> float | None:
    """
    zone 통과 관측값 유효성 검사 후 속도(m/s) 반환.
    유효하지 않으면 None.
    """
    if gps_sample_n < _MIN_GPS_N:
        return None
    net_s = (elapsed_ms - stop_ms) / 1000.0
    if net_s < _MIN_ELAPSED_S or distance_m <= 0:
        return None
    speed = distance_m / net_s
    if not (_SPEED_MIN < speed < _SPEED_MAX):
        return None
    return round(speed, 4)


def ema_update(current: float, observed: float, n: int) -> float:
    """
    Exponential Moving Average 업데이트.
    n: 업데이트 전 누적 관측 횟수.
    alpha는 n 증가에 따라 감소, [_EMA_MIN_ALPHA, _EMA_START_ALPHA_CAP] 로 clamp.
    (첫 관측도 prior 를 절반은 남긴다 — §1.4)
    """
    alpha = min(1.0 / (n + 1), _EMA_START_ALPHA_CAP)
    alpha = max(alpha, _EMA_MIN_ALPHA)
    return round(alpha * observed + (1 - alpha) * current, 4)


def get_default_speed(user_type: str, zone_key: str) -> float:
    defaults = ZONE_SPEED_DEFAULTS.get(user_type, ZONE_SPEED_DEFAULTS["elderly"])
    return defaults.get(zone_key, defaults["flat"])


def estimate_route_time(
    segments: list[dict],
    user_type: str,
    speed_profile: dict[str, float],
) -> float:
    """
    경로 구간 목록 → 예상 소요시간(초).
    speed_profile: {zone_key: speed_ms} — DB에서 조회한 개인화 프로파일.
    관측 없는 zone_key는 ZONE_SPEED_DEFAULTS fallback.
    """
    total_s = 0.0
    for seg in segments:
        key   = get_zone_key(seg.get("zone"), seg.get("direction"))
        speed = speed_profile.get(key) or get_default_speed(user_type, key)
        dist  = float(seg.get("length_m") or seg.get("distance_m") or 0.0)
        total_s += dist / max(speed, 0.01)
    return round(total_s, 1)
