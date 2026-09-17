"""
S0(GPS 수신 간격 개선) 검증 — gps_traces.t_ms 차이로 콜백 간격 분포를 낸다.

읽기 전용. 절대 운영 Supabase를 보지 않는다 — DATABASE_URL 호스트가
localhost/127.0.0.1이 아니면 즉시 중단한다(dev_seed_local.py와 동일한 안전장치).
.env는 건드리지 않는다 — 실행 시점의 DATABASE_URL 환경변수만 본다
(.env.dev.local 참고).

사용법 (ando_route conda env, backend/ 에서):
  DATABASE_URL=postgresql://postgres:devpassword@localhost:5433/ando_dev \
    "C:/Users/gdy04/anaconda3/envs/ando_route/python.exe" scripts/gps_interval_report.py \
    [--session SESSION_ID] [--since-hours N]

인자 없이 실행하면 최근 --since-hours(기본 24) 이내에 gps_traces 행이 있는
모든 세션을 훑어 세션별 + 전체 콜백 간격(중앙값·p75·p95·최대)을 출력한다.
"""
import argparse
import os
import statistics
import sys

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL:
    sys.exit("[중단] DATABASE_URL 환경변수가 없습니다. .env.dev.local 참고해서 먼저 export 하세요.")

_host = DATABASE_URL.split("@")[-1].split("/")[0].split(":")[0]
if _host not in ("localhost", "127.0.0.1"):
    sys.exit(
        f"[중단] DATABASE_URL 호스트가 로컬이 아닙니다({_host!r}) — "
        "운영 Supabase로 보이는 주소라 안전을 위해 조회하지 않습니다."
    )

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
from sqlalchemy import text  # noqa: E402
import database as db_mod  # noqa: E402  (경로 삽입 후 임포트 — DATABASE_URL로 engine 생성됨)


def _percentile(sorted_vals: list[float], p: float) -> float:
    """선형보간 백분위수. sorted_vals는 이미 정렬돼 있어야 한다."""
    if not sorted_vals:
        return float("nan")
    k = (len(sorted_vals) - 1) * p
    f, c = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def report(session_id: str | None, since_hours: int) -> None:
    if db_mod.engine is None:
        sys.exit("[중단] DB 연결 실패 — 위 [DB] 로그를 확인하세요(로컬 Postgres가 떠 있는지).")

    with db_mod.engine.connect() as conn:
        if session_id:
            session_ids = [session_id]
        else:
            rows = conn.execute(text("""
                SELECT DISTINCT session_id FROM gps_traces
                WHERE session_id IN (
                    SELECT session_id FROM sessions
                    WHERE started_at >= NOW() - (:hrs || ' hours')::interval
                )
            """), {"hrs": since_hours}).fetchall()
            session_ids = [r[0] for r in rows]

        if not session_ids:
            print(f"[결과 없음] 최근 {since_hours}시간 내 gps_traces가 있는 세션이 없습니다.")
            print("(로컬 dev DB에는 실기기 파일럿 데이터가 없을 수 있습니다 — 실제 도보 테스트 후 재실행하세요.)")
            return

        all_gaps: list[float] = []
        print(f"{'session_id':<40} {'n':>5} {'중앙값(s)':>10} {'p75(s)':>8} {'p95(s)':>8} {'최대(s)':>8}")
        for sid in session_ids:
            rows = conn.execute(text("""
                SELECT t_ms FROM gps_traces
                WHERE session_id = :sid
                ORDER BY seq ASC
            """), {"sid": sid}).fetchall()
            t_vals = [int(r[0]) for r in rows]
            if len(t_vals) < 2:
                continue
            gaps = sorted((t_vals[i + 1] - t_vals[i]) / 1000.0 for i in range(len(t_vals) - 1))
            all_gaps.extend(gaps)
            print(
                f"{sid:<40} {len(gaps):>5} "
                f"{statistics.median(gaps):>10.2f} {_percentile(gaps, 0.75):>8.2f} "
                f"{_percentile(gaps, 0.95):>8.2f} {max(gaps):>8.2f}"
            )

        if all_gaps:
            all_gaps.sort()
            print("-" * 90)
            print(
                f"{'전체':<40} {len(all_gaps):>5} "
                f"{statistics.median(all_gaps):>10.2f} {_percentile(all_gaps, 0.75):>8.2f} "
                f"{_percentile(all_gaps, 0.95):>8.2f} {max(all_gaps):>8.2f}"
            )
        else:
            print("[결과 없음] 세션은 있으나 gps_traces 행이 2개 미만이라 간격을 계산할 세션이 없습니다.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", default=None, help="특정 session_id만 조회")
    parser.add_argument("--since-hours", type=int, default=24, help="최근 N시간 내 세션만 (기본 24)")
    args = parser.parse_args()
    report(args.session, args.since_hours)
