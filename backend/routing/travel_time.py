"""
NavSegment 기반 소요시간 추정

기존 routing/speed.py (zone_key + EMA 개인화)와 별도.
이 모듈은 slope_score 기반 물리 모델로 NavSegment → 초(秒) 환산.
"""
from routing.cost import slope_score

BASE_SPEED_MS = {
    "manual_wheelchair":   0.8,
    "electric_wheelchair": 1.2,
    "walker":              0.6,
    "cane":                0.9,
    "leg_injury":          0.7,
    "elderly":             0.7,
}


def estimate_travel_time(segment, user_type: str) -> float:
    """NavSegment 1개 → 소요시간(초)."""
    slope = segment.slope_mean
    direction = "up" if slope >= 0 else "down"
    score = slope_score(abs(slope), direction, user_type)
    speed_factor = 0.4 + 0.6 * (score / 100.0)
    speed = BASE_SPEED_MS[user_type] * speed_factor
    return segment.length_m / max(speed, 0.01)


def estimate_route_time(segments: list, user_type: str) -> dict:
    """NavSegment 목록 → 전체 소요시간 dict."""
    if not segments:
        return {"total_seconds": 0.0, "total_minutes": 0.0, "segments": []}

    times = [estimate_travel_time(s, user_type) for s in segments]
    total = sum(times)

    return {
        "total_seconds": round(total, 1),
        "total_minutes": round(total / 60.0, 1),
        "segments": [
            {
                "segment_id":        s.segment_id,
                "length_m":          round(s.length_m, 1),
                "slope_mean":        s.slope_mean,
                "zone":              s.zone,
                "estimated_seconds": round(t, 1),
            }
            for s, t in zip(segments, times)
        ],
    }
