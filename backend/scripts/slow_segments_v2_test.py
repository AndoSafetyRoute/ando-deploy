"""
S4 회귀 테스트 — 순위 5 + 무작위 대조 2, valid/facility 필터, seed 재현성.

로컬 dev Postgres 필요(DATABASE_URL이 localhost 아니면 중단 — dev_seed_local.py와
동일한 안전장치). 실행 후 만든 테스트 행은 스크립트가 직접 정리한다.

사용법 (ando_route conda env, backend/ 에서):
  DATABASE_URL=postgresql://postgres:devpassword@localhost:5433/ando_dev \
    "C:/Users/gdy04/anaconda3/envs/ando_route/python.exe" scripts/slow_segments_v2_test.py
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

TEST_UID = "slow_seg_v2_test_uid"
TEST_SESSION = "slow_seg_v2_test_session"


def cleanup(conn, route_id):
    conn.execute(text("DELETE FROM route_slow_segments WHERE route_id = :r"), {"r": route_id})
    conn.execute(text("DELETE FROM navigation_measurements WHERE route_id = :r"), {"r": route_id})
    conn.execute(text("DELETE FROM routes WHERE id = :r"), {"r": route_id})
    conn.execute(text("DELETE FROM sessions WHERE session_id = :s"), {"s": TEST_SESSION})
    conn.execute(text("DELETE FROM users WHERE uid = :u"), {"u": TEST_UID})
    conn.commit()


def setup(conn) -> int:
    conn.execute(text("""
        INSERT INTO users (uid, email, display_name, user_type)
        VALUES (:u, 'x@test.local', 'test', 'elderly')
        ON CONFLICT (uid) DO NOTHING
    """), {"u": TEST_UID})
    conn.execute(text("""
        INSERT INTO sessions (session_id, uid, user_type, started_at, app_version, schema_ver)
        VALUES (:s, :u, 'elderly', NOW(), '1.0.0', 1)
        ON CONFLICT (session_id) DO NOTHING
    """), {"s": TEST_SESSION, "u": TEST_UID})
    row = conn.execute(text("""
        INSERT INTO routes (uid, user_type, mode, origin_name, dest_name, status)
        VALUES (:u, 'elderly', 'walk', 'A', 'B', 'in_progress')
        RETURNING id
    """), {"u": TEST_UID}).fetchone()
    route_id = row[0]

    # 10개 유효 unit(pace 다양, 전부 SLOW_SEG_SPEED_MIN~MAX(0.05~2.5 m/s) 범위 안) +
    # 계단(facility) 1개 + invalid 1개. distance=40m 고정, moving_ms만 등차 감소
    # (30000~21000 → speed 1.33~1.90 m/s, 전부 유효 범위 안).
    units = []
    for i in range(10):
        moving_ms = 30_000 - i * 1_000  # 30000,29000,...,21000
        units.append(dict(idx=i, distance=40.0, elapsed=moving_ms, moving=moving_ms,
                           valid=True, facility=False, slope=1.0))
    units.append(dict(idx=10, distance=40.0, elapsed=50_000, moving=50_000,
                       valid=True, facility=True, slope=1.0))   # 계단 — pace 최상위였을 값이지만 제외돼야 함
    units.append(dict(idx=11, distance=40.0, elapsed=45_000, moving=45_000,
                       valid=False, facility=False, slope=1.0))  # invalid — 제외돼야 함

    for u in units:
        conn.execute(text("""
            INSERT INTO navigation_measurements
                (route_id, session_id, unit_index, distance_m, slope_pct, elapsed_ms, status,
                 valid, dwell_ms, moving_ms, facility, stop_class)
            VALUES
                (:rid, :sid, :idx, :dist, :slope, :elapsed, 'measured',
                 :valid, 0, :moving, :facility, 'moving')
        """), {
            "rid": route_id, "sid": TEST_SESSION, "idx": u["idx"], "dist": u["distance"],
            "slope": u["slope"], "elapsed": u["elapsed"], "valid": u["valid"],
            "moving": u["moving"], "facility": u["facility"],
        })
    conn.commit()
    return route_id


def main():
    with db_mod.engine.connect() as conn:
        route_id = setup(conn)
        try:
            n = db_mod._rank_and_store_slow_segments(conn, route_id, seed=42)
            conn.commit()
            assert n == 7, f"FAIL: 5+2=7건이어야 하는데 {n}건"
            print(f"[0] 총 {n}건 선정(순위5+대조2) 확인")

            rows = conn.execute(text("""
                SELECT rank, seg_index, asked_by, question_order, rank_position, seed
                FROM route_slow_segments WHERE route_id = :r ORDER BY rank
            """), {"r": route_id}).fetchall()

            ranked_rows = [r for r in rows if r[2] == "rank"]
            random_rows = [r for r in rows if r[2] == "random"]
            assert len(ranked_rows) == 5, f"FAIL: 순위 5건이어야: {len(ranked_rows)}"
            assert len(random_rows) == 2, f"FAIL: 대조 2건이어야: {len(random_rows)}"
            print(f"[1] asked_by 분리 확인: rank={len(ranked_rows)} random={len(random_rows)}")

            # 순위는 pace 내림차순 → unit_index 0(pace=1.0)이 1위여야 함
            ranked_seg_idx = [r[1] for r in ranked_rows]
            assert ranked_seg_idx == [0, 1, 2, 3, 4], f"FAIL: 순위 top5가 예상과 다름: {ranked_seg_idx}"
            print(f"[2] pace 내림차순 top5 정확: {ranked_seg_idx}")

            # 계단(unit 10, invalid 아니지만 facility=True, pace 최상위)과 invalid(unit 11)는 어디에도 없어야 함
            all_seg_idx = {r[1] for r in rows}
            assert 10 not in all_seg_idx, "FAIL: facility=True unit이 선정됨"
            assert 11 not in all_seg_idx, "FAIL: valid=False unit이 선정됨"
            print("[3] facility=True/valid=False unit 배제 확인")

            # rank_position: 순위는 1~5, 대조는 NULL
            for r in ranked_rows:
                assert r[4] is not None, f"FAIL: 순위 문항인데 rank_position NULL: {r}"
            for r in random_rows:
                assert r[4] is None, f"FAIL: 대조 문항인데 rank_position 있음: {r}"
            print("[4] rank_position: 순위=값 있음, 대조=NULL 확인")

            # question_order가 1..7의 순열인지(중복/누락 없음)
            orders = sorted(r[3] for r in rows)
            assert orders == list(range(1, 8)), f"FAIL: question_order가 1~7 순열이 아님: {orders}"
            print(f"[5] question_order 1~7 순열 확인: {sorted([(r[3], r[2]) for r in rows])}")

            # seed 재현성 — 같은 seed로 다시 돌리면 같은 결과(같은 컬럼 목록으로 비교)
            key1 = [(r[0], r[1], r[2], r[3], r[4]) for r in rows]
            n2 = db_mod._rank_and_store_slow_segments(conn, route_id, seed=42)
            conn.commit()
            rows2 = conn.execute(text("""
                SELECT rank, seg_index, asked_by, question_order, rank_position
                FROM route_slow_segments WHERE route_id = :r ORDER BY rank
            """), {"r": route_id}).fetchall()
            key2 = [(r[0], r[1], r[2], r[3], r[4]) for r in rows2]
            assert key1 == key2, f"FAIL: 같은 seed인데 결과가 다름(재현성 깨짐): {key1} vs {key2}"
            print("[6] 같은 seed로 재실행 시 완전히 동일한 결과(재현성) 확인")

            print("\nALL OK")
        finally:
            cleanup(conn, route_id)
            print("(테스트 데이터 정리 완료)")


def test_insufficient_eligible_units():
    """유효 단위가 7개(5+2) 미만인 짧은 경로 — 순위 우선으로 채우고 부족분은
    비워 둔다(하한 아님). S4 스펙 명시 케이스."""
    with db_mod.engine.connect() as conn:
        conn.execute(text("""
            INSERT INTO users (uid, email, display_name, user_type)
            VALUES (:u, 'x@test.local', 'test', 'elderly')
            ON CONFLICT (uid) DO NOTHING
        """), {"u": TEST_UID})
        conn.execute(text("""
            INSERT INTO sessions (session_id, uid, user_type, started_at, app_version, schema_ver)
            VALUES (:s, :u, 'elderly', NOW(), '1.0.0', 1)
            ON CONFLICT (session_id) DO NOTHING
        """), {"s": TEST_SESSION, "u": TEST_UID})
        route_id = conn.execute(text("""
            INSERT INTO routes (uid, user_type, mode, origin_name, dest_name, status)
            VALUES (:u, 'elderly', 'walk', 'A', 'B', 'in_progress')
            RETURNING id
        """), {"u": TEST_UID}).fetchone()[0]

        # 유효 unit 3개뿐인 짧은 경로.
        for i in range(3):
            conn.execute(text("""
                INSERT INTO navigation_measurements
                    (route_id, session_id, unit_index, distance_m, slope_pct, elapsed_ms, status,
                     valid, dwell_ms, moving_ms, facility, stop_class)
                VALUES
                    (:rid, :sid, :idx, 40.0, 1.0, :moving, 'measured', true, 0, :moving, false, 'moving')
            """), {"rid": route_id, "sid": TEST_SESSION, "idx": i, "moving": 25000 - i * 1000})
        conn.commit()

        try:
            n = db_mod._rank_and_store_slow_segments(conn, route_id, seed=7)
            conn.commit()
            assert n == 3, f"FAIL: 유효 3개뿐인데 {n}건 선정(하한 아니어야 함)"
            rows = conn.execute(text("""
                SELECT asked_by, rank_position FROM route_slow_segments
                WHERE route_id = :r ORDER BY rank
            """), {"r": route_id}).fetchall()
            assert all(r[0] == "rank" for r in rows), f"FAIL: 부족분을 임의로 대조 처리함: {rows}"
            assert [r[1] for r in rows] == [1, 2, 3], f"FAIL: rank_position 예상과 다름: {rows}"
            print("[7] 유효 단위 3개뿐(7개 미만) → 순위 3개만 채워짐, 대조 0개(부족분 억지로 안 채움)")
        finally:
            cleanup(conn, route_id)
            print("(테스트 데이터 정리 완료)")


if __name__ == "__main__":
    main()
    test_insufficient_eligible_units()
