"""
음성안내 텍스트 생성

bearing: 북=0°, 시계방향 양수, 0~360°
turn_diff:  -180 ~ +180°  (우=양수, 좌=음수)
"""
import math


def calculate_bearing(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """두 WGS84 좌표 사이 방위각 (0-360°, 북=0, 시계방향)."""
    lat1_r = math.radians(lat1)
    lat2_r = math.radians(lat2)
    d_lon  = math.radians(lon2 - lon1)
    x = math.sin(d_lon) * math.cos(lat2_r)
    y = math.cos(lat1_r) * math.sin(lat2_r) - math.sin(lat1_r) * math.cos(lat2_r) * math.cos(d_lon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def get_turn_direction(heading: float, next_bearing: float) -> str:
    """현재 방향(heading) vs 다음 구간 방위각으로 회전 방향 문자열 반환."""
    diff = (next_bearing - heading + 360) % 360
    if diff > 180:
        diff -= 360  # -180 ~ +180
    if abs(diff) < 30:
        return "직진"
    if abs(diff) >= 150:
        return "유턴"
    return "우회전" if diff > 0 else "좌회전"


def generate_guidance_text(turn: str, next_segment) -> str:
    """회전 방향 + 다음 NavSegment 정보 → 자연어 안내 문자열."""
    dist  = int(next_segment.length_m)
    slope = next_segment.slope_mean
    zone  = next_segment.zone

    if turn == "직진":
        direction_part = f"{dist}m 직진"
    elif turn == "유턴":
        direction_part = f"유턴 후 {dist}m"
    else:
        direction_part = f"{dist}m 앞 {turn}"

    if zone == "flat" or abs(slope) < 1.0:
        terrain_part = "평지"
    else:
        word = "오르막" if slope > 0 else "내리막"
        if zone == "optimal":
            adj = "완만한"
        elif zone == "warning":
            adj = "가파른"
        else:
            adj = "매우 가파른"
        terrain_part = f"{adj} {word}({abs(slope):.1f}%)"

    text = f"{direction_part}, {terrain_part}"

    if zone == "warning":
        text += " — 주의 요망"
    elif zone == "forbidden":
        text += " — 통행 어려움"

    return text
