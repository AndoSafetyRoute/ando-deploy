"""
개발용 로컬 DB 시드 — 에뮬레이터에서 마이페이지 → 경로 상세 → D 신호 설문(구간 체감
난이도) 화면을 GPS 실측 없이 확인하기 위한 최소 데이터 세트를 로컬 Postgres에 넣는다.

절대 운영 Supabase에 실행하지 말 것 — DATABASE_URL 호스트가 localhost/127.0.0.1이
아니면 즉시 중단한다(안전장치). .env는 건드리지 않는다 — 이 스크립트는 실행 시점의
DATABASE_URL 환경변수만 본다(.env.dev.local 참고).

사용법 (ando_route conda env, backend/ 에서):
  1) 에뮬레이터에서 앱 로그인 1회 → /auth/login이 users 행을 자동 생성.
  2) DATABASE_URL=postgresql://postgres:devpassword@localhost:5433/ando_dev \
     "C:/Users/gdy04/anaconda3/envs/ando_route/python.exe" scripts/dev_seed_local.py

기존 시드 행이 있으면 지우고 다시 넣는다(멱등) — route_id는 실행마다 새로 발급된다.
"""
import os
import sys

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL:
    sys.exit("[중단] DATABASE_URL 환경변수가 없습니다. .env.dev.local 참고해서 먼저 export 하세요.")

_host = DATABASE_URL.split("@")[-1].split("/")[0].split(":")[0]
if _host not in ("localhost", "127.0.0.1"):
    sys.exit(
        f"[중단] DATABASE_URL 호스트가 로컬이 아닙니다({_host!r}) — "
        "운영 Supabase로 보이는 주소라 안전을 위해 시드를 넣지 않습니다."
    )

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
import json
from sqlalchemy import text
import database as db_mod  # noqa: E402  (경로 삽입 후 임포트)

# 서울역 부근, 시드 전용 표시라 실제 지명과 헷갈리지 않게 이름에 "(개발용 시드)" 명시.
BASE_LON, BASE_LAT = 126.9707, 37.5547
M_PER_DEG_LAT = 111_320.0

# (distance_m, slope_pct, status, elapsed_ms)
# 경사 다양(평지/완만/급경사, 오르막/내리막) + measured/skipped 혼합 —
# get_slow_segments()의 meta(total_segments/sloped_segments/ranked) 검증까지 겸한다.
# SLOW_SEG_MAX_RANKED=5 UI(하나씩 넘기는 카드) 검토용으로 느린 축 후보 7개를 넣어
# 랭킹 5개가 꽉 차게 구성 — pace(=elapsed_ms/1000/distance_m) 내림차순으로 5개만
# route_slow_segments에 남는다(백엔드 _rank_and_store_slow_segments 그대로 재사용).
UNITS = [
    (40.0,  0.3, "measured", 36_000),  # 평지 → 느린 축 후보 아님(|slope|<0.5)
    (35.0,  6.0, "measured", 60_000),  # 오르막(가파른) → pace 1.714
    (30.0, -5.0, "skipped",  None),    # 측정 실패(내리막 급경사였을 구간)
    (50.0,  3.0, "measured", 70_000),  # 오르막(완만) → pace 1.400
    (28.0,  7.5, "measured", 56_000),  # 오르막(매우 가파른) → pace 2.000 (1위)
    (45.0,  0.4, "skipped",  None),    # 평지 근처, 측정 실패
    (32.0,  4.0, "measured", 48_000),  # 오르막(뚜렷한) → pace 1.500
    (26.0, -6.5, "measured", 44_000),  # 내리막(가파른) → pace 1.692
    (38.0,  8.0, "measured", 45_000),  # 오르막(매우 가파른, 짧게) → pace 1.184
]


def main():
    db = db_mod.SessionLocal()
    try:
        rows = db.execute(text(
            "SELECT uid, email FROM users ORDER BY created_at LIMIT 5"
        )).fetchall()
        if not rows:
            sys.exit(
                "[중단] users 테이블이 비어 있습니다 — 에뮬레이터에서 먼저 로그인을 "
                "1회 해주세요(로그인 시 /auth/login이 uid를 자동 생성합니다)."
            )
        if len(rows) > 1:
            print(f"[시드] users 여러 행 발견({[r[0] for r in rows]}) — 첫 번째 사용")
        uid = rows[0][0]
        print(f"[시드] 대상 uid = {uid} ({rows[0][1]})")

        coords = [(BASE_LON, BASE_LAT)]
        lat = BASE_LAT
        for dist, _slope, _status, _elapsed in UNITS:
            lat += dist / M_PER_DEG_LAT
            coords.append((BASE_LON, lat))

        measured_units = [u for u in UNITS if u[2] == "measured"]
        total_len = sum(u[0] for u in UNITS)
        measured_len = sum(u[0] for u in measured_units)
        avg_slope = (
            sum(abs(u[1]) * u[0] for u in measured_units) / measured_len
            if measured_len > 0 else 0.0
        )
        # 마이페이지 "총 시간" 통계(get_user_stats)는 routes.total_duration_ms를
        # 그대로 읽는다 — complete_navigation()과 동일하게 measured 구간 elapsed 합.
        total_duration_ms = sum(u[3] for u in measured_units if u[3] is not None)
        route_wkt = "LINESTRING(" + ", ".join(f"{lo} {la}" for lo, la in coords) + ")"

        row = db.execute(text("""
            INSERT INTO routes
                (uid, user_type, algorithm, mode, origin_name, dest_name,
                 origin_geom, dest_geom, route_geom, total_length_m, avg_slope_pct,
                 total_duration_ms, status, created_at)
            VALUES
                (:uid, 'elderly', 'accessibility', 'walk',
                 '서울역 (개발용 시드)', '숭례문 방향 (개발용 시드)',
                 ST_SetSRID(ST_MakePoint(:o_lon, :o_lat), 4326),
                 ST_SetSRID(ST_MakePoint(:d_lon, :d_lat), 4326),
                 ST_GeomFromText(:route_wkt, 4326),
                 :total_len, :avg_slope, :total_duration_ms, 'completed', NOW())
            RETURNING id
        """), {
            "uid": uid,
            "o_lon": coords[0][0], "o_lat": coords[0][1],
            "d_lon": coords[-1][0], "d_lat": coords[-1][1],
            "route_wkt": route_wkt,
            "total_len": total_len, "avg_slope": avg_slope,
            "total_duration_ms": total_duration_ms,
        })
        route_id = row.fetchone()[0]
        print(f"[시드] routes.id = {route_id}")

        session_id = f"dev-seed-{route_id}"
        db.execute(text("""
            INSERT INTO sessions
                (session_id, uid, user_type, started_at, ended_at, end_reason,
                 app_version, schema_ver)
            VALUES
                (:sid, :uid, 'elderly', NOW() - INTERVAL '10 minutes', NOW(),
                 'completed', 'dev-seed', 1)
            ON CONFLICT (session_id) DO NOTHING
        """), {"sid": session_id, "uid": uid})
        print(f"[시드] sessions.session_id = {session_id}")

        measurement_units_json = []
        for i, (dist, slope, status, elapsed) in enumerate(UNITS):
            start_lon, start_lat = coords[i]
            end_lon, end_lat = coords[i + 1]

            db.execute(text("""
                INSERT INTO navigation_measurements
                    (route_id, session_id, unit_index, distance_m, slope_pct,
                     elapsed_ms, status, gps_sample_n, coord_start_idx, coord_end_idx,
                     submitted_at)
                VALUES
                    (:rid, :sid, :ui, :dist, :slope, :elapsed, :status, :gps_n,
                     :cs, :ce, NOW())
            """), {
                "rid": route_id, "sid": session_id, "ui": i,
                "dist": dist, "slope": slope, "elapsed": elapsed, "status": status,
                "gps_n": 15 if status == "measured" else 0,
                "cs": i, "ce": i + 1,
            })

            direction = "flat" if abs(slope) < 0.5 else ("up" if slope > 0 else "down")
            db.execute(text("""
                INSERT INTO navigation_segments
                    (route_id, seg_index, distance_m, slope_pct, elapsed_ms,
                     direction, measured)
                VALUES (:rid, :si, :dist, :slope, :elapsed, :dir, :measured)
            """), {
                "rid": route_id, "si": i, "dist": dist, "slope": slope,
                "elapsed": elapsed if elapsed is not None else 0,
                "dir": direction, "measured": status == "measured",
            })

            measurement_units_json.append({
                "unit_index": i, "distance_m": dist, "slope_pct": slope,
                "coord_start_idx": i, "coord_end_idx": i + 1,
                "start_coords": [start_lon, start_lat],
                "end_coords": [end_lon, end_lat],
            })

        db.commit()
        print(f"[시드] navigation_measurements {len(UNITS)}행 "
              f"(measured={len(measured_units)}, skipped={len(UNITS) - len(measured_units)}), "
              f"navigation_segments {len(UNITS)}행")

        # route_slow_segments — 실서버와 동일한 랭킹 함수를 그대로 재사용(중복 구현 금지).
        ranked = db_mod._rank_and_store_slow_segments(db, route_id)
        db.commit()
        print(f"[시드] route_slow_segments 랭킹 {ranked}건 저장 완료")

        route_segments_json = [
            {
                "start": {"latitude": coords[i][1], "longitude": coords[i][0]},
                "end":   {"latitude": coords[i + 1][1], "longitude": coords[i + 1][0]},
                "slope_pct": UNITS[i][1],
                "length_m":  UNITS[i][0],
            }
            for i in range(len(UNITS))
        ]

        print("\n" + "=" * 70)
        print(f"완료 — route_id={route_id}  session_id={session_id}")
        print("=" * 70)
        print(
            "1) 에뮬레이터 마이페이지를 열면(포커스 시 GET /user/routes 자동 호출) "
            "이 경로가 목록에 나타나고 로컬 저장소에도 동기화됩니다."
        )
        print(
            f"2) 경로 상세: 마이페이지에서 방금 뜬 카드를 탭하면 됩니다 "
            f"(routeId='{route_id}')."
        )
        print(
            "3) D 신호 설문 화면은 '안내 종료' 직후에만 뜨는 화면이라 실제로 걷지 "
            "않고 바로 열려면 앱 안에서 아래 경로로 직접 이동해야 합니다 "
            "(예: 검색창에 딥링크 입력 또는 router 코드로 임시 진입) — "
            "GET/POST API는 전부 실제 호출입니다:"
        )
        print(f"   /slow-segment-feedback?serverRouteId={route_id}&nextRouteId={route_id}"
              f"&sessionId={session_id}&routeSegments=<url-encoded JSON>&measurementUnits=<url-encoded JSON>")
        print("\nrouteSegments 파라미터용 JSON:")
        print(json.dumps(route_segments_json, ensure_ascii=False))
        print("\nmeasurementUnits 파라미터용 JSON:")
        print(json.dumps(measurement_units_json, ensure_ascii=False))
        print("=" * 70)

    finally:
        db.close()


if __name__ == "__main__":
    main()
