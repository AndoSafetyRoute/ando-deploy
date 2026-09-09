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
from routing.speed import ema_update
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
    def __init__(self, select_responses, dup_batch=False):
        self.calls = []
        self._selects = list(select_responses)
        self.committed = 0
        self._dup_batch = dup_batch     # True 면 collect_batch_log INSERT 가 중복(RETURNING 없음)
    def execute(self, clause, params=None):
        sql = str(clause)
        self.calls.append((sql, params or {}))
        low = sql.strip().lower()
        if low.startswith("insert into collect_batch_log"):
            return FakeResult(row=None if self._dup_batch else ("uid-1",))
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


# ── 4. 신호 C/D + route_profile INSERT 경로 ──────────────────────────────────
def test_batch_signals_cdr():
    dbmod.engine = object()

    route_choice = {
        "candidates": [
            {"kind": "type",     "profile": [{"bin": 0.0, "length_m": 100.0}], "length_m": 100.0, "shown_pos": 1},
            {"kind": "distance", "profile": [{"bin": 2.5, "length_m": 90.0}],  "length_m": 90.0,  "shown_pos": 0},
        ],
        "n_shown": 2,
        "chosen_kind": "distance",
    }
    seg_fb = [
        {"route_id": 42, "slope_mean": 6.2, "length_m": 90.0, "verdict": -1},
        {"route_id": 42, "slope_mean": -4.0, "length_m": 40.0, "verdict": 1},
    ]
    route_profile = {
        "route_id": None,
        "total_length_m": 190.0,
        "segments": [{"slope": 0.0, "length_m": 100.0}, {"slope": 2.5, "length_m": 90.0}],
        "coordinates": [[127.0, 37.5], [127.001, 37.501]],
    }
    # SELECT: users.user_type 1회만 (slope_obs 없음)
    db = FakeSession([FakeResult(row=("elderly",))])
    res = save_collect_batch(db, "uid-1", "sess-9", 0, [], [], route_choice, seg_fb, route_profile)

    assert res["ok"] and not res["duplicate"], res
    assert res["saved"]["route_choice"] is True
    assert res["saved"]["segment_feedback"] == 2
    assert res["saved"]["route_profile"] is True, res["saved"]

    rc = [c for c in db.calls if "insert into route_choice_log" in c[0].lower()]
    sf = [c for c in db.calls if "insert into segment_feedback" in c[0].lower()]
    srp = [c for c in db.calls if "session_route_profile" in c[0].lower()]
    assert len(rc) == 1 and rc[0][1]["n_shown"] == 2 and rc[0][1]["chosen_kind"] == "distance", rc
    assert len(sf) == 2 and {c[1]["verdict"] for c in sf} == {-1, 1}, sf
    assert len(srp) == 1 and srp[0][1]["total_length_m"] == 190.0, srp
    print("[4] 신호 C/D + route_profile INSERT 경로 OK")


# ── 5. 멱등 재전송 시 관측/EMA 중복 없음 ─────────────────────────────────────
def test_idempotent_resend_no_double_write():
    dbmod.engine = object()
    slope_obs = [{"slope_bin": 0.0, "distance_m": 200.0, "elapsed_ms": 300_000, "stop_ms": 0, "gps_sample_n": 8}]
    # dup_batch=True → collect_batch_log INSERT 가 RETURNING 없이 반환(이미 처리된 배치)
    db = FakeSession([], dup_batch=True)
    res = save_collect_batch(db, "uid-1", "sess-1", 0, slope_obs, [], None, [])

    assert res["ok"] and res["duplicate"] is True, res
    # 멱등 조기 반환 — 관측/프로파일/유형 조회 어느 것도 실행되지 않아야 함
    assert not any("insert into trip_slope_observations" in c[0].lower() for c in db.calls)
    assert not any("user_speed_profile" in c[0].lower() for c in db.calls)
    assert not any("select user_type from users" in c[0].lower() for c in db.calls)
    print("[5] 멱등 재전송 → 관측/EMA 중복 쓰기 없음 OK")


# ── 6. 첫 관측 EMA alpha 상한 ────────────────────────────────────────────────
def test_ema_start_alpha_cap():
    # n=0: 예전엔 alpha=1.0 → 관측이 prior 를 완전히 대체. 이제 상한 0.5.
    assert abs(ema_update(0.80, 0.40, 0) - 0.60) < 1e-9, ema_update(0.80, 0.40, 0)
    # n=1: 1/(1+1)=0.5 == 상한, 변화 없음
    assert abs(ema_update(0.80, 0.40, 1) - 0.60) < 1e-9
    # n=3: 1/4=0.25 → 0.25*0.4 + 0.75*0.8 = 0.70
    assert abs(ema_update(0.80, 0.40, 3) - 0.70) < 1e-9
    # 큰 n: 하한 0.05 로 clamp
    assert abs(ema_update(0.80, 0.40, 999) - (0.05 * 0.40 + 0.95 * 0.80)) < 1e-9
    print("[6] EMA 첫 관측 alpha 상한(0.5) OK")


if __name__ == "__main__":
    test_zone_key()
    test_batch_ema_flat_gate()
    test_calibration_gate()
    test_batch_signals_cdr()
    test_idempotent_resend_no_double_write()
    test_ema_start_alpha_cap()
    print("\nALL OK")
