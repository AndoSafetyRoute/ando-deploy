import json
import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session
from routing.speed import (
    validate_observation, ema_update, get_default_speed, get_zone_key, ZONE_KEYS,
)
from routing.cost import classify_zone
from config import FLAT_THRESHOLD, CALIBRATION_FLAT_M

DATABASE_URL = os.environ.get("DATABASE_URL", "")

if DATABASE_URL:
    engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_recycle=300)
    # 연결 가능 여부 즉시 확인
    try:
        with engine.connect() as _c:
            _c.execute(text("SELECT 1"))
        # URL에서 비밀번호 숨기고 호스트만 출력
        _host = DATABASE_URL.split("@")[-1].split("/")[0] if "@" in DATABASE_URL else DATABASE_URL
        print(f"[DB] Supabase PostgreSQL 연결 성공 → {_host}")
    except Exception as _e:
        print(f"[DB] PostgreSQL 연결 실패: {_e}")
else:
    engine = None

SessionLocal = sessionmaker(bind=engine) if engine else None


def get_db() -> Session:
    # DATABASE_URL 미설정이면 SessionLocal 자체가 None 이라 SessionLocal() 호출이
    # "TypeError: 'NoneType' object is not callable" 로 죽으면서 원인을 알 수 없는
    # 500 이 났었다(로그인 등 DB 의존 엔드포인트 전부). 여기서 먼저 걸러 명확한
    # 503 으로 바꾼다 — 실서버는 DATABASE_URL 이 설정돼 있어 평소엔 영향 없음.
    if not SessionLocal:
        from fastapi import HTTPException
        raise HTTPException(503, "DB 미설정 (DATABASE_URL 환경변수 확인 필요)")
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """PostGIS 확장 활성화 + 테이블 생성 (최초 1회)"""
    if not engine:
        print("[DB] DATABASE_URL 미설정 — DB 기능 비활성화")
        return

    with engine.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS users (
                uid           TEXT PRIMARY KEY,
                email         TEXT,
                display_name  TEXT,
                photo_url     TEXT,
                user_type     TEXT DEFAULT 'elderly',
                created_at    TIMESTAMPTZ DEFAULT NOW(),
                last_login_at TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        # 기존 테이블에 컬럼이 없을 경우 추가 (이미 DB가 있는 환경 대응)
        for col, definition in [
            ("display_name",  "TEXT"),
            ("photo_url",     "TEXT"),
            ("last_login_at", "TIMESTAMPTZ DEFAULT NOW()"),
        ]:
            conn.execute(text(
                f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {col} {definition}"
            ))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS routes (
                id             SERIAL PRIMARY KEY,
                uid            TEXT REFERENCES users(uid) ON DELETE SET NULL,
                created_at     TIMESTAMPTZ DEFAULT NOW(),
                user_type      TEXT,
                algorithm      TEXT,
                mode           TEXT,
                origin_name    TEXT,
                dest_name      TEXT,
                origin_geom    GEOMETRY(Point, 4326),
                dest_geom      GEOMETRY(Point, 4326),
                total_length_m FLOAT,
                avg_slope_pct  FLOAT,
                route_geom     GEOMETRY(LineString, 4326),
                status         TEXT NOT NULL DEFAULT 'in_progress'
            )
        """))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS gps_tracks (
                id          SERIAL PRIMARY KEY,
                route_id    INT REFERENCES routes(id) ON DELETE CASCADE,
                uid         TEXT,
                recorded_at TIMESTAMPTZ,
                track_geom  GEOMETRY(LineString, 4326),
                avg_speed   FLOAT
            )
        """))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS feedback (
                id         SERIAL PRIMARY KEY,
                route_id   INT REFERENCES routes(id) ON DELETE CASCADE,
                uid        TEXT,
                rating     SMALLINT CHECK (rating BETWEEN 1 AND 5),
                comment    TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """))

        # 마이페이지 연동용 컬럼 추가 (기존 DB 호환)
        for col, definition in [
            ("walker_type",       "TEXT"),
            ("total_duration_ms", "BIGINT"),
            ("status",            "TEXT DEFAULT 'completed'"),
        ]:
            conn.execute(text(
                f"ALTER TABLE routes ADD COLUMN IF NOT EXISTS {col} {definition}"
            ))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS navigation_segments (
                id          SERIAL PRIMARY KEY,
                route_id    INT REFERENCES routes(id) ON DELETE CASCADE,
                seg_index   INT,
                distance_m  FLOAT,
                slope_pct   FLOAT,
                elapsed_ms  BIGINT,
                direction   TEXT,
                zone        TEXT,
                name        TEXT,
                measured    BOOLEAN NOT NULL DEFAULT FALSE
            )
        """))

        # 기존 navigation_segments 테이블에 컬럼 추가 (이미 생성된 DB 호환)
        for col, definition in [
            ("elapsed_ms", "BIGINT"),
            ("direction",  "TEXT"),
            ("zone",       "TEXT"),
            ("name",       "TEXT"),
            ("measured",   "BOOLEAN DEFAULT FALSE"),
        ]:
            conn.execute(text(
                f"ALTER TABLE navigation_segments ADD COLUMN IF NOT EXISTS {col} {definition}"
            ))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS bookmarks (
                id         SERIAL PRIMARY KEY,
                uid        TEXT REFERENCES users(uid) ON DELETE CASCADE,
                place_id   TEXT NOT NULL,
                name       TEXT NOT NULL,
                address    TEXT,
                latitude   FLOAT,
                longitude  FLOAT,
                category   TEXT,
                phone      TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(uid, place_id)
            )
        """))

        # ── 검색기록 ─────────────────────────────────────────────────────────
        # 출발지/도착지 구분 없이 "이 장소를 검색해서 선택했다"만 기록한다.
        # 같은 장소를 다시 검색하면 새 행을 쌓지 않고 searched_at만 갱신해서
        # (UPSERT) 목록 맨 위로 올라오게 한다 — bookmarks와 같은 UNIQUE 패턴.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS search_history (
                id          SERIAL PRIMARY KEY,
                uid         TEXT REFERENCES users(uid) ON DELETE CASCADE,
                place_id    TEXT NOT NULL,
                name        TEXT NOT NULL,
                address     TEXT,
                latitude    FLOAT,
                longitude   FLOAT,
                category    TEXT,
                phone       TEXT,
                searched_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(uid, place_id)
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_search_history_uid
            ON search_history (uid, searched_at DESC)
        """))

        # ── NOT NULL 제약 추가 (이미 적용돼 있으면 no-op) ──────────────────────
        for stmt in [
            "ALTER TABLE navigation_segments ALTER COLUMN elapsed_ms SET NOT NULL",
            "ALTER TABLE navigation_segments ALTER COLUMN distance_m  SET NOT NULL",
            "ALTER TABLE navigation_segments ALTER COLUMN slope_pct   SET NOT NULL",
            "ALTER TABLE navigation_segments ALTER COLUMN measured    SET NOT NULL",
            "ALTER TABLE routes              ALTER COLUMN status      SET NOT NULL",
        ]:
            conn.execute(text(stmt))

        # ── CHECK / FK 제약 추가 (이미 있으면 무시) ─────────────────────────
        _user_type_vals = "'manual_wheelchair','electric_wheelchair','walker','cane','leg_injury','elderly'"
        for tbl, name, definition in [
            ("routes",              "chk_status",     "CHECK (status IN ('in_progress','completed','abandoned'))"),
            ("routes",              "chk_route_mode", "CHECK (mode IN ('walk','transit','car','accessibility'))"),
            ("users",               "chk_user_type",  f"CHECK (user_type IS NULL OR user_type IN ({_user_type_vals}))"),
            ("navigation_segments", "chk_zone",       "CHECK (zone IS NULL OR zone IN ('flat','optimal','warning','forbidden'))"),
            ("navigation_segments", "chk_direction",  "CHECK (direction IS NULL OR direction IN ('flat','up','down'))"),
            ("feedback",            "fk_feedback_uid","FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE"),
        ]:
            conn.execute(text(f"""
                DO $$ BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = '{name}' AND conrelid = '{tbl}'::regclass
                    ) THEN
                        ALTER TABLE {tbl} ADD CONSTRAINT {name} {definition};
                    END IF;
                END $$
            """))

        # ── 부분 인덱스 ───────────────────────────────────────────────────────
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_nav_seg_measured_true
            ON navigation_segments (route_id)
            WHERE measured = TRUE
        """))

        # ── zone 통과 관측값 (zone_key, distance, elapsed 1행/zone crossing) ──
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS trip_zone_observations (
                id            SERIAL PRIMARY KEY,
                route_id      INT REFERENCES routes(id) ON DELETE CASCADE,
                uid           TEXT NOT NULL,
                user_type     TEXT NOT NULL,
                zone_key      TEXT NOT NULL,
                slope_pct_avg FLOAT NOT NULL DEFAULT 0.0,
                distance_m    FLOAT NOT NULL,
                elapsed_ms    INT NOT NULL,
                gps_sample_n  INT NOT NULL DEFAULT 0,
                observed_at   TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_zone_obs_uid
            ON trip_zone_observations (uid, zone_key)
        """))

        # ── 유저별 zone 속도 프로파일 (EMA 결과 저장) ─────────────────────────
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS user_speed_profile (
                uid          TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                zone_key     TEXT NOT NULL,
                speed_ms     FLOAT NOT NULL,
                sample_count INT NOT NULL DEFAULT 0,
                cumulative_distance_m FLOAT NOT NULL DEFAULT 0,
                updated_at   TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (uid, zone_key)
            )
        """))
        # 기존 배포에 이미 테이블이 있으면 컬럼만 추가 (캘리브레이션 게이트용, 문서 3.9절)
        conn.execute(text(
            "ALTER TABLE user_speed_profile "
            "ADD COLUMN IF NOT EXISTS cumulative_distance_m FLOAT NOT NULL DEFAULT 0"
        ))

        # ── 개인 맞춤 경로 추천 (ando_dev_final.md 3.7절) ──────────────────────
        # 신호 A: 경사 bin별 통과 관측
        # user_type: 관측이 일어난 세션의 유형을 박아 둔다(배치 처리 시점의 users.user_type
        # 복사). 파일럿 중 사용자가 유형을 바꿔도 과거 관측의 귀속이 깨지지 않게 —
        # 학습은 users.user_type(현재값)이 아니라 이 컬럼으로 그룹핑한다.
        # (docs/personalization-data-collection-plan.md §1.2)
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS trip_slope_observations (
                id             SERIAL PRIMARY KEY,
                uid            TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                route_id       INT  REFERENCES routes(id) ON DELETE CASCADE,
                session_id     TEXT NOT NULL,
                user_type      TEXT,
                slope_bin      FLOAT NOT NULL,
                distance_m     FLOAT NOT NULL,
                elapsed_ms     INT   NOT NULL,
                stop_ms        INT   NOT NULL DEFAULT 0,
                gps_sample_n   INT   NOT NULL,
                observed_at    TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        # 기존 배포에 테이블이 이미 있으면 컬럼만 추가 (§1.2)
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS user_type TEXT"
        ))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_tso_uid_bin
            ON trip_slope_observations (uid, slope_bin)
        """))

        # 신호 B: 순간속도 원본 (판정값 저장 금지 — 3.8절 원칙 1)
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS speed_samples (
                id             SERIAL PRIMARY KEY,
                uid            TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                route_id       INT  REFERENCES routes(id) ON DELETE CASCADE,
                session_id     TEXT NOT NULL,
                slope_bin      FLOAT NOT NULL,
                sub_distance_m FLOAT NOT NULL,
                speed_ms       FLOAT NOT NULL,
                observed_at    TIMESTAMPTZ DEFAULT NOW()
            )
        """))

        # 신호 C: 경로 선택 (후보 개수 가변 1~3)
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS route_choice_log (
                id             SERIAL PRIMARY KEY,
                uid            TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                session_id     TEXT NOT NULL,
                candidates     JSONB NOT NULL,
                n_shown        SMALLINT NOT NULL,
                chosen_kind    TEXT,
                decided_at     TIMESTAMPTZ DEFAULT NOW()
            )
        """))

        # 신호 D: 구간 주관 평가
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS segment_feedback (
                id             SERIAL PRIMARY KEY,
                uid            TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                route_id       INT  REFERENCES routes(id) ON DELETE CASCADE,
                slope_mean     FLOAT NOT NULL,
                length_m       FLOAT NOT NULL,
                verdict        SMALLINT NOT NULL,
                created_at     TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        # verdict 는 -1(불편)/0(보통)/+1(편함) 만 허용 — FE 신뢰에만 의존하지 않도록
        # DB 레벨에서 못박는다 (docs/personalization-data-collection-plan.md, 이슈 #6).
        conn.execute(text("""
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_verdict' AND conrelid = 'segment_feedback'::regclass
                ) THEN
                    ALTER TABLE segment_feedback
                        ADD CONSTRAINT chk_verdict CHECK (verdict IN (-1, 0, 1));
                END IF;
            END $$
        """))

        # session_route_profile — route_id 가 NULL 인(=/navigation/start 실패) 세션도
        # "어떤 경로였나"를 잃지 않도록, FE 가 세션 첫 배치에 실어 보내는 경로 형상을
        # (uid, session_id) 로 UPSERT 저장한다. route_id 가 있어도 교차 검증용으로 함께
        # 저장한다. (docs/personalization-data-collection-plan.md §1.3)
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS session_route_profile (
                uid            TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                session_id     TEXT NOT NULL,
                route_id       INT  REFERENCES routes(id) ON DELETE SET NULL,
                user_type      TEXT,
                total_length_m FLOAT,
                segments       JSONB NOT NULL,
                coordinates    JSONB,
                captured_at    TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (uid, session_id)
            )
        """))

        # 경사도 측정 검증
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS slope_validation (
                id             SERIAL PRIMARY KEY,
                lat            FLOAT NOT NULL,
                lon            FLOAT NOT NULL,
                dem_slope_pct  FLOAT NOT NULL,
                measured_pct   FLOAT NOT NULL,
                note           TEXT,
                measured_at    TIMESTAMPTZ DEFAULT NOW()
            )
        """))

        # 학습 결과 (배치가 쓰고, 요청 경로는 읽기만)
        # v_flat_used: 이 학습 실행이 신호 A·B 정규화에 고정해 쓴 v̄_flat 값.
        # 곡선의 재현성을 위해 반드시 함께 기록한다 (§1.1 정책 2·3).
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS user_slope_curve (
                uid          TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
                theta        JSONB NOT NULL,
                cost_grid    JSONB NOT NULL,
                beta_gamma   FLOAT NOT NULL,
                v_flat_used  FLOAT,
                valid_min    FLOAT NOT NULL,
                valid_max    FLOAT NOT NULL,
                n_sessions   INT   NOT NULL,
                model_ver    TEXT  NOT NULL,
                fitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        conn.execute(text(
            "ALTER TABLE user_slope_curve ADD COLUMN IF NOT EXISTS v_flat_used FLOAT"
        ))

        # 공유 파라미터 (전원 공통, 단일 행)
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS model_params (
                id           SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                b_slowdown   FLOAT NOT NULL DEFAULT 0.5,
                s_subjective FLOAT NOT NULL DEFAULT 0.5,
                lambda2      FLOAT NOT NULL DEFAULT 100.0,
                updated_at   TIMESTAMPTZ DEFAULT NOW()
            )
        """))

        conn.execute(text(
            "ALTER TABLE routes ADD COLUMN IF NOT EXISTS route_kind TEXT"
        ))

        # /collect/batch 멱등 처리용 — (uid, session_id, seq) 중복 배치 무시
        # (문서 3.9절 "멱등: session_id + seq로 중복 무시" 요구사항 구현)
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS collect_batch_log (
                uid         TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                session_id  TEXT NOT NULL,
                seq         INT  NOT NULL,
                received_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (uid, session_id, seq)
            )
        """))

        # ── 구간 체감 난이도 평가 (⑭' — pace = 1m당 소요시간 기준) ─────────────
        # navigation_segments 에 "1m당 소요시간" 파생 컬럼. insert 시 자동 계산되며
        # 분석·랭킹의 공통 정규화 단위다("소요시간 구간 단위 1m로 통일" 요구).
        conn.execute(text("""
            ALTER TABLE navigation_segments
            ADD COLUMN IF NOT EXISTS pace_s_per_m DOUBLE PRECISION
            GENERATED ALWAYS AS (
                (elapsed_ms::float / 1000.0) / NULLIF(distance_m, 0)
            ) STORED
        """))

        # complete_navigation 이 종료 시점에 미리 계산해 두는 pace 상위 구간 캐시.
        # 안내가 끝나자마자 FE 가 곧바로 조회하도록 백엔드에서 선계산 (사용자 요구:
        # "안내가 끝난 뒤 상위 10개 구간을 최대한 빨리 표출").
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS route_slow_segments (
                route_id      INT  NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
                rank          SMALLINT NOT NULL,
                seg_index     INT   NOT NULL,   -- 묶은 구간의 첫 엣지 인덱스
                seg_index_end INT,              -- 묶은 구간의 끝 엣지 인덱스 (FE 지도 하이라이트 범위)
                distance_m    FLOAT NOT NULL,
                slope_pct     FLOAT NOT NULL,
                direction     TEXT,
                zone          TEXT,
                name          TEXT,
                elapsed_ms    BIGINT NOT NULL,
                pace_s_per_m  FLOAT NOT NULL,
                computed_at   TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (route_id, rank)
            )
        """))
        conn.execute(text(
            "ALTER TABLE route_slow_segments ADD COLUMN IF NOT EXISTS seg_index_end INT"
        ))

        # 구간별 체감 난이도 응답. Q1 was_uncomfortable(불편했나요 예/아니오) +
        # Q2 hardship_score(예일 때만 1~10점). 평가 시점의 경사·소요시간 스냅샷을
        # 함께 박아 두어 추후 누적 데이터를 분석에 쓸 수 있게 한다(사용자 요구).
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS segment_hardship_feedback (
                id                SERIAL PRIMARY KEY,
                uid               TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                route_id          INT  NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
                session_id        TEXT,
                seg_index         INT   NOT NULL,
                seg_index_end     INT,
                rank              SMALLINT NOT NULL,
                pace_s_per_m      FLOAT NOT NULL,
                elapsed_ms        BIGINT NOT NULL,
                distance_m        FLOAT NOT NULL,
                slope_pct         FLOAT NOT NULL,
                zone              TEXT,
                was_uncomfortable BOOLEAN NOT NULL,
                hardship_score    SMALLINT,
                answered_at       TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (route_id, seg_index),
                CONSTRAINT chk_hardship_score
                    CHECK (hardship_score IS NULL OR hardship_score BETWEEN 1 AND 10),
                CONSTRAINT chk_hardship_consistency
                    CHECK (was_uncomfortable OR hardship_score IS NULL)
            )
        """))
        conn.execute(text(
            "ALTER TABLE segment_hardship_feedback ADD COLUMN IF NOT EXISTS seg_index_end INT"
        ))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_seg_hardship_analysis
            ON segment_hardship_feedback (slope_pct, pace_s_per_m, was_uncomfortable)
        """))

        conn.commit()
    print("[DB] 테이블 초기화 완료")


def get_or_create_user(
    db: Session,
    uid: str,
    email: str,
    display_name: str = "",
    photo_url: str = "",
) -> dict:
    """Google 로그인 시 호출 — 신규면 INSERT, 기존이면 last_login_at 갱신"""
    if not engine:
        return {"uid": uid, "email": email, "display_name": display_name, "user_type": "elderly"}

    row = db.execute(
        text("SELECT uid, email, display_name, photo_url, user_type FROM users WHERE uid = :uid"),
        {"uid": uid},
    ).fetchone()

    if row:
        db.execute(
            text("UPDATE users SET last_login_at = NOW() WHERE uid = :uid"),
            {"uid": uid},
        )
        db.commit()
        return {
            "uid":          row[0],
            "email":        row[1],
            "display_name": row[2] or display_name,
            "photo_url":    row[3] or photo_url,
            "user_type":    row[4],
        }

    db.execute(
        text("""
            INSERT INTO users (uid, email, display_name, photo_url)
            VALUES (:uid, :email, :display_name, :photo_url)
        """),
        {"uid": uid, "email": email, "display_name": display_name, "photo_url": photo_url},
    )
    db.commit()
    return {"uid": uid, "email": email, "display_name": display_name, "photo_url": photo_url, "user_type": "elderly"}


def delete_user_account(db: Session, uid: str) -> bool:
    """회원 탈퇴 — users 행 삭제. bookmarks/feedback/user_speed_profile은 FK
    CASCADE로 같이 지워지고, routes.uid는 ON DELETE SET NULL이라 경로/경사도
    데이터 자체는 (개인 식별 없이) 그대로 남는다 — 라우팅 모델 학습용으로 보존."""
    if not engine:
        return False
    result = db.execute(text("DELETE FROM users WHERE uid = :uid"), {"uid": uid})
    db.commit()
    return result.rowcount > 0


def get_user_profile(db: Session, uid: str) -> dict | None:
    """uid로 유저 프로필 조회 — 없으면 None"""
    if not engine:
        return None

    row = db.execute(
        text("""
            SELECT uid, email, display_name, photo_url, user_type,
                   created_at, last_login_at
            FROM users WHERE uid = :uid
        """),
        {"uid": uid},
    ).fetchone()

    if not row:
        return None

    return {
        "uid":           row[0],
        "email":         row[1],
        "display_name":  row[2] or "",
        "photo_url":     row[3] or "",
        "user_type":     row[4],
        "created_at":    row[5].isoformat() if row[5] else "",
        "last_login_at": row[6].isoformat() if row[6] else "",
    }


def update_user_type(db: Session, uid: str, user_type: str) -> dict:
    """사용자 이동 유형(elderly / wheelchair 등) 변경"""
    if not engine:
        return {"uid": uid, "user_type": user_type}

    db.execute(
        text("UPDATE users SET user_type = :user_type WHERE uid = :uid"),
        {"uid": uid, "user_type": user_type},
    )
    db.commit()
    return {"uid": uid, "user_type": user_type}


def get_user_stats(db: Session, uid: str) -> dict:
    """마이페이지 통계 집계"""
    if not engine:
        return {
            "total_routes": 0, "total_distance_m": 0.0,
            "total_duration_ms": 0, "avg_slope_pct": 0.0, "avg_satisfaction": None,
        }

    row = db.execute(text("""
        SELECT
            COUNT(r.id)                                    AS total_routes,
            COALESCE(SUM(r.total_length_m), 0)             AS total_distance_m,
            COALESCE(SUM(r.total_duration_ms), 0)          AS total_duration_ms,
            ROUND(CAST(AVG(r.avg_slope_pct) AS NUMERIC), 2) AS avg_slope_pct,
            ROUND(CAST(AVG(f.rating)        AS NUMERIC), 2) AS avg_satisfaction
        FROM routes r
        LEFT JOIN feedback f ON f.route_id = r.id AND f.uid = :uid
        WHERE r.uid = :uid AND r.status = 'completed'
    """), {"uid": uid}).fetchone()

    return {
        "total_routes":     int(row[0] or 0),
        "total_distance_m": float(row[1] or 0),
        "total_duration_ms": int(row[2] or 0),
        "avg_slope_pct":    float(row[3] or 0),
        "avg_satisfaction": float(row[4]) if row[4] is not None else None,
    }


def delete_user_route(db: Session, route_id: int, uid: str) -> bool:
    """본인 경로 삭제 — 성공 시 True, 없거나 권한 없으면 False"""
    if not engine:
        return False

    result = db.execute(
        text("DELETE FROM routes WHERE id = :id AND uid = :uid RETURNING id"),
        {"id": route_id, "uid": uid},
    ).fetchone()
    db.commit()
    return result is not None


def save_user_route(
    db: Session,
    uid: str,
    from_name: str,
    to_name: str,
    mode: str,
    walker_type: str,
    total_duration_ms: int,
    date_iso: str,
    segments: list,
) -> int | None:
    """FE 안내 완료 후 호출 — 경로 + 구간 데이터 저장, route_id 반환"""
    if not engine:
        return None

    total_length_m = sum(s.get("distanceM", 0.0) for s in segments)
    avg_slope_pct  = (
        sum(abs(s.get("slopePercent", 0.0)) * s.get("distanceM", 0.0) for s in segments)
        / total_length_m if total_length_m > 0 else 0.0
    )

    # users 테이블에 없으면 먼저 생성 (회원가입 시 /auth/login 실패한 경우 대비)
    exists = db.execute(
        text("SELECT 1 FROM users WHERE uid = :uid"), {"uid": uid}
    ).fetchone()
    if not exists:
        db.execute(
            text("INSERT INTO users (uid, email, display_name, photo_url) VALUES (:uid, '', '', '') ON CONFLICT (uid) DO NOTHING"),
            {"uid": uid},
        )
        db.commit()

    row = db.execute(text("""
        INSERT INTO routes
            (uid, user_type, algorithm, mode, origin_name, dest_name,
             walker_type, total_duration_ms, total_length_m, avg_slope_pct,
             created_at)
        VALUES
            (:uid, :walker_type, 'client', :mode, :from_name, :to_name,
             :walker_type, :total_duration_ms, :total_length_m, :avg_slope_pct,
             CAST(:created_at AS TIMESTAMPTZ))
        RETURNING id
    """), {
        "uid":               uid,
        "walker_type":       walker_type,
        "mode":              mode,
        "from_name":         from_name,
        "to_name":           to_name,
        "total_duration_ms": total_duration_ms,
        "total_length_m":    total_length_m,
        "avg_slope_pct":     avg_slope_pct,
        "created_at":        date_iso,
    })
    route_id = row.fetchone()[0]

    for seg in segments:
        db.execute(text("""
            INSERT INTO navigation_segments
                (route_id, seg_index, distance_m, slope_pct, elapsed_ms,
                 direction, zone, name)
            VALUES (:route_id, :seg_index, :distance_m, :slope_pct, :elapsed_ms,
                    :direction, :zone, :name)
        """), {
            "route_id":   route_id,
            "seg_index":  seg.get("index", 0),
            "distance_m": seg.get("distanceM", 0.0),
            "slope_pct":  seg.get("slopePercent", 0.0),
            "elapsed_ms": seg.get("elapsedMs", 0),
            "direction":  seg.get("direction"),
            "zone":       seg.get("zone"),
            "name":       seg.get("name"),
        })

    db.commit()
    return route_id


def get_user_routes(db: Session, uid: str) -> list:
    """마이페이지 — 사용자의 완료된 경로 목록 (만족도 포함, 최신순)"""
    if not engine:
        return []

    rows = db.execute(text("""
        SELECT r.id, r.origin_name, r.dest_name, r.mode, r.walker_type,
               r.total_duration_ms, r.created_at, f.rating
        FROM routes r
        LEFT JOIN feedback f ON f.route_id = r.id AND f.uid = :uid
        WHERE r.uid = :uid AND r.status = 'completed'
        ORDER BY r.created_at DESC
        LIMIT 100
    """), {"uid": uid}).fetchall()

    result = []
    for row in rows:
        route_id = row[0]
        segs = db.execute(text("""
            SELECT seg_index, distance_m, slope_pct, elapsed_ms,
                   direction, zone, name
            FROM navigation_segments WHERE route_id = :rid ORDER BY seg_index
        """), {"rid": route_id}).fetchall()

        created = row[6]
        result.append({
            "id":              route_id,
            "from":            row[1] or "",
            "to":              row[2] or "",
            "mode":            row[3] or "walk",
            "walkerType":      row[4] or "elderly",
            "date":            created.isoformat() if created else "",
            "totalDurationMs": row[5] or 0,
            "segments": [
                {
                    "index":        s[0],
                    "distanceM":    s[1],
                    "slopePercent": s[2],
                    "elapsedMs":    s[3],
                    "direction":    s[4],
                    "zone":         s[5],
                    "name":         s[6],
                }
                for s in segs
            ],
            "satisfaction": row[7],
        })

    return result


def save_or_update_feedback(db: Session, route_id: int, uid: str, rating: int) -> dict:
    """만족도 저장/수정 (upsert) — 안내 직후 팝업 및 마이페이지에서 모두 호출 가능"""
    if not engine:
        return {"route_id": route_id, "rating": rating}

    existing = db.execute(text("""
        SELECT id FROM feedback WHERE route_id = :route_id AND uid = :uid
    """), {"route_id": route_id, "uid": uid}).fetchone()

    if existing:
        db.execute(text("""
            UPDATE feedback SET rating = :rating, created_at = NOW()
            WHERE route_id = :route_id AND uid = :uid
        """), {"rating": rating, "route_id": route_id, "uid": uid})
    else:
        db.execute(text("""
            INSERT INTO feedback (route_id, uid, rating)
            VALUES (:route_id, :uid, :rating)
        """), {"route_id": route_id, "uid": uid, "rating": rating})

    db.commit()
    return {"route_id": route_id, "rating": rating}


def get_user_bookmarks(db: Session, uid: str) -> list:
    """사용자 북마크 목록 조회 (최신순)"""
    if not engine:
        return []
    rows = db.execute(text("""
        SELECT place_id, name, address, latitude, longitude, category, phone, created_at
        FROM bookmarks WHERE uid = :uid ORDER BY created_at DESC
    """), {"uid": uid}).fetchall()
    return [
        {
            "place_id":  row[0],
            "name":      row[1],
            "address":   row[2] or "",
            "latitude":  row[3],
            "longitude": row[4],
            "category":  row[5] or "",
            "phone":     row[6] or None,
            "createdAt": int(row[7].timestamp() * 1000) if row[7] else 0,
        }
        for row in rows
    ]


def save_user_bookmark(
    db: Session,
    uid: str,
    place_id: str,
    name: str,
    address: str,
    latitude: float,
    longitude: float,
    category: str,
    phone: str | None,
) -> dict:
    """북마크 추가 (이미 있으면 name/address 등 갱신, upsert)"""
    if not engine:
        return {"place_id": place_id}
    db.execute(text("""
        INSERT INTO bookmarks (uid, place_id, name, address, latitude, longitude, category, phone)
        VALUES (:uid, :place_id, :name, :address, :latitude, :longitude, :category, :phone)
        ON CONFLICT (uid, place_id) DO UPDATE
            SET name = EXCLUDED.name,
                address = EXCLUDED.address,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                category = EXCLUDED.category,
                phone = EXCLUDED.phone,
                created_at = NOW()
    """), {
        "uid": uid, "place_id": place_id, "name": name,
        "address": address, "latitude": latitude, "longitude": longitude,
        "category": category, "phone": phone,
    })
    db.commit()
    return {"place_id": place_id}


def delete_user_bookmark(db: Session, uid: str, place_id: str) -> bool:
    """북마크 삭제 — 성공 시 True"""
    if not engine:
        return False
    result = db.execute(
        text("DELETE FROM bookmarks WHERE uid = :uid AND place_id = :place_id RETURNING id"),
        {"uid": uid, "place_id": place_id},
    ).fetchone()
    db.commit()
    return result is not None


def get_search_history(db: Session, uid: str, limit: int = 20) -> list:
    """최근 검색기록 조회 (최신순) — 출발지/도착지 구분 없음"""
    if not engine:
        return []
    rows = db.execute(text("""
        SELECT place_id, name, address, latitude, longitude, category, phone, searched_at
        FROM search_history WHERE uid = :uid ORDER BY searched_at DESC LIMIT :limit
    """), {"uid": uid, "limit": limit}).fetchall()
    return [
        {
            "place_id":   row[0],
            "name":       row[1],
            "address":    row[2] or "",
            "latitude":   row[3],
            "longitude":  row[4],
            "category":   row[5] or "",
            "phone":      row[6] or None,
            "searchedAt": int(row[7].timestamp() * 1000) if row[7] else 0,
        }
        for row in rows
    ]


def save_search_history(
    db: Session,
    uid: str,
    place_id: str,
    name: str,
    address: str,
    latitude: float,
    longitude: float,
    category: str,
    phone: str | None,
) -> dict:
    """검색기록 추가 — 같은 장소를 다시 검색하면 새 행 대신 searched_at만 갱신(맨 위로)"""
    if not engine:
        return {"place_id": place_id}
    db.execute(text("""
        INSERT INTO search_history (uid, place_id, name, address, latitude, longitude, category, phone)
        VALUES (:uid, :place_id, :name, :address, :latitude, :longitude, :category, :phone)
        ON CONFLICT (uid, place_id) DO UPDATE
            SET name = EXCLUDED.name,
                address = EXCLUDED.address,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                category = EXCLUDED.category,
                phone = EXCLUDED.phone,
                searched_at = NOW()
    """), {
        "uid": uid, "place_id": place_id, "name": name,
        "address": address, "latitude": latitude, "longitude": longitude,
        "category": category, "phone": phone,
    })
    db.commit()
    return {"place_id": place_id}


def start_navigation(
    db: Session,
    uid: str,
    from_name: str,
    to_name: str,
    mode: str,
    walker_type: str,
    origin_lat: float | None = None,
    origin_lon: float | None = None,
    dest_lat: float | None = None,
    dest_lon: float | None = None,
    date_iso: str | None = None,
) -> int | None:
    """안내 시작 — routes에 in_progress 행 INSERT, route_id 반환"""
    if not engine:
        return None

    exists = db.execute(
        text("SELECT 1 FROM users WHERE uid = :uid"), {"uid": uid}
    ).fetchone()
    if not exists:
        db.execute(
            text("INSERT INTO users (uid, email, display_name, photo_url) VALUES (:uid, '', '', '') ON CONFLICT (uid) DO NOTHING"),
            {"uid": uid},
        )
        db.commit()

    has_geom = all(v is not None for v in [origin_lat, origin_lon, dest_lat, dest_lon])
    if has_geom:
        geom_sql = (
            "ST_GeomFromText(:origin_wkt, 4326)",
            "ST_GeomFromText(:dest_wkt, 4326)",
        )
        geom_params = {
            "origin_wkt": f"POINT({origin_lon} {origin_lat})",
            "dest_wkt":   f"POINT({dest_lon} {dest_lat})",
        }
    else:
        geom_sql = ("NULL", "NULL")
        geom_params = {}

    row = db.execute(text(f"""
        INSERT INTO routes
            (uid, user_type, walker_type, mode, origin_name, dest_name,
             origin_geom, dest_geom, algorithm, status, created_at)
        VALUES
            (:uid, :walker_type, :walker_type, :mode, :from_name, :to_name,
             {geom_sql[0]}, {geom_sql[1]},
             'networkx', 'in_progress',
             COALESCE(CAST(:created_at AS TIMESTAMPTZ), NOW()))
        RETURNING id
    """), {
        "uid":        uid,
        "walker_type": walker_type,
        "mode":       mode,
        "from_name":  from_name,
        "to_name":    to_name,
        "created_at": date_iso,
        **geom_params,
    })
    route_id = row.fetchone()[0]
    db.commit()
    return route_id


def add_navigation_segment(
    db: Session,
    route_id: int,
    uid: str,
    index: int,
    distance_m: float,
    slope_pct: float,
    elapsed_ms: int,
    measured: bool,
    zone: str | None,
    direction: str | None,
) -> bool:
    """구간 완료 시 navigation_segments에 행 INSERT"""
    if not engine:
        return False

    owns = db.execute(
        text("SELECT 1 FROM routes WHERE id = :id AND uid = :uid AND status = 'in_progress'"),
        {"id": route_id, "uid": uid},
    ).fetchone()
    if not owns:
        return False

    db.execute(text("""
        INSERT INTO navigation_segments
            (route_id, seg_index, distance_m, slope_pct, elapsed_ms, measured, direction, zone)
        VALUES
            (:route_id, :index, :distance_m, :slope_pct, :elapsed_ms, :measured, :direction, :zone)
    """), {
        "route_id":   route_id,
        "index":      index,
        "distance_m": distance_m,
        "slope_pct":  slope_pct,
        "elapsed_ms": elapsed_ms,
        "measured":   measured,
        "direction":  direction,
        "zone":       zone,
    })
    db.commit()
    return True


def _apply_speed_ema(
    db: Session,
    uid: str,
    zone_key: str,
    speed: float,
    user_type: str,
    distance_m: float,
) -> None:
    """
    user_speed_profile 의 한 (uid, zone_key) 행을 EMA 로 갱신한다.

    개별 zone POST(save_zone_observation)와 파일럿 배치(/collect/batch)가 **같은**
    EMA 로직을 쓰도록 뽑아낸 공용 함수 (인계 v2 §4.5 B-2). 커밋은 호출측 책임.

    cumulative_distance_m 은 캘리브레이션 게이트(문서 3.9절)용 — 이 zone 으로
    실제 걸은 거리를 누적한다. flat 은 이 값이 CALIBRATION_FLAT_M 을 넘어야
    get_user_speed_profile 이 EMA 결과를 내보낸다.
    """
    row = db.execute(text("""
        SELECT speed_ms, sample_count FROM user_speed_profile
        WHERE uid = :uid AND zone_key = :zone_key
    """), {"uid": uid, "zone_key": zone_key}).fetchone()

    if row:
        new_speed = ema_update(float(row[0]), speed, int(row[1]))
        db.execute(text("""
            UPDATE user_speed_profile
            SET speed_ms = :speed,
                sample_count = sample_count + 1,
                cumulative_distance_m = cumulative_distance_m + :dist,
                updated_at = NOW()
            WHERE uid = :uid AND zone_key = :zone_key
        """), {"speed": new_speed, "dist": max(0.0, distance_m),
               "uid": uid, "zone_key": zone_key})
    else:
        prior = get_default_speed(user_type, zone_key)
        new_speed = ema_update(prior, speed, 0)
        db.execute(text("""
            INSERT INTO user_speed_profile
                (uid, zone_key, speed_ms, sample_count, cumulative_distance_m)
            VALUES (:uid, :zone_key, :speed, 1, :dist)
        """), {"uid": uid, "zone_key": zone_key, "speed": new_speed,
               "dist": max(0.0, distance_m)})


def _zone_key_for_slope(slope_pct: float, user_type: str) -> str:
    """부호 있는 경사(%) + 유형 → zone_key. 평지 임계는 config.FLAT_THRESHOLD."""
    if abs(slope_pct) < FLAT_THRESHOLD:
        return "flat"
    direction = "up" if slope_pct > 0 else "down"
    zone = classify_zone(slope_pct, direction, user_type)
    return get_zone_key(zone, direction)


def save_zone_observation(
    db: Session,
    route_id: int,
    uid: str,
    user_type: str,
    zone_key: str,
    slope_pct_avg: float,
    distance_m: float,
    elapsed_ms: int,
    gps_sample_n: int,
) -> bool:
    """
    zone 통과 관측값 검증 후 저장, user_speed_profile EMA 업데이트.
    반환: 관측값이 유효하면 True, 버려지면 False.
    """
    if not engine:
        return False

    speed = validate_observation(distance_m, elapsed_ms, gps_sample_n)
    if speed is None:
        return False

    db.execute(text("""
        INSERT INTO trip_zone_observations
            (route_id, uid, user_type, zone_key, slope_pct_avg,
             distance_m, elapsed_ms, gps_sample_n)
        VALUES
            (:route_id, :uid, :user_type, :zone_key, :slope_pct_avg,
             :distance_m, :elapsed_ms, :gps_sample_n)
    """), {
        "route_id":      route_id,
        "uid":           uid,
        "user_type":     user_type,
        "zone_key":      zone_key,
        "slope_pct_avg": slope_pct_avg,
        "distance_m":    distance_m,
        "elapsed_ms":    elapsed_ms,
        "gps_sample_n":  gps_sample_n,
    })

    _apply_speed_ema(db, uid, zone_key, speed, user_type, distance_m)
    db.commit()
    return True


def get_user_speed_profile(db: Session, uid: str, calibrated_only: bool = True) -> dict[str, float]:
    """
    유저의 zone_key별 개인화 속도 반환.
    관측이 없는 zone_key는 포함하지 않음 (호출측에서 fallback 처리).

    calibrated_only=True(기본, 소요시간 추정용): flat 은 누적 평지 관측 거리가
    CALIBRATION_FLAT_M 미만이면 제외한다(문서 3.9/3.10절 — 덜 채워진 v̄_flat 을
    정규화 기준으로 쓰지 않게). 배치 학습(⑨)은 False 로 원본을 그대로 읽는다.
    """
    if not engine:
        return {}

    rows = db.execute(text("""
        SELECT zone_key, speed_ms, cumulative_distance_m
        FROM user_speed_profile WHERE uid = :uid
    """), {"uid": uid}).fetchall()

    out: dict[str, float] = {}
    for zone_key, speed_ms, cum_m in rows:
        if calibrated_only and zone_key == "flat" and float(cum_m or 0.0) < CALIBRATION_FLAT_M:
            continue
        out[zone_key] = float(speed_ms)
    return out


def get_user_sample_counts(db: Session, uid: str) -> dict[str, int]:
    """유저의 zone_key별 관측 횟수 반환 (개인화 적용 여부 판단용)"""
    if not engine:
        return {}

    rows = db.execute(text("""
        SELECT zone_key, sample_count FROM user_speed_profile WHERE uid = :uid
    """), {"uid": uid}).fetchall()

    return {row[0]: int(row[1]) for row in rows}


def get_personalization_status(db: Session, uid: str) -> dict:
    """
    개인화 학습 현황 — FE 마이페이지/안내 시작 배지용 (이슈 #4·#9).

    calibrated: v̄_flat 캘리브레이션(평지 누적 CALIBRATION_FLAT_M) 완료 여부.
    flat_progress_m / flat_target_m: 진행률 표시용.
    zone_samples: zone_key 별 누적 관측 횟수.
    session_count: 지금까지 수집된 개인화 세션 수(distinct session_id).
    """
    empty = {
        "calibrated":      False,
        "flat_progress_m": 0.0,
        "flat_target_m":   CALIBRATION_FLAT_M,
        "zone_samples":    {},
        "total_samples":   0,
        "session_count":   0,
    }
    if not engine:
        return empty

    prof = db.execute(text("""
        SELECT zone_key, sample_count, cumulative_distance_m
        FROM user_speed_profile WHERE uid = :uid
    """), {"uid": uid}).fetchall()

    zone_samples = {r[0]: int(r[1] or 0) for r in prof}
    flat_cum = next((float(r[2] or 0.0) for r in prof if r[0] == "flat"), 0.0)

    try:
        sess = db.execute(text(
            "SELECT COUNT(DISTINCT session_id) FROM trip_slope_observations WHERE uid = :uid"
        ), {"uid": uid}).fetchone()
        session_count = int(sess[0] or 0) if sess else 0
    except Exception:
        session_count = 0

    return {
        "calibrated":      flat_cum >= CALIBRATION_FLAT_M,
        "flat_progress_m": round(min(flat_cum, CALIBRATION_FLAT_M), 1),
        "flat_target_m":   CALIBRATION_FLAT_M,
        "zone_samples":    zone_samples,
        "total_samples":   sum(zone_samples.values()),
        "session_count":   session_count,
    }


def save_collect_batch(
    db: Session,
    uid: str,
    session_id: str,
    seq: int,
    slope_observations: list,
    speed_samples_in: list,
    route_choice: dict | None,
    segment_feedback_in: list,
    route_profile: dict | None = None,
) -> dict:
    """
    ando_dev_final.md 3.9절 — 개인 맞춤 경로 추천 신호 4종을 한 번에 저장.

    멱등: (uid, session_id, seq)가 이미 처리됐으면 재삽입하지 않고 바로 반환한다
    (FE가 네트워크 실패로 같은 배치를 재전송해도 중복 저장되지 않음).

    route_profile: {segments:[{slope,length_m}], total_length_m, coordinates?, route_id?}
      세션 첫 배치에만 실려 온다. session_route_profile 에 UPSERT — route_id 가 NULL 인
      세션도 경로 형상을 잃지 않도록 (docs/personalization-data-collection-plan.md §1.3).
    """
    if not engine:
        return {"ok": False, "reason": "DB 미설정"}

    dup = db.execute(text("""
        INSERT INTO collect_batch_log (uid, session_id, seq)
        VALUES (:uid, :session_id, :seq)
        ON CONFLICT (uid, session_id, seq) DO NOTHING
        RETURNING uid
    """), {"uid": uid, "session_id": session_id, "seq": seq}).fetchone()

    if dup is None:
        db.commit()
        return {"ok": True, "duplicate": True}

    # 관측 시점 유형 — 이 배치의 모든 trip_slope_observations 행에 박아 넣는다 (§1.2).
    _ut_row = db.execute(
        text("SELECT user_type FROM users WHERE uid = :uid"), {"uid": uid}
    ).fetchone()
    user_type = _ut_row[0] if _ut_row and _ut_row[0] else "elderly"

    # 경로 형상 스냅샷 (세션 첫 배치에만 옴) — UPSERT
    profile_saved = False
    if route_profile and route_profile.get("segments"):
        db.execute(text("""
            INSERT INTO session_route_profile
                (uid, session_id, route_id, user_type, total_length_m, segments, coordinates)
            VALUES
                (:uid, :session_id, :route_id, :user_type, :total_length_m,
                 CAST(:segments AS JSONB), CAST(:coordinates AS JSONB))
            ON CONFLICT (uid, session_id) DO UPDATE SET
                route_id       = COALESCE(EXCLUDED.route_id, session_route_profile.route_id),
                user_type      = EXCLUDED.user_type,
                total_length_m = EXCLUDED.total_length_m,
                segments       = EXCLUDED.segments,
                coordinates    = EXCLUDED.coordinates,
                captured_at    = NOW()
        """), {
            "uid":            uid,
            "session_id":     session_id,
            "route_id":       route_profile.get("route_id"),
            "user_type":      user_type,
            "total_length_m": route_profile.get("total_length_m"),
            "segments":       json.dumps(route_profile["segments"]),
            "coordinates":    json.dumps(route_profile.get("coordinates"))
                              if route_profile.get("coordinates") is not None else None,
        })
        profile_saved = True

    for obs in slope_observations:
        db.execute(text("""
            INSERT INTO trip_slope_observations
                (uid, route_id, session_id, user_type, slope_bin, distance_m,
                 elapsed_ms, stop_ms, gps_sample_n)
            VALUES
                (:uid, :route_id, :session_id, :user_type, :slope_bin, :distance_m,
                 :elapsed_ms, :stop_ms, :gps_sample_n)
        """), {
            "uid":          uid,
            "route_id":     obs.get("route_id"),
            "session_id":   session_id,
            "user_type":    user_type,
            "slope_bin":    obs["slope_bin"],
            "distance_m":   obs["distance_m"],
            "elapsed_ms":   obs["elapsed_ms"],
            "stop_ms":      obs.get("stop_ms", 0),
            "gps_sample_n": obs["gps_sample_n"],
        })

    # ── user_speed_profile EMA 갱신 (인계 v2 §4.5 B-2 + Q&A #4) ────────────────
    # FE 가 개별 POST /navigation/:id/zone 를 없앤 뒤로, v̄_flat 을 포함한 zone
    # 속도 EMA 를 갱신할 경로가 여기밖에 없다. bin 관측을 zone_key 로 매핑해
    # save_zone_observation 과 동일한 _apply_speed_ema 로 갱신한다.
    #   - flat 은 v̄_flat (신호 A·B 정규화 기준, 3.10절) — 캘리브레이션 게이트 적용
    #   - flat 외 6개 zone_key 는 소요시간 추정 폴백 + 논문 비교군 (Q&A #4:
    #     "라우팅 선택에서만 빼고 수집·소요시간·비교군으로는 유지")
    # 학습용 원본은 trip_slope_observations 에 그대로 있으니 여기서 버려도 무방.
    speed_ema_applied = 0
    if slope_observations:
        for obs in slope_observations:
            speed = validate_observation(
                obs["distance_m"], obs["elapsed_ms"], obs["gps_sample_n"],
                obs.get("stop_ms", 0),
            )
            if speed is None:
                continue
            zk = _zone_key_for_slope(float(obs["slope_bin"]), user_type)
            _apply_speed_ema(db, uid, zk, speed, user_type, float(obs["distance_m"]))
            speed_ema_applied += 1

    for s in speed_samples_in:
        db.execute(text("""
            INSERT INTO speed_samples
                (uid, route_id, session_id, slope_bin, sub_distance_m, speed_ms)
            VALUES
                (:uid, :route_id, :session_id, :slope_bin, :sub_distance_m, :speed_ms)
        """), {
            "uid":            uid,
            "route_id":       s.get("route_id"),
            "session_id":     session_id,
            "slope_bin":      s["slope_bin"],
            "sub_distance_m": s["sub_distance_m"],
            "speed_ms":       s["speed_ms"],
        })

    if route_choice is not None:
        db.execute(text("""
            INSERT INTO route_choice_log
                (uid, session_id, candidates, n_shown, chosen_kind)
            VALUES
                (:uid, :session_id, CAST(:candidates AS JSONB), :n_shown, :chosen_kind)
        """), {
            "uid":         uid,
            "session_id":  session_id,
            "candidates":  json.dumps(route_choice["candidates"]),
            "n_shown":     route_choice["n_shown"],
            "chosen_kind": route_choice.get("chosen_kind"),
        })

    for f in segment_feedback_in:
        db.execute(text("""
            INSERT INTO segment_feedback
                (uid, route_id, slope_mean, length_m, verdict)
            VALUES
                (:uid, :route_id, :slope_mean, :length_m, :verdict)
        """), {
            "uid":        uid,
            "route_id":   f.get("route_id"),
            "slope_mean": f["slope_mean"],
            "length_m":   f["length_m"],
            "verdict":    f["verdict"],
        })

    db.commit()
    return {
        "ok": True,
        "duplicate": False,
        "saved": {
            "slope_observations": len(slope_observations),
            "speed_samples":      len(speed_samples_in),
            "route_choice":       route_choice is not None,
            "segment_feedback":   len(segment_feedback_in),
            "speed_ema_applied":  speed_ema_applied,
            "route_profile":      profile_saved,
        },
    }


def complete_navigation(
    db: Session,
    route_id: int,
    uid: str,
    total_duration_ms: int,
) -> dict | None:
    """안내 종료 — 구간 집계 후 status=completed 확정"""
    if not engine:
        return None

    owns = db.execute(
        text("SELECT 1 FROM routes WHERE id = :id AND uid = :uid AND status = 'in_progress'"),
        {"id": route_id, "uid": uid},
    ).fetchone()
    if not owns:
        return None

    agg = db.execute(text("""
        SELECT
            COALESCE(SUM(distance_m), 0),
            COALESCE(
                SUM(ABS(slope_pct) * distance_m) / NULLIF(SUM(distance_m), 0),
                0
            )
        FROM navigation_segments
        WHERE route_id = :route_id
    """), {"route_id": route_id}).fetchone()

    total_length_m = round(float(agg[0]), 1)
    avg_slope_pct  = round(float(agg[1]), 2)

    db.execute(text("""
        UPDATE routes
        SET total_length_m    = :total_length_m,
            avg_slope_pct     = :avg_slope_pct,
            total_duration_ms = :total_duration_ms,
            status            = 'completed'
        WHERE id = :id AND uid = :uid
    """), {
        "id":                route_id,
        "uid":               uid,
        "total_length_m":    total_length_m,
        "avg_slope_pct":     avg_slope_pct,
        "total_duration_ms": total_duration_ms,
    })

    # pace(1m당 소요시간) 상위 구간을 지금(종료 시점) 미리 계산해 캐시에 저장 —
    # 안내 종료 직후 FE 가 /navigation/{id}/slow-segments 로 바로 읽어간다.
    ranked = _rank_and_store_slow_segments(db, route_id)
    db.commit()

    return {
        "route_id":          route_id,
        "total_length_m":    total_length_m,
        "avg_slope_pct":     avg_slope_pct,
        "total_duration_ms": total_duration_ms,
        "slow_segments_ranked": ranked,
    }


# ── 구간 체감 난이도 평가 (⑭' — 1m당 소요시간 pace 기준) ─────────────────────
# navigation_segments 는 그래프 엣지 단위(~5~10m, 경로당 수십~수백 행)라 그대로는
# "구간"이 아니다 — 연속 엣지를 경사 bin 으로 묶어 사람이 인지하는 구간으로 만든 뒤
# 그 구간들을 pace 순으로 랭킹한다. 파라미터는 C등급(근거 없음) — 파일럿 후 조정.
SLOW_SEG_MIN_DIST_M = 25.0   # 묶은 구간이 이보다 짧으면 제외 (pickFeedbackSegments 와 동일)
SLOW_SEG_MAX_RANKED = 10     # 상위 몇 구간까지 물어볼지 (사용자 사양: 10순위, 1~9면 전부)
SLOW_SEG_SPEED_MIN  = 0.05   # m/s — 거리/시간 이 범위 밖이면 GPS 점프/정지 이상치
SLOW_SEG_SPEED_MAX  = 2.50   # (routing/speed.py _SPEED_MIN/_MAX 와 동일)
SLOW_SEG_BIN_PCT    = 1.0    # 연속 엣지를 한 구간으로 묶는 경사 bin 폭(%p)

_SLOW_SEG_SELECT = """
    SELECT rank, seg_index, seg_index_end, distance_m, slope_pct, direction, zone,
           name, elapsed_ms, pace_s_per_m
    FROM route_slow_segments
    WHERE route_id = :rid
    ORDER BY rank
"""


def _route_segment_groups(db: Session, route_id: int) -> list[dict]:
    """
    navigation_segments 원본(엣지 단위) → 사람이 인지하는 "구간" 묶음.
    연속(seg_index 가 1씩 증가) + measured=TRUE + 같은 경사 bin(±SLOW_SEG_BIN_PCT) 이면 한 구간.
    각 구간: seg_index(첫 엣지), seg_index_end(끝 엣지), distance_m·elapsed_ms 합,
             slope_pct(길이가중 평균), pace_s_per_m, direction/zone/name(대표값).
    """
    edge_rows = db.execute(text("""
        SELECT seg_index, distance_m, slope_pct, direction, zone, name, elapsed_ms, measured
        FROM navigation_segments
        WHERE route_id = :rid
        ORDER BY seg_index ASC
    """), {"rid": route_id}).fetchall()

    groups: list[dict] = []
    cur: dict | None = None
    for si, dist, slope, direction, zone, name, elapsed, measured in edge_rows:
        si = int(si)
        dist = float(dist or 0.0)
        elapsed = int(elapsed or 0)
        slope = None if slope is None else float(slope)
        if not (bool(measured) and slope is not None and dist > 0):
            cur = None
            continue
        b = int(round(slope / SLOW_SEG_BIN_PCT))
        if cur is not None and si == cur["_next"] and b == cur["_bin"]:
            cur["seg_index_end"] = si
            cur["distance_m"]   += dist
            cur["elapsed_ms"]   += elapsed
            cur["_wslope"]      += slope * dist
            cur["_next"]         = si + 1
            if not cur["name"] and name:
                cur["name"] = name
        else:
            cur = {
                "seg_index": si, "seg_index_end": si,
                "distance_m": dist, "elapsed_ms": elapsed,
                "_wslope": slope * dist, "_bin": b, "_next": si + 1,
                "direction": direction, "zone": zone, "name": name or "",
            }
            groups.append(cur)

    for g in groups:
        d = g["distance_m"]
        g["slope_pct"]    = round(g["_wslope"] / d, 3) if d else 0.0
        g["pace_s_per_m"] = round((g["elapsed_ms"] / 1000.0) / d, 4) if d else 0.0
        for k in ("_wslope", "_bin", "_next"):
            g.pop(k, None)
    return groups


def _slow_seg_eligible(g: dict) -> bool:
    """랭킹 대상 구간인지 — 경사 있고, 충분히 길고, 속도가 현실적인지."""
    d, e = g["distance_m"], g["elapsed_ms"]
    if d < SLOW_SEG_MIN_DIST_M or e <= 0:
        return False
    if abs(g["slope_pct"]) < FLAT_THRESHOLD:
        return False
    spd = d / (e / 1000.0)
    return SLOW_SEG_SPEED_MIN < spd < SLOW_SEG_SPEED_MAX


def _rank_and_store_slow_segments(db: Session, route_id: int) -> int:
    """
    navigation_segments(엣지 단위) → 구간 묶음 → 1m당 소요시간(pace) 큰 순으로
    상위 SLOW_SEG_MAX_RANKED(=10) 구간을 route_slow_segments 에 저장한다.
    유효 구간이 10 미만이면 그 전부 (사용자 사양: "1~9구간이면 경로 구간 모두 평가").
    정렬: pace 내림차순 → 거리 큰 순 → seg_index 오름차순. 커밋은 호출측 책임.
    """
    ranked = sorted(
        (g for g in _route_segment_groups(db, route_id) if _slow_seg_eligible(g)),
        key=lambda g: (-g["pace_s_per_m"], -g["distance_m"], g["seg_index"]),
    )[:SLOW_SEG_MAX_RANKED]

    db.execute(text("DELETE FROM route_slow_segments WHERE route_id = :rid"),
               {"rid": route_id})

    for rank, g in enumerate(ranked, start=1):
        db.execute(text("""
            INSERT INTO route_slow_segments
                (route_id, rank, seg_index, seg_index_end, distance_m, slope_pct,
                 direction, zone, name, elapsed_ms, pace_s_per_m)
            VALUES
                (:rid, :rank, :seg_index, :seg_index_end, :distance_m, :slope_pct,
                 :direction, :zone, :name, :elapsed_ms, :pace)
        """), {
            "rid": route_id, "rank": rank,
            "seg_index": g["seg_index"], "seg_index_end": g["seg_index_end"],
            "distance_m": round(g["distance_m"], 1), "slope_pct": g["slope_pct"],
            "direction": g["direction"], "zone": g["zone"],
            "name": g["name"] or None,
            "elapsed_ms": g["elapsed_ms"], "pace": g["pace_s_per_m"],
        })
    return len(ranked)


def get_slow_segments(db: Session, route_id: int, uid: str) -> dict | None:
    """
    pace 상위 구간 목록 (구간 체감 난이도 평가 화면용).
    complete_navigation 이 미리 채워 둔 route_slow_segments 를 우선 읽고, 비어 있으면
    (구버전 경로 / 종료 커밋 경합) 그 자리에서 navigation_segments 로 계산한다.
    소유자가 아니거나 경로가 없으면 None (호출측이 404).
    """
    if not engine:
        return None

    owns = db.execute(
        text("SELECT status FROM routes WHERE id = :id AND uid = :uid"),
        {"id": route_id, "uid": uid},
    ).fetchone()
    if not owns:
        return None
    status = owns[0]

    # meta 는 엣지가 아니라 "묶은 구간" 기준으로 센다 (사용자가 말하는 "N구간").
    groups        = _route_segment_groups(db, route_id)
    total_groups  = len(groups)
    sloped_groups = sum(1 for g in groups if _slow_seg_eligible(g))

    rows = db.execute(text(_SLOW_SEG_SELECT), {"rid": route_id}).fetchall()
    if not rows:
        # 미리 계산 결과가 없으면 즉석 계산 후 저장 (폴백)
        _rank_and_store_slow_segments(db, route_id)
        db.commit()
        rows = db.execute(text(_SLOW_SEG_SELECT), {"rid": route_id}).fetchall()

    segments = [{
        "rank":          int(r[0]),
        "seg_index":     int(r[1]),
        "seg_index_end": int(r[2]) if r[2] is not None else int(r[1]),
        "distance_m":    round(float(r[3]), 1),
        "slope_pct":     round(float(r[4]), 2),
        "direction":     r[5],
        "zone":          r[6],
        "name":          r[7],
        "elapsed_ms":    int(r[8]),
        "pace_s_per_m":  round(float(r[9]), 3),
    } for r in rows]

    meta = {
        "total_segments":  total_groups,     # 경로를 묶었을 때의 구간 수
        "sloped_segments": sloped_groups,    # 그중 경사 있어 평가 후보인 구간 수
        "ranked":          len(segments),    # 실제로 물어볼 구간 수 (min(10, sloped))
    }

    if not segments:
        if status == "in_progress" and total_groups == 0:
            reason = "route_not_completed"
        elif total_groups == 0:
            reason = "no_measured_segments"
        else:
            reason = "no_sloped_segments"      # 구간은 있으나 전부 평지/너무 짧음
        return {"eligible": False, "reason": reason, "route_id": route_id,
                "segments": [], "meta": meta}

    return {"eligible": True, "route_id": route_id, "segments": segments, "meta": meta}


def save_segment_hardship_feedback(
    db: Session,
    route_id: int,
    uid: str,
    session_id: str | None,
    answers: list,
) -> dict | None:
    """
    구간 체감 난이도 응답 저장 (upsert on route_id+seg_index).
    각 answer: seg_index, rank, pace_s_per_m, elapsed_ms, distance_m, slope_pct,
    zone, was_uncomfortable, hardship_score(예일 때만 1~10, 아니면 None).
    소유자가 아니거나 경로가 없으면 None.
    """
    if not engine:
        return None

    owns = db.execute(
        text("SELECT 1 FROM routes WHERE id = :id AND uid = :uid"),
        {"id": route_id, "uid": uid},
    ).fetchone()
    if not owns:
        return None

    count = 0
    for a in answers:
        was_unc = bool(a["was_uncomfortable"])
        raw_score = a.get("hardship_score")
        score = int(raw_score) if (was_unc and raw_score is not None) else None
        if score is not None:
            score = max(1, min(10, score))

        seg_end = a.get("seg_index_end")
        seg_end = int(seg_end) if seg_end is not None else None

        db.execute(text("""
            INSERT INTO segment_hardship_feedback
                (uid, route_id, session_id, seg_index, seg_index_end, rank, pace_s_per_m,
                 elapsed_ms, distance_m, slope_pct, zone,
                 was_uncomfortable, hardship_score)
            VALUES
                (:uid, :route_id, :session_id, :seg_index, :seg_end, :rank, :pace,
                 :elapsed_ms, :distance_m, :slope_pct, :zone,
                 :was_unc, :score)
            ON CONFLICT (route_id, seg_index) DO UPDATE SET
                session_id        = EXCLUDED.session_id,
                seg_index_end     = EXCLUDED.seg_index_end,
                rank              = EXCLUDED.rank,
                pace_s_per_m      = EXCLUDED.pace_s_per_m,
                elapsed_ms        = EXCLUDED.elapsed_ms,
                distance_m        = EXCLUDED.distance_m,
                slope_pct         = EXCLUDED.slope_pct,
                zone              = EXCLUDED.zone,
                was_uncomfortable = EXCLUDED.was_uncomfortable,
                hardship_score    = EXCLUDED.hardship_score,
                answered_at       = NOW()
        """), {
            "uid": uid, "route_id": route_id, "session_id": session_id,
            "seg_index": int(a["seg_index"]), "seg_end": seg_end, "rank": int(a["rank"]),
            "pace": float(a["pace_s_per_m"]), "elapsed_ms": int(a["elapsed_ms"]),
            "distance_m": float(a["distance_m"]), "slope_pct": float(a["slope_pct"]),
            "zone": a.get("zone"), "was_unc": was_unc, "score": score,
        })
        count += 1

    db.commit()
    return {"ok": True, "count": count}
