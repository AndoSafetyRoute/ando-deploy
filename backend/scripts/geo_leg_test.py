"""routing/geo_leg.py 검증 (순수 기하)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routing.geo_leg import path_length_m, densify, boundary_attach, straight_leg_segments
from routing.graph import haversine

SEOUL = (126.9780, 37.5665)   # 시청
PANGYO = (127.1112, 37.3947)  # 판교 (서울 밖, 남동쪽)


def test_path_length():
    assert path_length_m([]) == 0
    assert path_length_m([[126.97, 37.56]]) == 0
    d = path_length_m([list(SEOUL), list(PANGYO)])
    ref = haversine(*SEOUL, *PANGYO)
    assert abs(d - ref) < 1.0, (d, ref)
    print(f"[1] path_length_m — 시청~판교 {d/1000:.1f}km")


def test_densify():
    a, b = SEOUL, PANGYO
    pts = densify(a, b, step_m=100)
    assert pts[0] == [a[0], a[1]] and pts[-1] == [b[0], b[1]]
    # 간격 ~100m ±50%
    gaps = [haversine(*pts[i], *pts[i + 1]) for i in range(len(pts) - 1)]
    assert all(40 < g < 160 for g in gaps), (min(gaps), max(gaps))
    # 아주 짧으면 양 끝만
    assert densify((126.97, 37.56), (126.9701, 37.5601), step_m=100) == \
           [[126.97, 37.56], [126.9701, 37.5601]]
    # max_points 캡
    assert len(densify(a, b, step_m=1, max_points=50)) == 51
    print(f"[2] densify — {len(pts)}점, 간격 {min(gaps):.0f}~{max(gaps):.0f}m")


def test_boundary_attach():
    # is_inside: 경도 < 127.05 이면 '안' 이라고 치는 가짜 판정
    def fake_inside(lon, lat):
        return lon < 127.05

    p = boundary_attach(SEOUL, PANGYO, fake_inside, tol_m=30)
    assert fake_inside(p[0], p[1]), p                 # 결과는 '안' 쪽
    assert abs(p[0] - 127.05) < 0.01, p               # 경계(127.05) 근처
    # inside 가 사실 밖이면 그대로 반환
    assert boundary_attach(PANGYO, SEOUL, fake_inside) == [PANGYO[0], PANGYO[1]]
    # outside 가 사실 안이면 그대로 반환
    assert boundary_attach(SEOUL, (127.0, 37.56), fake_inside) == [127.0, 37.56]
    print(f"[3] boundary_attach — 교차점 lon={p[0]:.4f} (경계 127.05)")


def test_boundary_attach_real():
    from routing.seoul_bounds import is_in_seoul
    p = boundary_attach(SEOUL, PANGYO, is_in_seoul, tol_m=20)
    assert is_in_seoul(p[0], p[1]), p
    # 판교보다 시청에 가까운 어딘가, 서울 남동쪽 경계
    assert 37.35 < p[1] < 37.57 and 126.97 < p[0] < 127.15, p
    print(f"[4] boundary_attach(실경계) — [{p[0]:.4f}, {p[1]:.4f}]")


def test_straight_leg_segments():
    pts = densify(SEOUL, (127.02, 37.50), step_m=200)
    segs = straight_leg_segments(pts)
    assert len(segs) == len(pts) - 1
    s = segs[0]
    assert s["slope_pct"] is None and s["slope"] is None
    assert s["zone"] == "no_data" and s["outside_seoul"] is True
    assert s["direction"] == "flat" and s["length_m"] > 0
    assert "start" in s and "end" in s and s["start"]["latitude"] == pts[0][1]
    tot = sum(x["length_m"] for x in segs)
    assert abs(tot - path_length_m(pts)) < 5, (tot, path_length_m(pts))
    print(f"[5] straight_leg_segments — {len(segs)}구간, slope=None/zone=no_data, Σ{tot:.0f}m")


if __name__ == "__main__":
    for fn in list(globals().values()):
        if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
            fn()
    print("\nALL PASS")
