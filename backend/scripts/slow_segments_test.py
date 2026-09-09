"""slow-segments 순수 로직 검증 (실 DB 없이 FakeSession).
그룹핑(_route_segment_groups) / 필터(_slow_seg_eligible) / 랭킹·저장 /
get_slow_segments meta·seg_index_end / hardship upsert 를 본다.
SQL 위임분(ORDER BY 등)은 검증 대상 아님."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import database as dbmod
from database import (
    get_slow_segments, save_segment_hardship_feedback,
    _rank_and_store_slow_segments, _route_segment_groups, _slow_seg_eligible,
)


class FakeResult:
    def __init__(self, row=None, rows=None):
        self._row, self._rows = row, rows or []
    def fetchone(self): return self._row
    def fetchall(self): return self._rows


class FakeSession:
    def __init__(self, selects):
        self.calls = []
        self._selects = list(selects)
        self.committed = 0
    def execute(self, clause, params=None):
        sql = str(clause); self.calls.append((sql, params or {}))
        if sql.strip().lower().startswith("select"):
            return self._selects.pop(0) if self._selects else FakeResult()
        return FakeResult()
    def commit(self): self.committed += 1


# navigation_segments 행: (seg_index, distance_m, slope_pct, direction, zone, name, elapsed_ms, measured)
def edge(si, d, slope, el, measured=True, direction="up", zone="warning", name=""):
    return (si, d, slope, direction, zone, name, el, measured)


def test_grouping_basic():
    dbmod.engine = object()
    # 엣지 0..3: ~6% 연속 → 한 그룹.  엣지 4: 평지.  엣지 5..6: ~3.5% → 그룹2.
    rows = [
        edge(0, 10, 6.1, 14000), edge(1, 10, 5.9, 15000),
        edge(2, 8,  6.0, 12000), edge(3, 12, 6.2, 16000),
        edge(4, 10, 0.1, 9000, direction="flat", zone="flat"),
        edge(5, 10, 3.6, 11000, zone="optimal"), edge(6, 10, 3.4, 10000, zone="optimal"),
    ]
    db = FakeSession([FakeResult(rows=rows)])
    groups = _route_segment_groups(db, 1)
    assert [ (g["seg_index"], g["seg_index_end"]) for g in groups ] == [(0,3),(4,4),(5,6)], groups
    g0 = groups[0]
    assert abs(g0["distance_m"] - 40) < 1e-6 and g0["elapsed_ms"] == 57000
    assert abs(g0["slope_pct"] - (6.1*10+5.9*10+6.0*8+6.2*12)/40) < 1e-3
    assert abs(g0["pace_s_per_m"] - 57.0/40) < 1e-3
    assert not _slow_seg_eligible(groups[1])            # 평지 그룹 탈락
    assert _slow_seg_eligible(groups[0])
    print("[1] _route_segment_groups — 유사 경사 연속 묶기 / 평지 그룹 eligible 탈락 OK")


def test_grouping_slope_band():
    """HTTP 스모크에서 발견: 인접 유사 경사가 고정 bin 경계에서 갈라지던 버그."""
    dbmod.engine = object()
    rows = [
        # 오르막 6.1/6.4/5.9 — 한 그룹 (스모크 케이스)
        edge(0, 13, 6.1, 18000), edge(1, 13, 6.4, 19000), edge(2, 13, 5.9, 18000),
        # 내리막 -5.2/-5.5 — 한 그룹이어야 함 (예전엔 bin -5/-6 로 갈라져 25m 미달 탈락)
        edge(3, 13, -5.2, 12000), edge(4, 13, -5.5, 12000),
        # 경사 급변 3.0 → 8.0 — 갈라짐
        edge(5, 13, 3.0, 15000), edge(6, 13, 8.0, 22000),
    ]
    db = FakeSession([FakeResult(rows=rows)])
    groups = _route_segment_groups(db, 1)
    spans = [ (g["seg_index"], g["seg_index_end"]) for g in groups ]
    assert spans == [(0,2),(3,4),(5,5),(6,6)], spans
    downhill = groups[1]
    assert downhill["distance_m"] == 26 and downhill["slope_pct"] < 0
    assert _slow_seg_eligible(downhill), "내리막 26m 구간이 랭킹 대상이어야 함"
    print("[1b] 경사 밴드 묶기 — 내리막 -5.2/-5.5 한 그룹(26m) 유지 / 급변 분리 OK")


def test_tiebreak_equal_pace():
    """pace 완전 동률이면 거리 큰 구간이 rank1 (사용자 사양: distance DESC tie-break)."""
    dbmod.engine = object()
    # A: 26m / 39000ms → pace 1.5 .  B: 40m / 60000ms → pace 1.5 (동률).  B가 더 김.
    rows = [
        edge(0, 13, 6.0, 19500), edge(1, 13, 6.0, 19500),           # A 26m
        edge(2, 30, 0.1, 20000, direction="flat", zone="flat"),     # 경계
        edge(3, 20, 6.0, 30000), edge(4, 20, 6.0, 30000),           # B 40m
    ]
    db = FakeSession([FakeResult(rows=rows)])
    _rank_and_store_slow_segments(db, 7)
    ins = [c for c in db.calls if c[0].strip().lower().startswith("insert into route_slow_segments")]
    assert [c[1]["rank"] for c in ins] == [1, 2]
    assert ins[0][1]["seg_index"] == 3 and ins[0][1]["distance_m"] == 40, ins[0][1]  # B(김) 먼저
    assert ins[1][1]["seg_index"] == 0 and ins[1][1]["distance_m"] == 26
    assert ins[0][1]["pace"] == ins[1][1]["pace"]
    print("[1c] tie-break — pace 동률 시 거리 큰 구간이 rank1 OK")


def test_grouping_breaks_on_gap_and_unmeasured():
    dbmod.engine = object()
    rows = [
        edge(0, 10, 5.0, 12000), edge(1, 10, 5.1, 12000),
        edge(2, 10, 5.0, 12000, measured=False),      # 미측정 → 그룹 끊김
        edge(3, 10, 5.0, 12000),                       # 새 그룹
        edge(5, 10, 5.0, 12000),                       # seg_index 점프(4 없음) → 또 새 그룹
    ]
    db = FakeSession([FakeResult(rows=rows)])
    groups = _route_segment_groups(db, 1)
    assert [ (g["seg_index"], g["seg_index_end"]) for g in groups ] == [(0,1),(3,3),(5,5)], groups
    print("[2] 그룹 경계 — 미측정/인덱스 점프에서 끊김 OK")


def test_eligible_filter():
    # 짧음
    assert not _slow_seg_eligible({"distance_m": 15, "elapsed_ms": 20000, "slope_pct": 6.0})
    # 평지
    assert not _slow_seg_eligible({"distance_m": 60, "elapsed_ms": 80000, "slope_pct": 0.2})
    # 너무 빠름 (60m/12s=5m/s)
    assert not _slow_seg_eligible({"distance_m": 60, "elapsed_ms": 12000, "slope_pct": 6.0})
    # 정상
    assert _slow_seg_eligible({"distance_m": 60, "elapsed_ms": 90000, "slope_pct": 6.0})
    print("[3] _slow_seg_eligible — 길이/평지/속도 필터 OK")


def test_rank_and_store():
    dbmod.engine = object()
    # 3개 그룹 나오게: A(느림, pace 큼) / B(빠름) / C(평지, 탈락)
    rows = [
        edge(0, 20, 7.0, 40000), edge(1, 20, 7.0, 44000),   # A: 40m/84s → pace 2.1
        edge(2, 20, 3.0, 22000), edge(3, 20, 3.0, 20000),   # B: 40m/42s → pace 1.05
        edge(4, 30, 0.1, 25000, direction="flat", zone="flat"),  # C 평지 → 탈락
    ]
    db = FakeSession([FakeResult(rows=rows)])
    n = _rank_and_store_slow_segments(db, 99)
    assert n == 2, n
    ins = [c for c in db.calls if c[0].strip().lower().startswith("insert into route_slow_segments")]
    assert [c[1]["rank"] for c in ins] == [1, 2]
    assert ins[0][1]["seg_index"] == 0 and ins[0][1]["seg_index_end"] == 1   # A 먼저 (pace 큼)
    assert ins[1][1]["seg_index"] == 2 and ins[1][1]["seg_index_end"] == 3
    assert ins[0][1]["pace"] > ins[1][1]["pace"]
    dels = [c for c in db.calls if c[0].strip().lower().startswith("delete from route_slow_segments")]
    assert len(dels) == 1
    print("[4] _rank_and_store_slow_segments — 그룹→pace 랭킹→seg_index_end 저장 OK")


# route_slow_segments 행: (rank, seg_index, seg_index_end, distance_m, slope_pct, direction, zone, name, elapsed_ms, pace)
def slow_row(rank, si, si_end, d, slope, el, pace, direction="up", zone="warning", name="A"):
    return (rank, si, si_end, d, slope, direction, zone, name, el, pace)


def test_get_eligible():
    dbmod.engine = object()
    grp_rows = [edge(0, 20, 7.0, 40000), edge(1, 20, 7.0, 44000),
                edge(2, 20, 3.0, 22000), edge(3, 20, 3.0, 20000)]
    slow_rows = [slow_row(1, 0, 1, 40.0, 7.0, 84000, 2.1),
                 slow_row(2, 2, 3, 40.0, 3.0, 42000, 1.05)]
    db = FakeSession([
        FakeResult(row=("completed",)),   # 소유+status
        FakeResult(rows=grp_rows),         # _route_segment_groups (meta용)
        FakeResult(rows=slow_rows),        # _SLOW_SEG_SELECT
    ])
    res = get_slow_segments(db, 123, "uid-1")
    assert res["eligible"] is True
    assert res["segments"][0]["seg_index"] == 0 and res["segments"][0]["seg_index_end"] == 1
    assert res["segments"][1]["seg_index_end"] == 3
    assert res["meta"] == {"total_segments": 2, "sloped_segments": 2, "ranked": 2}, res["meta"]
    print("[5] get_slow_segments eligible — seg_index_end·그룹 meta OK")


def test_get_not_eligible_all_flat():
    dbmod.engine = object()
    grp_rows = [edge(0, 30, 0.1, 30000, direction="flat", zone="flat"),
                edge(1, 30, 0.2, 30000, direction="flat", zone="flat")]
    db = FakeSession([
        FakeResult(row=("completed",)),
        FakeResult(rows=grp_rows),   # groups (meta)
        FakeResult(rows=[]),          # _SLOW_SEG_SELECT
        FakeResult(rows=[]),          # fallback: _route_segment_groups in _rank_and_store
        FakeResult(rows=[]),          # fallback 후 재조회
    ])
    res = get_slow_segments(db, 123, "uid-1")
    assert res["eligible"] is False and res["reason"] == "no_sloped_segments", res
    assert res["meta"]["total_segments"] == 1   # 평지 2엣지가 한 그룹
    print("[6] get_slow_segments — 전부 평지 → no_sloped_segments")


def test_get_not_eligible_no_segments():
    dbmod.engine = object()
    db = FakeSession([
        FakeResult(row=("in_progress",)),
        FakeResult(rows=[]),   # groups
        FakeResult(rows=[]), FakeResult(rows=[]), FakeResult(rows=[]),
    ])
    res = get_slow_segments(db, 123, "uid-1")
    assert res["reason"] == "route_not_completed", res
    print("[7] get_slow_segments — in_progress + 0 → route_not_completed")


def test_get_owner_mismatch():
    dbmod.engine = object()
    assert get_slow_segments(FakeSession([FakeResult(row=None)]), 123, "x") is None
    print("[8] get_slow_segments 비소유자 → None")


def test_save_hardship():
    dbmod.engine = object()
    answers = [
        {"seg_index": 0, "seg_index_end": 3, "rank": 1, "pace_s_per_m": 2.1,
         "elapsed_ms": 84000, "distance_m": 40.0, "slope_pct": 7.0, "zone": "warning",
         "was_uncomfortable": True, "hardship_score": 15},                # clamp 10
        {"seg_index": 5, "seg_index_end": 6, "rank": 2, "pace_s_per_m": 1.4,
         "elapsed_ms": 40000, "distance_m": 30.0, "slope_pct": 2.0, "zone": "optimal",
         "was_uncomfortable": False, "hardship_score": 7},                # → None
    ]
    db = FakeSession([FakeResult(row=(1,))])
    res = save_segment_hardship_feedback(db, 123, "uid-1", "sess-9", answers)
    assert res == {"ok": True, "count": 2}, res
    ins = [c for c in db.calls if c[0].strip().lower().startswith("insert into segment_hardship_feedback")]
    assert ins[0][1]["score"] == 10 and ins[1][1]["score"] is None
    assert ins[0][1]["seg_end"] == 3 and ins[1][1]["seg_end"] == 6
    print("[9] save_segment_hardship_feedback — seg_index_end·clamp·null score OK")


def test_save_owner_mismatch():
    dbmod.engine = object()
    assert save_segment_hardship_feedback(FakeSession([FakeResult(row=None)]), 1, "x", None, []) is None
    print("[10] save_segment_hardship_feedback 비소유자 → None")


if __name__ == "__main__":
    for fn in list(globals().values()):
        if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
            fn()
    print("\nALL PASS")
