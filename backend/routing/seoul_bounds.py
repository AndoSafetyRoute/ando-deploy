"""
서울시 행정경계 판정 (의존성 없음 — ray casting point-in-polygon).

용도: 경사도 그래프(CCH)·DEM 은 서울 전역만 커버한다. 출발/도착 또는 경로
중간이 서울 밖으로 나가면 그 구간엔 경사 데이터가 없다. 이 모듈은
"이 좌표가 서울 안인가"를 싸게 판정해, 라우팅/구간 파이프라인이 서울 구간엔
경사 질문·색칠을 적용하고 서울 밖 구간은 단순 안내만 하도록 나눌 수 있게 한다.

데이터: data/seoul_boundary.json — 서울 25개 자치구 Polygon FeatureCollection
(southkorea/seoul-maps, 2013 kostat, 간소화본 ~44pt/ring). 자치구 중 하나라도
포함하면 "서울 안". 경계 자체가 간소화돼 있어 경계선 ±수십~수백 m 오차는 있으나
"서울이냐 아니냐" 판정엔 충분하다.
"""
from __future__ import annotations

import json
import os
from functools import lru_cache

_BOUNDARY_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "seoul_boundary.json")

# (min_lon, min_lat, max_lon, max_lat) — 빠른 1차 배제용. 로드 실패 시 폴백으로도 쓴다.
SEOUL_BBOX = (126.734, 37.413, 127.270, 37.715)


def _iter_rings(geometry: dict):
    """Polygon / MultiPolygon geometry → 외곽 링(list[[lon,lat], ...]) 들을 순회."""
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if gtype == "Polygon":
        if coords:
            yield coords[0]                     # 외곽 링만 (구멍은 서울 판정에 무의미)
    elif gtype == "MultiPolygon":
        for poly in coords:
            if poly:
                yield poly[0]


@lru_cache(maxsize=1)
def _polygons() -> tuple[tuple[tuple[float, float], ...], ...]:
    """경계 파일에서 링들을 (x,y) 튜플 폴리곤 리스트로 로드. 실패하면 빈 튜플."""
    try:
        with open(os.path.normpath(_BOUNDARY_PATH), encoding="utf-8") as f:
            gj = json.load(f)
    except (OSError, ValueError) as e:
        print(f"[seoul_bounds] 경계 파일 로드 실패({e}) — BBOX 폴백 사용")
        return ()

    rings: list[tuple[tuple[float, float], ...]] = []
    for feat in gj.get("features", []):
        geom = feat.get("geometry") or {}
        for ring in _iter_rings(geom):
            pts = tuple((float(p[0]), float(p[1])) for p in ring if len(p) >= 2)
            if len(pts) >= 4:
                rings.append(pts)
    return tuple(rings)


def _in_bbox(lon: float, lat: float) -> bool:
    x0, y0, x1, y1 = SEOUL_BBOX
    return x0 <= lon <= x1 and y0 <= lat <= y1


def _point_in_ring(lon: float, lat: float, ring: tuple[tuple[float, float], ...]) -> bool:
    """표준 ray-casting. ring 은 [(x,y), ...], 닫힘/열림 무관."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def is_in_seoul(lon: float, lat: float) -> bool:
    """(lon, lat) 이 서울 행정경계 안이면 True.

    경계 파일이 없으면 SEOUL_BBOX 사각형으로 폴백(느슨 — 서울 밖 일부도 True).
    """
    if not _in_bbox(lon, lat):
        return False
    rings = _polygons()
    if not rings:
        return True                            # bbox 통과 + 정밀 데이터 없음 → 폴백
    return any(_point_in_ring(lon, lat, r) for r in rings)


def split_by_seoul(coords: list) -> list[dict]:
    """
    경로 폴리라인([[lon,lat], ...]) 을 서울 안/밖 연속 구간(run)으로 나눈다.

    반환: [{"in_seoul": bool, "start_idx": int, "end_idx": int}, ...]
      - start_idx..end_idx 는 coords 인덱스(양끝 포함), run 끼리 한 점씩 겹친다
        (경계 넘는 지점을 양쪽 run 이 공유 — FE 가 이어붙이기 쉽게).
      - coords 가 2점 미만이면 [].
    """
    if not coords or len(coords) < 2:
        return []

    flags = [is_in_seoul(float(c[0]), float(c[1])) for c in coords]
    runs: list[dict] = []
    run_start = 0
    for i in range(1, len(flags)):
        if flags[i] != flags[run_start]:
            runs.append({"in_seoul": flags[run_start], "start_idx": run_start, "end_idx": i})
            run_start = i
    runs.append({"in_seoul": flags[run_start], "start_idx": run_start, "end_idx": len(coords) - 1})
    return runs


def fraction_in_seoul(coords: list) -> float:
    """폴리라인 점들 중 서울 안 비율(0.0~1.0). 좌표 없으면 0.0."""
    if not coords:
        return 0.0
    n_in = sum(1 for c in coords if is_in_seoul(float(c[0]), float(c[1])))
    return n_in / len(coords)


def segment_in_seoul(start_lonlat: tuple, end_lonlat: tuple) -> bool:
    """구간(양끝 좌표)이 서울 안이라고 볼지 — 양끝 모두 서울 안일 때만 True.

    경사 질문/색칠은 '확실히 서울 안'인 구간에만 적용하기 위한 보수적 판정.
    """
    return (
        is_in_seoul(float(start_lonlat[0]), float(start_lonlat[1]))
        and is_in_seoul(float(end_lonlat[0]), float(end_lonlat[1]))
    )
