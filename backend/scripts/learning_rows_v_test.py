"""
S6 회귀 테스트 — learning_rows_v 뷰가 5개 조건(valid/facility/is_tester/
participant_cohort/phase)을 전부 정확히 AND로 거르는지 확인.

로컬 dev Postgres 필요(DATABASE_URL이 localhost 아니면 중단 — dev_seed_local.py와
동일한 안전장치). 실행 후 만든 테스트 행은 스크립트가 직접 정리한다.

사용법 (ando_route conda env, backend/ 에서):
  DATABASE_URL=postgresql://postgres:devpassword@localhost:5433/ando_dev \
    "C:/Users/gdy04/anaconda3/envs/ando_route/python.exe" scripts/learning_rows_v_test.py
"""
import os
import sys

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL:
    sys.exit("[중단] DATABASE_URL 환경변수가 없습니다.")
_host = DATABASE_URL.split("@")[-1].split("/")[0].split(":")[0]
if _host not in ("localhost", "127.0.0.1"):
    sys.exit(f"[중단] DATABASE_URL 호스트가 로컬이 아닙니다({_host!r}).")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sqlalchemy import text  # noqa: E402
import database as db_mod  # noqa: E402

PREFIX = "lrv_test_"


def assert_(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(f"FAIL: {msg}")


# 각 케이스: (건 이름, users 오버라이드, sessions 오버라이드, tso 오버라이드, 뷰에 나와야 하나)
CASES = [
    ("정상(학습 보행, 파일럿 참가자, valid, non-facility)",
     {"is_tester": False, "participant_cohort": "coh1"},
     {"phase": "learning"},
     {"valid": True, "facility": False},
     True),
    ("valid=False 제외",
     {"is_tester": False, "participant_cohort": "coh1"},
     {"phase": "learning"},
     {"valid": False, "facility": False},
     False),
    ("valid=NULL 제외(구버전 FE 행, 단정 안 함)",
     {"is_tester": False, "participant_cohort": "coh1"},
     {"phase": "learning"},
     {"valid": None, "facility": False},
     False),
    ("facility=True 제외(계단 등 시설 구간)",
     {"is_tester": False, "participant_cohort": "coh1"},
     {"phase": "learning"},
     {"valid": True, "facility": True},
     False),
    ("is_tester=True 제외(팀 내부 테스트 계정)",
     {"is_tester": True, "participant_cohort": "coh1"},
     {"phase": "learning"},
     {"valid": True, "facility": False},
     False),
    ("participant_cohort=NULL 제외(파일럿 미등록 일반 사용자)",
     {"is_tester": False, "participant_cohort": None},
     {"phase": "learning"},
     {"valid": True, "facility": False},
     False),
    ("phase='comparison' 제외(비교 보행은 학습용 아님)",
     {"is_tester": False, "participant_cohort": "coh1"},
     {"phase": "comparison"},
     {"valid": True, "facility": False},
     False),
    ("phase='free' 제외(일반 이용은 학습용 아님)",
     {"is_tester": False, "participant_cohort": "coh1"},
     {"phase": "free"},
     {"valid": True, "facility": False},
     False),
]


def cleanup(conn):
    conn.execute(text("DELETE FROM trip_slope_observations WHERE uid LIKE :p"), {"p": f"{PREFIX}%"})
    conn.execute(text("DELETE FROM routes WHERE uid LIKE :p"), {"p": f"{PREFIX}%"})
    conn.execute(text("DELETE FROM sessions WHERE uid LIKE :p"), {"p": f"{PREFIX}%"})
    conn.execute(text("DELETE FROM users WHERE uid LIKE :p"), {"p": f"{PREFIX}%"})
    conn.commit()


def run_case(conn, idx: int, name: str, u_over: dict, s_over: dict, o_over: dict, expect: bool):
    uid = f"{PREFIX}{idx}"
    session_id = f"{PREFIX}sess_{idx}"

    conn.execute(text("""
        INSERT INTO users (uid, email, display_name, user_type, is_tester, participant_cohort)
        VALUES (:uid, 'x@test.local', 'test', 'elderly', :is_tester, :participant_cohort)
    """), {"uid": uid, "is_tester": u_over["is_tester"], "participant_cohort": u_over["participant_cohort"]})

    conn.execute(text("""
        INSERT INTO sessions (session_id, uid, user_type, started_at, app_version, schema_ver, phase)
        VALUES (:sid, :uid, 'elderly', NOW(), '1.0.0', 1, :phase)
    """), {"sid": session_id, "uid": uid, "phase": s_over["phase"]})

    row = conn.execute(text("""
        INSERT INTO routes (uid, user_type, mode, origin_name, dest_name, status)
        VALUES (:uid, 'elderly', 'walk', 'A', 'B', 'in_progress')
        RETURNING id
    """), {"uid": uid}).fetchone()
    route_id = row[0]

    conn.execute(text("""
        INSERT INTO trip_slope_observations
            (uid, route_id, session_id, user_type, distance_m, elapsed_ms, gps_sample_n,
             slope_mean, slope_max, valid, facility, slope_source)
        VALUES
            (:uid, :route_id, :sid, 'elderly', 25.0, 20000, 5,
             1.0, 2.0, :valid, :facility, 'dem')
    """), {
        "uid": uid, "route_id": route_id, "sid": session_id,
        "valid": o_over["valid"], "facility": o_over["facility"],
    })
    conn.commit()

    found = conn.execute(text("""
        SELECT 1 FROM learning_rows_v WHERE uid = :uid AND route_id = :route_id
    """), {"uid": uid, "route_id": route_id}).fetchone()

    assert_((found is not None) == expect,
            f"{name}: 기대={expect} 실제={found is not None}")


def main():
    with db_mod.engine.connect() as conn:
        cleanup(conn)
        try:
            for i, (name, u_over, s_over, o_over, expect) in enumerate(CASES):
                run_case(conn, i, name, u_over, s_over, o_over, expect)
                print(f"[{i}] {name} — OK")
        finally:
            cleanup(conn)
            print("(테스트 데이터 정리 완료)")

    print("\nALL OK")


if __name__ == "__main__":
    main()
