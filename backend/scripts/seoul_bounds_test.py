"""routing/seoul_bounds.py 검증 — 실 경계 파일(data/seoul_boundary.json) 사용."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routing.seoul_bounds import (
    is_in_seoul, split_by_seoul, fraction_in_seoul, segment_in_seoul, _polygons,
)

# 서울 안 지점들
IN = [
    (126.9780, 37.5665),   # 서울시청
    (127.0276, 37.4979),   # 강남역
    (126.9910, 37.5563),   # 서울역
    (127.1058, 37.5172),   # 잠실
    (126.9220, 37.5560),   # 홍대입구
]
# 서울 밖 지점들
OUT = [
    (126.7052, 37.4563),   # 인천 부평 근처
    (127.1389, 37.4449),   # 성남 판교
    (126.8664, 37.7381),   # 양주/의정부 위
    (127.2100, 37.6000),   # 구리/남양주
    (128.0, 37.5),         # 강원 방향 (bbox 밖)
]


def test_polygons_loaded():
    rings = _polygons()
    assert len(rings) >= 20, f"자치구 링 {len(rings)}개 — 경계 파일 확인"
    print(f"[1] 경계 로드 OK — 링 {len(rings)}개")


def test_in_points():
    bad = [p for p in IN if not is_in_seoul(*p)]
    assert not bad, f"서울 안인데 False: {bad}"
    print("[2] 서울 안 5개 지점 모두 True")


def test_out_points():
    bad = [p for p in OUT if is_in_seoul(*p)]
    assert not bad, f"서울 밖인데 True: {bad}"
    print("[3] 서울 밖 5개 지점 모두 False")


def test_split_runs():
    # 서울시청 → 판교: 서울 안에서 시작해 밖으로 나가는 폴리라인 (직선 보간 20점)
    a, b = (126.9780, 37.5665), (127.1389, 37.4449)
    coords = [[a[0] + (b[0] - a[0]) * t / 19, a[1] + (b[1] - a[1]) * t / 19] for t in range(20)]
    runs = split_by_seoul(coords)
    assert len(runs) >= 2, runs
    assert runs[0]["in_seoul"] is True and runs[-1]["in_seoul"] is False, runs
    # run 은 인덱스 연속 + 한 점씩 겹침
    for r1, r2 in zip(runs, runs[1:]):
        assert r1["end_idx"] == r2["start_idx"], runs
    assert runs[0]["start_idx"] == 0 and runs[-1]["end_idx"] == 19
    frac = fraction_in_seoul(coords)
    assert 0.2 < frac < 0.9, frac
    print(f"[4] split_by_seoul — {len(runs)} run, 서울비율 {frac:.2f}")


def test_segment_conservative():
    assert segment_in_seoul((126.9780, 37.5665), (126.9910, 37.5563)) is True
    assert segment_in_seoul((126.9780, 37.5665), (127.1389, 37.4449)) is False   # 한 끝 밖
    print("[5] segment_in_seoul — 양끝 모두 안일 때만 True")


def test_empty():
    assert split_by_seoul([]) == [] and split_by_seoul([[126.97, 37.56]]) == []
    assert fraction_in_seoul([]) == 0.0
    print("[6] 빈/단일 좌표 방어 OK")


if __name__ == "__main__":
    for fn in list(globals().values()):
        if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
            fn()
    print("\nALL PASS")
