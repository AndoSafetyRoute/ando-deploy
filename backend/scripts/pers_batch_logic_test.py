"""
save_collect_batch 의 EMA 경로(B-2 + Q&A#4) + 캘리브레이션 게이트(Q&A#6) 순수 로직 검증.
실 DB 없이 가짜 Session 으로 SQL 호출을 가로채 인자만 확인한다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# DATABASE_URL 없음 → database.engine=None. 아래에서 engine 을 truthy 로 강제.
import database as dbmod
from database import _zone_key_for_slope, save_collect_batch, get_user_speed_profile
from config import CALIBRATION_FLAT_M


# ── 1. _zone_key_for_slope ────────────────────────────────────────────────────
def test_zone_key():
    # elderly: up g_opt=5.0 g_warn=8.0 / down g_opt=5.0 g_warn=8.0 (routing/cost.py)
    cases = [
        (0.0,   "flat"),
        (0.3,   "flat"),      # |g| < FLAT_THRESHOLD(0.5)
        (-0.4,  "flat"),
        (2.5,   "up_optimal"),
        (7.0,   "up_warning"),
        (10.0,  "up_forbidden"),
        (-3.0,  "down_optimal"),
        (-6.0,  "down_warning"),
        (-15.0, "down_forbidden"),
    ]
    for g, want in cases:
        got = _zone_key_for_slope(g, "elderly")
        assert got == want, f"slope {g}: got {got}, want {want}"
    print("[1] _zone_key_for_slope OK")


# ── 2. 가짜 Session ──────────────────────────────────────────────────────────
class FakeResult:
    def __init__(self, row=None, rows=None):
        self._row, self._rows = row, rows or []
    def fetchone(self): return self._row
    def fetchall(self): return self._rows


class FakeSession:
    """execute() 호출을 순서대로 기록. SELECT 는 미리 세팅한 응답을 순서대로 반환."""
    def __init__(self, select_responses):
        self.calls = []
        self._selects = list(select_responses)
        self.committed = 0
    def execute(self, clause, params=None):
        sql = str(clause)
        self.calls.append((sql, params or {}))
        low = sql.strip().lower()
        if low.startswith("insert into collect_batch_log"):
            return FakeResult(row=("uid-1",))          # 신규(중복 아님)
        if low.startswith("select"):
            return self._selects.pop(0) if self._selects else FakeResult()
        return FakeResult()
    def commit(self): self.committed += 1


def test_batch_ema_flat_gate():
    dbmod.engine = object()  # truthy

    # 평지 관측 2건(각 200m, 유효 속도) + 오르막 1건 + 잘못된 1건(gps_n 부족)
    slope_obs = [
        {"slope_bin": 0.0,  "distance_m": 200.0, "elapsed_ms": 300_000, "stop_ms": 0, "gps_sample_n": 8},
        {"slope_bin": 0.0,  "distance_m": 200.0, "elapsed_ms": 300_000, "stop_ms": 0, "gps_sample_n": 8},
        {"slope_bin": 6.0,  "distance_m": 60.0,  "elapsed_ms": 120_000, "stop_ms": 0, "gps_sample_n": 6},
        {"slope_bin": 0.0,  "distance_m": 10.0,  "elapsed_ms": 5_000,   "stop_ms": 0, "gps_sample_n": 1},  # invalid
    ]
    # SELECT 응답 순서:
    #  (a) users.user_type -> elderly
    #  (b) flat 조회 -> 없음
    #  (c) flat 조회(2번째 관측) -> 있음 (speed=0.66, count=1)
    #  (d) up_warning 조회 -> 없음
    selects = [
        FakeResult(row=("elderly",)),
        FakeResult(row=None),
        FakeResult(row=(0.66, 1)),
        FakeResult(row=None),
    ]
    db = FakeSession(selects)
    res = save_collect_batch(db, "uid-1", "sess-1", 0, slope_obs, [], None, [])

    assert res["ok"] and not res["duplicate"], res
    assert res["saved"]["speed_ema_applied"] == 3, res["saved"]  # 유효 3건만
    # trip_slope_observations INSERT 4건(원본은 전부 저장) 확인
    ins = [c for c in db.calls if "insert into trip_slope_observations" in c[0].lower()]
    assert len(ins) == 4, len(ins)
    # user_speed_profile 갱신에 flat 2회 + up_warning 1회 등장
    prof_writes = [c for c in db.calls
                   if "user_speed_profile" in c[0].lower() and
                   c[0].strip().lower().startswith(("insert", "update"))]
    zks = [c[1].get("zone_key") for c in prof_writes]
    assert zks.count("flat") == 2 and zks.count("up_warning") == 1, zks
    # 첫 flat 은 INSERT(cumulative=200), 두번째는 UPDATE(+200)
    assert prof_writes[0][0].strip().lower().startswith("insert")
    assert abs(prof_writes[0][1]["dist"] - 200.0) < 1e-6
    assert prof_writes[1][0].strip().lower().startswith("update")
    print("[2] save_collect_batch EMA 경로 OK (원본 4건 저장, 유효 3건 EMA, flat/up_warning 매핑)")


def test_calibration_gate():
    dbmod.engine = object()
    # flat 누적 250m (< 300) → flat 제외, up_optimal 은 그대로
    rows = [("flat", 0.7, 250.0), ("up_optimal", 0.5, 40.0)]
    db = FakeSession([FakeResult(rows=rows)])
    prof = get_user_speed_profile(db, "uid-1")
    assert "flat" not in prof and prof.get("up_optimal") == 0.5, prof

    # flat 누적 320m (>= 300) → 포함
    rows2 = [("flat", 0.72, 320.0)]
    db2 = FakeSession([FakeResult(rows=rows2)])
    prof2 = get_user_speed_profile(db2, "uid-1")
    assert prof2.get("flat") == 0.72, prof2

    # calibrated_only=False → 항상 포함(학습용)
    db3 = FakeSession([FakeResult(rows=[("flat", 0.7, 10.0)])])
    assert get_user_speed_profile(db3, "uid-1", calibrated_only=False).get("flat") == 0.7
    print(f"[3] 캘리브레이션 게이트 OK (CALIBRATION_FLAT_M={CALIBRATION_FLAT_M})")


if __name__ == "__main__":
    test_zone_key()
    test_batch_ema_flat_gate()
    test_calibration_gate()
    print("\nALL OK")
