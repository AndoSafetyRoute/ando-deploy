"""
S5 회귀 테스트 — "가장 힘들었던 구간" 저장/조회, upsert, 유효성 검증.

로컬 dev Postgres 필요(안전장치는 slow_segments_v2_test.py와 동일).
실행: DATABASE_URL=postgresql://postgres:devpassword@localhost:5433/ando_dev \
  "C:/Users/gdy04/anaconda3/envs/ando_route/python.exe" scripts/segment_hardest_pick_test.py
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

TEST_UID = "hardest_pick_test_uid"


def assert_(cond, msg):
    if not cond:
        raise AssertionError(f"FAIL: {msg}")


def main():
    with db_mod.engine.connect() as conn:
        conn.execute(text("""
            INSERT INTO users (uid, email, display_name, user_type)
            VALUES (:u, 'x@test.local', 'test', 'elderly')
            ON CONFLICT (uid) DO NOTHING
        """), {"u": TEST_UID})
        route_id = conn.execute(text("""
            INSERT INTO routes (uid, user_type, mode, origin_name, dest_name, status)
            VALUES (:u, 'elderly', 'walk', 'A', 'B', 'completed')
            RETURNING id
        """), {"u": TEST_UID}).fetchone()[0]
        conn.commit()

        try:
            # 정상 선택
            r = db_mod.save_segment_hardest_pick(
                conn, route_id=route_id, uid=TEST_UID, session_id="s1",
                shown_seg_indices=[0, 3, 5, 7, 8, 2, 6], picked_seg_index=5, picked_none=False,
            )
            assert_(r == {"ok": True}, f"저장 실패: {r}")
            got = db_mod.get_segment_hardest_pick(conn, route_id, TEST_UID)
            assert_(got["picked_seg_index"] == 5 and got["picked_none"] is False, f"조회 결과 다름: {got}")
            assert_(got["shown_seg_indices"] == [0, 3, 5, 7, 8, 2, 6], f"shown_seg_indices 순서/값 다름: {got}")
            print("[0] 정상 선택 저장/조회 확인")

            # upsert — 같은 route_id 재제출 시 덮어씀("비슷했어요"로 변경)
            r2 = db_mod.save_segment_hardest_pick(
                conn, route_id=route_id, uid=TEST_UID, session_id="s1",
                shown_seg_indices=[0, 3, 5, 7, 8, 2, 6], picked_seg_index=None, picked_none=True,
            )
            assert_(r2 == {"ok": True}, f"upsert 실패: {r2}")
            got2 = db_mod.get_segment_hardest_pick(conn, route_id, TEST_UID)
            assert_(got2["picked_none"] is True and got2["picked_seg_index"] is None, f"upsert 결과 다름: {got2}")
            print("[1] upsert(비슷했어요로 재제출) 반영 확인")

            # 소유자 아닌 uid로 조회 → None
            none_owner = db_mod.get_segment_hardest_pick(conn, route_id, "other_uid")
            assert_(none_owner is None, "소유자 아닌데 조회됨")
            print("[2] 소유자 검증(다른 uid 조회 시 None) 확인")

            # 불일치 조합 — ValueError
            try:
                db_mod.save_segment_hardest_pick(
                    conn, route_id=route_id, uid=TEST_UID, session_id="s1",
                    shown_seg_indices=[0, 1], picked_seg_index=1, picked_none=True,
                )
                raise AssertionError("FAIL: picked_none=True + picked_seg_index 조합이 통과함")
            except ValueError:
                print("[3] picked_none=True + picked_seg_index 동시 지정 시 ValueError 확인")

            try:
                db_mod.save_segment_hardest_pick(
                    conn, route_id=route_id, uid=TEST_UID, session_id="s1",
                    shown_seg_indices=[0, 1], picked_seg_index=None, picked_none=False,
                )
                raise AssertionError("FAIL: picked_none=False + picked_seg_index=None 조합이 통과함")
            except ValueError:
                print("[4] picked_none=False + picked_seg_index=None 조합 시 ValueError 확인")

            print("\nALL OK")
        finally:
            conn.execute(text("DELETE FROM segment_hardest_pick WHERE route_id = :r"), {"r": route_id})
            conn.execute(text("DELETE FROM routes WHERE id = :r"), {"r": route_id})
            conn.execute(text("DELETE FROM users WHERE uid = :u"), {"u": TEST_UID})
            conn.commit()
            print("(테스트 데이터 정리 완료)")


if __name__ == "__main__":
    main()
