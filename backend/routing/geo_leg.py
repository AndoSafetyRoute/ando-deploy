"""
그래프 밖(서울 경계 바깥) 구간용 순수 기하 헬퍼.

경사도 그래프는 서울 전역만 커버한다. 도착/출발이 서울 밖이면 그 구간엔
도로 데이터가 없어 경로를 계산할 수 없다 — "경사 없는 최단 경로"로서 직선
(측지선) leg 를 만들어 안내만 한다. 이 모듈은 그 직선 leg 를 구성하는 데
필요한 계산만 담는다(라우팅 엔진·그래프에 의존하지 않음).
"""
from __future__ import annotations

from routing.graph import haversine


def path_length_m(coords: list) -> float:
    """[[lon,lat], ...] 폴리라인 길이(m)."""
    return sum(
        haversine(a[0], a[1], b[0], b[1])
        for a, b in zip(coords, coords[1:])
    )


def densify(a: tuple, b: tuple, step_m: float = 25.0, max_points: int = 400) -> list:
    """
    a→b 를 약 step_m 간격으로 채운 [[lon,lat], ...] (양 끝 포함).
    선형 보간 — 도시 스케일(수 km)에서 오차 무시 가능.
    """
    a = [float(a[0]), float(a[1])]
    b = [float(b[0]), float(b[1])]
    total = haversine(a[0], a[1], b[0], b[1])
    if total <= step_m:
        return [a, b]
    n = min(max_points, max(1, int(total // step_m)))
    return [[a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n]
            for t in range(n + 1)]


def boundary_attach(
    inside: tuple,
    outside: tuple,
    is_inside_fn,
    tol_m: float = 20.0,
    max_iter: int = 40,
) -> list:
    """
    inside(서울 안)–outside(서울 밖) 선분에서 경계 교차점을 이분탐색으로 찾는다.
    반환: [lon, lat] — is_inside_fn 이 True 인 쪽(서울 안)에서 tol_m 이내.

    is_inside_fn(lon, lat) -> bool. inside 가 사실 밖이거나 outside 가 사실
    안이어도 죽지 않고 각각 inside / outside 끝점을 돌려준다(방어).
    """
    lo = [float(inside[0]), float(inside[1])]    # 항상 '안'이라고 보는 쪽
    hi = [float(outside[0]), float(outside[1])]  # 항상 '밖'이라고 보는 쪽
    if not is_inside_fn(lo[0], lo[1]):
        return lo
    if is_inside_fn(hi[0], hi[1]):
        return hi
    for _ in range(max_iter):
        mid = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0]
        if is_inside_fn(mid[0], mid[1]):
            lo = mid
        else:
            hi = mid
        if haversine(lo[0], lo[1], hi[0], hi[1]) <= tol_m:
            break
    return lo


def straight_leg_segments(coords: list) -> list:
    """
    직선 leg 폴리라인 → navigation_segments 유사 구간 리스트.
    경사 데이터가 없음을 명시: slope_pct=None, zone="no_data", outside_seoul=True.
    각 구간은 폴리라인의 인접 두 점.
    """
    segs = []
    for i, (a, b) in enumerate(zip(coords, coords[1:])):
        segs.append({
            "name":         "",
            "direction":    "flat",
            "slope_pct":    None,
            "length_m":     round(haversine(a[0], a[1], b[0], b[1]), 1),
            "zone":         "no_data",
            "outside_seoul": True,
            "coords":       [[a[0], a[1]], [b[0], b[1]]],
            "start":        {"latitude": a[1], "longitude": a[0]},
            "end":          {"latitude": b[1], "longitude": b[0]},
            "slope":        None,
            "length":       round(haversine(a[0], a[1], b[0], b[1]), 1),
        })
    return segs
