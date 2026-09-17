import json
import os
import random
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
            # S6 — 파일럿 참가자 구분. is_tester=팀 내부 테스트 계정(학습 데이터 오염
            # 방지용 배제 플래그), participant_cohort=파일럿 코호트 라벨(NULL=파일럿
            # 외 일반 사용자). 둘 다 이 마이그레이션에서 값을 채우지 않는다 — 누가
            # 테스터/참가자인지는 파일럿 운영진이 수동 지정(SQL/관리 화면, 이 세션
            # 범위 밖).
            ("is_tester",          "BOOLEAN NOT NULL DEFAULT FALSE"),
            ("participant_cohort", "TEXT"),
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
        # S6 — 'general'(일반) 추가(routing/cost.py USER_TYPES와 동일 목록 유지).
        _user_type_vals = "'manual_wheelchair','electric_wheelchair','walker','cane','leg_injury','elderly','general'"
        for tbl, name, definition in [
            ("routes",              "chk_route_mode", "CHECK (mode IN ('walk','transit','car','accessibility'))"),
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

        # chk_status는 위 루프와 달리 "없으면 추가"가 아니라 "있어도 정의를 갱신"해야
        # 한다 — 'completed_partial'(조기 종료) 값을 새로 허용해야 하므로, 매번
        # DROP 후 다시 ADD 한다(둘 다 IF EXISTS/그냥 재정의라 반복 실행해도 안전).
        conn.execute(text("ALTER TABLE routes DROP CONSTRAINT IF EXISTS chk_status"))
        conn.execute(text(
            "ALTER TABLE routes ADD CONSTRAINT chk_status "
            "CHECK (status IN ('in_progress','completed','completed_partial','abandoned'))"
        ))

        # chk_user_type도 동일 사유(값 목록이 늘 때 재정의 필요) — S6에서 'general' 추가.
        conn.execute(text("ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_user_type"))
        conn.execute(text(
            f"ALTER TABLE users ADD CONSTRAINT chk_user_type "
            f"CHECK (user_type IS NULL OR user_type IN ({_user_type_vals}))"
        ))

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
        # S3 — 행 방출 기준이 0.5% bin 변화 → 고정거리(25m)로 바뀌면서 slope_bin을
        # 더 이상 FE가 안 채운다(학습 시점에 slope_mean으로 계산) — nullable로 완화.
        # 기존 행(slope_bin 있음)은 그대로 남고, 새 행은 NULL + slope_mean/slope_max로 대체.
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ALTER COLUMN slope_bin DROP NOT NULL"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS slope_mean DOUBLE PRECISION"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS slope_max DOUBLE PRECISION"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS ascent_m DOUBLE PRECISION"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS descent_m DOUBLE PRECISION"
        ))
        # S2(stopClassifier) 집계 — D(navigation_measurements)와 동일 컬럼 세트.
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS step_delta INT"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS stop_class TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS dwell_ms BIGINT"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS moving_ms BIGINT"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS avg_gps_accuracy DOUBLE PRECISION"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS device_model TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS near_crossing BOOLEAN"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS facility BOOLEAN"
        ))
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS valid BOOLEAN"
        ))
        # S6 — slope 0/NULL/교량 구분('dem'|'bridge_zero'|'missing', routing/graph.py
        # 참고). 구버전 FE가 보낸 행은 NULL로 남는다(단정 못 함 — 값을 소급 추정하지 않음).
        conn.execute(text(
            "ALTER TABLE trip_slope_observations ADD COLUMN IF NOT EXISTS slope_source TEXT"
        ))

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

        # 신호 D 구 설계(구간 주관 평가, -1/0/+1)의 잔재 — 화면 자체가
        # SlowSegmentFeedbackScreen(segment_hardship_feedback 테이블)으로 대체된 지
        # 오래고, FE의 유일한 작성 경로(CollectSession.addSegmentFeedback)를 호출하는
        # 곳이 어디에도 없어 실질적으로 죽은 테이블이었다(실측: 0행). 같은 이름의
        # verdict 컬럼이 segment_hardship_feedback에도 새로 생기면서(아래) "verdict가
        # 두 테이블에 있는데 뭐가 진짜냐"는 혼동을 막기 위해 정리한다.
        conn.execute(text("DROP TABLE IF EXISTS segment_feedback CASCADE"))

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

        # S6 — route_kind는 지금까지 컬럼만 있고 어디서도 채워진 적이 없었다(전수
        # grep 확인). sessions.phase와 동일한 3값 — 그 세션이 학습/비교/자유
        # 이용 중 무엇이었는지를 라우트 단위로도 남긴다(trip_slope_observations는
        # session_id 없이 route_id만으로도 조회하는 경로가 있어, 세션 조인 없이
        # 바로 필터링하려면 route 쪽에도 있어야 함). 기존 행(전부 NULL)은 'free'로
        # 채우고 NOT NULL을 건다 — 과거 데이터는 전부 파일럿 이전 일반 이용이었다.
        conn.execute(text(
            "ALTER TABLE routes ADD COLUMN IF NOT EXISTS route_kind TEXT"
        ))
        conn.execute(text(
            "UPDATE routes SET route_kind = 'free' WHERE route_kind IS NULL"
        ))
        conn.execute(text(
            "ALTER TABLE routes ALTER COLUMN route_kind SET DEFAULT 'free'"
        ))
        conn.execute(text(
            "ALTER TABLE routes ALTER COLUMN route_kind SET NOT NULL"
        ))
        conn.execute(text("ALTER TABLE routes DROP CONSTRAINT IF EXISTS chk_route_kind"))
        conn.execute(text(
            "ALTER TABLE routes ADD CONSTRAINT chk_route_kind "
            "CHECK (route_kind IN ('learning','comparison','free'))"
        ))
        # S6 — 모델 롤아웃 추적(S10/S12에서 사용). 파일럿 전엔 전부 NULL로 둔다
        # (아직 어떤 arm/버전도 배정하지 않음 — 값을 임의로 채우지 않는다).
        conn.execute(text(
            "ALTER TABLE routes ADD COLUMN IF NOT EXISTS model_arm TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE routes ADD COLUMN IF NOT EXISTS model_version TEXT"
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
        # S4 — 순위 5개 + 무작위 대조 2개, 제시 순서는 섞음. rank(PK)는 1~5=순위,
        # 6~7=대조로 계속 쓰고, 분석에 필요한 구분자만 새로 추가한다.
        conn.execute(text(
            "ALTER TABLE route_slow_segments ADD COLUMN IF NOT EXISTS asked_by TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE route_slow_segments ADD COLUMN IF NOT EXISTS question_order SMALLINT"
        ))
        conn.execute(text(
            "ALTER TABLE route_slow_segments ADD COLUMN IF NOT EXISTS rank_position SMALLINT"
        ))
        conn.execute(text(
            "ALTER TABLE route_slow_segments ADD COLUMN IF NOT EXISTS seed BIGINT"
        ))

        # 구간별 체감 난이도 응답. 2단계(불편했나요 예/아니오 → 1~10점)에서 1단계
        # 3버튼(편했어요/보통이었어요/힘들었어요, verdict -1/0/+1)으로 재설계 —
        # 이유 셋: ① was_uncomfortable=false가 "보통"과 "평지보다 편함"을 구분 못 해
        # s_u(g) 보정항이 음의 방향(더 편함)으로 갈 데이터를 아예 못 받는 커버리지
        # 구멍이었음(척도를 세밀하게 해도 안 풀림), ② 10점 척도는 명목상 해상도일
        # 뿐 훈련 안 된 응답자는 3~4단계에 몰리고 s_u(g)도 자유도가 가장 낮은
        # 보정항(매듭 3개 수준)이라 그 이상을 못 씀, ③ 지금 병목은 정밀도가 아니라
        # 응답률(segment_hardship_feedback 실측 1행) — 2단계 인터랙션(최대 탭 10회)을
        # 1단계(최대 5회)로 줄여 응답률을 올리는 게 우선. 평가 시점의 경사·소요시간
        # 스냅샷을 함께 박아 두는 것은 기존과 동일.
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
                verdict           SMALLINT NOT NULL,
                answered_at       TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (route_id, seg_index),
                CONSTRAINT chk_hardship_verdict
                    CHECK (verdict IN (-1, 0, 1))
            )
        """))
        conn.execute(text(
            "ALTER TABLE segment_hardship_feedback ADD COLUMN IF NOT EXISTS seg_index_end INT"
        ))
        # S4 — 이 응답이 순위 문항이었는지 무작위 대조였는지. "느린 구간만 물어봐서
        # 생기는 편향"을 모델에서 보정하려면 필수(순위 문항만 있으면 구분 불가).
        conn.execute(text(
            "ALTER TABLE segment_hardship_feedback ADD COLUMN IF NOT EXISTS asked_by TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE segment_hardship_feedback ADD COLUMN IF NOT EXISTS rank_position SMALLINT"
        ))
        # ── 구 스키마(was_uncomfortable/hardship_score) → verdict 마이그레이션 ──
        # 파일럿 시작 전이라 실 데이터가 1행뿐이라 비용이 사실상 0(2026-09-14
        # 확인: id=5, was_uncomfortable=false → verdict=0으로 이관). 컬럼 존재
        # 여부로 감싸서 여러 번 재기동해도 안전(첫 실행에만 실제로 동작).
        conn.execute(text("""
            DO $$ BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'segment_hardship_feedback' AND column_name = 'was_uncomfortable'
                ) THEN
                    ALTER TABLE segment_hardship_feedback ADD COLUMN IF NOT EXISTS verdict SMALLINT;
                    UPDATE segment_hardship_feedback
                        SET verdict = CASE WHEN was_uncomfortable THEN -1 ELSE 0 END
                        WHERE verdict IS NULL;
                    ALTER TABLE segment_hardship_feedback DROP CONSTRAINT IF EXISTS chk_hardship_consistency;
                    ALTER TABLE segment_hardship_feedback DROP CONSTRAINT IF EXISTS chk_hardship_score;
                    ALTER TABLE segment_hardship_feedback DROP COLUMN was_uncomfortable;
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'segment_hardship_feedback' AND column_name = 'hardship_score'
                ) THEN
                    ALTER TABLE segment_hardship_feedback DROP COLUMN hardship_score;
                END IF;
                ALTER TABLE segment_hardship_feedback ALTER COLUMN verdict SET NOT NULL;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'chk_hardship_verdict' AND conrelid = 'segment_hardship_feedback'::regclass
                ) THEN
                    ALTER TABLE segment_hardship_feedback
                        ADD CONSTRAINT chk_hardship_verdict CHECK (verdict IN (-1, 0, 1));
                END IF;
            END $$
        """))
        conn.execute(text("DROP INDEX IF EXISTS idx_seg_hardship_analysis"))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_seg_hardship_analysis
            ON segment_hardship_feedback (slope_pct, pace_s_per_m, verdict)
        """))

        # S5 — "가장 힘들었던 구간" 문항. 3버튼(segment_hardship_feedback) 흐름을
        # 마친 뒤, 같은 구간 목록에서 하나를 고르거나 "비슷했어요"를 고른다.
        # route_id당 1회(재응답은 upsert) — 문항 자체가 "그 경로에서 딱 하나"를
        # 묻는 것이라 구간별 행이 아니라 경로별 행 하나.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS segment_hardest_pick (
                id                 SERIAL PRIMARY KEY,
                uid                TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                route_id           INT  NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
                session_id         TEXT,
                shown_seg_indices  INT[] NOT NULL,
                picked_seg_index   INT,
                picked_none        BOOLEAN NOT NULL DEFAULT FALSE,
                answered_at        TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (route_id),
                CONSTRAINT chk_hardest_pick_consistency
                    CHECK (
                        (picked_none = TRUE AND picked_seg_index IS NULL) OR
                        (picked_none = FALSE AND picked_seg_index IS NOT NULL)
                    )
            )
        """))

        # ── 측정 파이프라인 v2 (Supabase 콘솔에서 먼저 생성·검증한 스키마를 그대로
        # 반영 — 이 프로젝트에서 라이브 DB 제약과 init_db()가 어긋난 전례가 있어
        # 신규 테이블도 항상 여기 동기화한다) ──────────────────────────────────

        # 측정 세션 — 안내 1회 = 세션 1개. session_id는 FE가 발급(기존
        # CollectSession과 동일 포맷)해서 /navigation/start 요청에 실어 보낸다.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id   TEXT PRIMARY KEY,
                uid          TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                user_type    TEXT NOT NULL,
                started_at   TIMESTAMPTZ NOT NULL,
                ended_at     TIMESTAMPTZ,
                end_reason   TEXT,
                app_version  TEXT NOT NULL,
                schema_ver   INT NOT NULL
            )
        """))
        # S0 보완 — GPS 정확도 fallback(BestForNavigation→High→Balanced) 중
        # 첫 픽스를 받은 단계와 소요시간. 진단용 — "이 세션이 어느 정확도로
        # 시작됐는지" 분석 시 구분하는 용도(personalization-data-collection-plan
        # 밖, 신호 A~D 학습에는 쓰지 않음).
        conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS gps_fix_stage TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS gps_fix_ms INT"
        ))
        # S6 — 파일럿 걷기 종류 구분. phase 기본값 'free'(기존 일반 이용과 완전히
        # 동일 동작 유지 — 학습/비교 보행은 S9에서 FE가 명시적으로 지정해야 나옴).
        # comparison_pair_id: 같은 OD를 두 유형/모델로 비교하는 짝(S9) 식별자.
        # walk_order: 그 짝 안에서 몇 번째로 걸었는지(1|2) — 순서효과 분석용.
        conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'free'"
        ))
        conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS comparison_pair_id TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS walk_order INT"
        ))
        conn.execute(text("ALTER TABLE sessions DROP CONSTRAINT IF EXISTS chk_session_phase"))
        conn.execute(text(
            "ALTER TABLE sessions ADD CONSTRAINT chk_session_phase "
            "CHECK (phase IN ('learning','comparison','free'))"
        ))

        # 구간(측정 단위, routing/measurement_units.py) 별 실측/스킵 기록.
        # 기존 navigation_segments를 대체하지 않는다 — navigation_segments는
        # 마이페이지 표시용으로 그대로 유지, 이 테이블은 분석용 신뢰 데이터.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS navigation_measurements (
                id             BIGSERIAL PRIMARY KEY,
                route_id       INT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
                session_id     TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                unit_index     INT NOT NULL,
                distance_m     DOUBLE PRECISION NOT NULL,
                slope_pct      DOUBLE PRECISION NOT NULL,
                elapsed_ms     BIGINT,
                status         TEXT NOT NULL,
                gps_sample_n   INT DEFAULT 0,
                submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (route_id, unit_index),
                CONSTRAINT chk_nav_measurement_status
                    CHECK (status IN ('measured', 'skipped', 'in_progress'))
            )
        """))
        # coord_start_idx/coord_end_idx — /route 응답의 measurement_units[i].
        # coord_start_idx/coord_end_idx(경로 좌표 배열 인덱스)를 그대로 저장한다.
        # gps_traces(원본 GPS 점)를 경로에 사후 투영해 소요시간을 재계산하려면
        # unit이 경로상 어디였는지가 필요한데, 실시간 임계값 판정(15m 반경)만으론
        # 이 위치 정보가 DB에 안 남는다. session_route_profile로 역산하는 방식은
        # (a) 동의 세션에만 있고 (b) build_measurement_units의 흡수 규칙이 나중에
        # 바뀌면 과거 데이터 해석이 깨지므로, 제출 시점에 직접 저장한다.
        # nullable — 이 컬럼 추가 이전에 쌓인 행과 호환.
        conn.execute(text(
            "ALTER TABLE navigation_measurements ADD COLUMN IF NOT EXISTS coord_start_idx INT"
        ))
        conn.execute(text(
            "ALTER TABLE navigation_measurements ADD COLUMN IF NOT EXISTS coord_end_idx INT"
        ))
        # start/end 위/경도 — RouteDetailScreen "구간 설문조사"(나중에 평가)가
        # 이 구간이 지도에서 어디인지 그려야 하는데, coord_start_idx/coord_end_idx는
        # /route 응답의 좌표 배열 인덱스일 뿐 그 배열 자체를 저장해 두지 않아서
        # 나중엔 역참조가 안 된다(routes.route_geom도 현재 아무 데서도 채우지
        # 않음). 그래서 제출 시점에 실제 좌표를 직접 같이 저장한다 — FE가
        # measurement_units[i].start_coords/end_coords를 이미 갖고 있어 비용이
        # 거의 없다. nullable — 이 컬럼 추가 이전 행과 호환.
        for col in ("start_lat", "start_lon", "end_lat", "end_lon"):
            conn.execute(text(
                f"ALTER TABLE navigation_measurements ADD COLUMN IF NOT EXISTS {col} DOUBLE PRECISION"
            ))

        # S2(stopClassifier) 집계 결과 — utils/stopClassifier.ts의 aggregateRow()가
        # FE에서 계산해 그대로 보낸다(판정 로직은 FE/BE 어디서도 중복 구현하지
        # 않음 — 신호 A 행이 생기면 그쪽도 같은 FE 함수를 재사용해야 함, S3).
        # valid=false는 삭제가 아니라 플래그(학습 시점에 걸러내는 용도, P0-2와
        # 동일 원칙). 전부 nullable — 이 컬럼 추가 이전 행과 호환.
        conn.execute(text(
            "ALTER TABLE navigation_measurements ADD COLUMN IF NOT EXISTS valid BOOLEAN"
        ))
        conn.execute(text(
            "ALTER TABLE navigation_measurements ADD COLUMN IF NOT EXISTS dwell_ms BIGINT"
        ))
        conn.execute(text(
            "ALTER TABLE navigation_measurements ADD COLUMN IF NOT EXISTS moving_ms BIGINT"
        ))
        conn.execute(text(
            "ALTER TABLE navigation_measurements ADD COLUMN IF NOT EXISTS facility BOOLEAN"
        ))
        conn.execute(text(
            "ALTER TABLE navigation_measurements ADD COLUMN IF NOT EXISTS stop_class TEXT"
        ))
        conn.execute(text(
            "ALTER TABLE navigation_measurements ADD COLUMN IF NOT EXISTS near_crossing BOOLEAN"
        ))
        # stop_class 값 검증은 status와 같은 방식으로 API 계층(app.py)에서 한다 —
        # CHECK 제약을 서버 재기동마다 DROP+ADD 하는 건 컬럼 추가보다 무거워서
        # (동시 연결 중 잠깐 제약이 없는 창이 생김) 피한다.

        # GPS 원본 궤적 — /collect/gps-batch 배치 삽입.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS gps_traces (
                session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                seq         INT NOT NULL,
                t_ms        BIGINT NOT NULL,
                lat         DOUBLE PRECISION NOT NULL,
                lon         DOUBLE PRECISION NOT NULL,
                accuracy_m  REAL,
                speed_mps   REAL,
                PRIMARY KEY (session_id, seq)
            )
        """))

        # /collect/gps-batch 수신 로그 — collect_batch_log와 동일한 멱등 패턴.
        # ⚠️ 정확한 컬럼 목록을 Supabase 콘솔 실제 스키마와 대조 확인 필요.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS gps_batch_log (
                uid         TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
                session_id  TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                seq         INT  NOT NULL,
                received_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (uid, session_id, seq)
            )
        """))

        # S6 — 학습에 실제로 쓸 신호 A 행만 골라내는 뷰. 4개 조건 전부(AND):
        #   valid=TRUE(stopClassifier gps_gap/uncertain 제외), facility=FALSE
        #   (계단 등 시설 구간 제외 — slope 판정을 신뢰 못 함), is_tester=FALSE
        #   (팀 내부 테스트 계정 배제), participant_cohort IS NOT NULL(파일럿
        #   참가자로 등록된 사용자만), phase='learning'(학습 보행 세션만 — 비교/
        #   자유 이용 걸음은 다른 목적이라 섞으면 안 됨).
        # valid/facility가 NULL(구버전 FE 행)이면 안전하지 않다고 보고 제외한다
        # (거짓으로 단정하지 않음 — IS TRUE/IS FALSE는 NULL을 자동으로 걸러냄).
        conn.execute(text("""
            CREATE OR REPLACE VIEW learning_rows_v AS
            SELECT tso.*
            FROM trip_slope_observations tso
            JOIN sessions s ON s.session_id = tso.session_id
            JOIN users    u ON u.uid = tso.uid
            WHERE tso.valid IS TRUE
              AND tso.facility IS FALSE
              AND u.is_tester = FALSE
              AND u.participant_cohort IS NOT NULL
              AND s.phase = 'learning'
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
        WHERE r.uid = :uid AND r.status IN ('completed', 'completed_partial')
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
        WHERE r.uid = :uid AND r.status IN ('completed', 'completed_partial')
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


def start_session(
    db: Session,
    session_id: str,
    uid: str,
    user_type: str,
    app_version: str,
    schema_ver: int,
) -> bool:
    """측정 세션 시작 — sessions에 행 INSERT.

    session_id는 FE가 발급한다(기존 CollectSession과 동일한 포맷을 그대로 신뢰
    — BE는 생성하지 않는다). PK라 재시도로 같은 session_id가 다시 오면
    ON CONFLICT DO NOTHING으로 무시한다(재INSERT 시도 자체가 실패는 아님 —
    "이미 시작된 세션"이라는 뜻이라 에러로 취급하지 않는다).
    """
    if not engine:
        return False

    db.execute(text("""
        INSERT INTO sessions (session_id, uid, user_type, started_at, app_version, schema_ver)
        VALUES (:session_id, :uid, :user_type, NOW(), :app_version, :schema_ver)
        ON CONFLICT (session_id) DO NOTHING
    """), {
        "session_id":  session_id,
        "uid":         uid,
        "user_type":   user_type,
        "app_version": app_version,
        "schema_ver":  schema_ver,
    })
    db.commit()
    return True


_GPS_FIX_STAGES = {"best_nav", "high", "balanced", "none"}


def record_gps_fix_stage(db: Session, session_id: str, uid: str, stage: str, fix_ms: int) -> bool:
    """S0 보완 — GPS 정확도 fallback 중 첫 픽스를 받은 단계 기록. 세션 소유자
    확인 후 UPDATE(세션당 보통 1회 호출이라 upsert 불필요, 재호출은 덮어씀).
    """
    if not engine:
        return False
    if stage not in _GPS_FIX_STAGES:
        return False

    result = db.execute(text("""
        UPDATE sessions SET gps_fix_stage = :stage, gps_fix_ms = :fix_ms
        WHERE session_id = :session_id AND uid = :uid
    """), {"session_id": session_id, "uid": uid, "stage": stage, "fix_ms": fix_ms})
    db.commit()
    return result.rowcount > 0


def add_navigation_measurement(
    db: Session,
    route_id: int,
    uid: str,
    session_id: str,
    unit_index: int,
    distance_m: float,
    slope_pct: float,
    elapsed_ms: int | None,
    status: str,
    coord_start_idx: int | None = None,
    coord_end_idx: int | None = None,
    start_lat: float | None = None,
    start_lon: float | None = None,
    end_lat: float | None = None,
    end_lon: float | None = None,
    valid: bool | None = None,
    dwell_ms: int | None = None,
    moving_ms: int | None = None,
    facility: bool | None = None,
    stop_class: str | None = None,
    near_crossing: bool | None = None,
) -> bool:
    """구간(측정 단위) 완료/스킵 시 navigation_measurements에 행 삽입 — 멱등.

    UNIQUE(route_id, unit_index) + ON CONFLICT DO NOTHING: 같은 unit이 재전송돼도
    최초 제출만 남고 이후 제출은 조용히 무시된다(갱신하지 않음 — 재전송은
    "덮어쓰기 요청"이 아니라 "네트워크 재시도"로 간주).

    session_id는 sessions.uid와 route_id 소유자가 같은 uid인지까지 함께
    확인한다 — 존재하지 않거나(FK 위반이 아니라 아직 /navigation/start를
    안 거친 session_id) 다른 사용자 소유면 False.

    coord_start_idx/coord_end_idx: /route 응답 measurement_units[i]의 좌표 배열
    인덱스를 그대로 저장 — gps_traces를 경로에 사후 투영해 소요시간을 재계산할
    때 이 unit이 경로상 어디였는지 알아야 한다(구버전 FE는 안 보내 None으로
    남을 수 있음, nullable).
    """
    if not engine:
        return False

    owns = db.execute(text("""
        SELECT 1 FROM routes r
        JOIN sessions s ON s.session_id = :session_id
        WHERE r.id = :route_id AND r.uid = :uid AND r.status = 'in_progress'
          AND s.uid = :uid
    """), {"route_id": route_id, "uid": uid, "session_id": session_id}).fetchone()
    if not owns:
        return False

    db.execute(text("""
        INSERT INTO navigation_measurements
            (route_id, session_id, unit_index, distance_m, slope_pct, elapsed_ms, status,
             coord_start_idx, coord_end_idx, start_lat, start_lon, end_lat, end_lon,
             valid, dwell_ms, moving_ms, facility, stop_class, near_crossing)
        VALUES
            (:route_id, :session_id, :unit_index, :distance_m, :slope_pct, :elapsed_ms, :status,
             :coord_start_idx, :coord_end_idx, :start_lat, :start_lon, :end_lat, :end_lon,
             :valid, :dwell_ms, :moving_ms, :facility, :stop_class, :near_crossing)
        ON CONFLICT (route_id, unit_index) DO NOTHING
    """), {
        "route_id":        route_id,
        "session_id":      session_id,
        "unit_index":      unit_index,
        "distance_m":      distance_m,
        "slope_pct":       slope_pct,
        "elapsed_ms":      elapsed_ms,
        "status":          status,
        "coord_start_idx": coord_start_idx,
        "coord_end_idx":   coord_end_idx,
        "start_lat":       start_lat,
        "start_lon":       start_lon,
        "end_lat":         end_lat,
        "end_lon":         end_lon,
        "valid":           valid,
        "dwell_ms":        dwell_ms,
        "moving_ms":       moving_ms,
        "facility":        facility,
        "stop_class":      stop_class,
        "near_crossing":   near_crossing,
    })
    db.commit()
    return True


def save_gps_batch(db: Session, uid: str, session_id: str, points: list) -> int:
    """gps_traces에 GPS 원본 궤적 배치 삽입 + gps_batch_log에 수신 로그.

    (session_id, seq)가 gps_traces의 PK라 재전송돼도 중복 저장되지 않는다.
    gps_batch_log는 (uid, session_id, seq) PK — "이 포인트를 받은 적이 있다"는
    사실 자체를 실제 저장 성공 여부와 무관하게 남긴다(수집 건전성 점검용).
    session_id가 유효한 세션(해당 uid 소유)이 아니면 아무것도 쓰지 않고 0 반환.
    """
    if not engine or not points:
        return 0

    owns = db.execute(
        text("SELECT 1 FROM sessions WHERE session_id = :sid AND uid = :uid"),
        {"sid": session_id, "uid": uid},
    ).fetchone()
    if not owns:
        return 0

    saved = 0
    for p in points:
        result = db.execute(text("""
            INSERT INTO gps_traces (session_id, seq, t_ms, lat, lon, accuracy_m, speed_mps)
            VALUES (:session_id, :seq, :t_ms, :lat, :lon, :accuracy_m, :speed_mps)
            ON CONFLICT (session_id, seq) DO NOTHING
        """), {
            "session_id": session_id,
            "seq":        p["seq"],
            "t_ms":       p["t_ms"],
            "lat":        p["lat"],
            "lon":        p["lon"],
            "accuracy_m": p.get("accuracy_m"),
            "speed_mps":  p.get("speed_mps"),
        })
        saved += result.rowcount

        db.execute(text("""
            INSERT INTO gps_batch_log (uid, session_id, seq)
            VALUES (:uid, :session_id, :seq)
            ON CONFLICT (uid, session_id, seq) DO NOTHING
        """), {"uid": uid, "session_id": session_id, "seq": p["seq"]})

    db.commit()
    return saved


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
                (uid, route_id, session_id, user_type, distance_m, elapsed_ms, gps_sample_n,
                 slope_mean, slope_max, ascent_m, descent_m,
                 step_delta, stop_class, dwell_ms, moving_ms, avg_gps_accuracy,
                 device_model, near_crossing, facility, valid, slope_source)
            VALUES
                (:uid, :route_id, :session_id, :user_type, :distance_m, :elapsed_ms, :gps_sample_n,
                 :slope_mean, :slope_max, :ascent_m, :descent_m,
                 :step_delta, :stop_class, :dwell_ms, :moving_ms, :avg_gps_accuracy,
                 :device_model, :near_crossing, :facility, :valid, :slope_source)
        """), {
            "uid":          uid,
            "route_id":     obs.get("route_id"),
            "session_id":   session_id,
            "user_type":    user_type,
            "distance_m":   obs["distance_m"],
            "elapsed_ms":   obs["elapsed_ms"],
            "gps_sample_n": obs["gps_sample_n"],
            "slope_mean":   obs["slope_mean"],
            "slope_max":    obs.get("slope_max"),
            "ascent_m":     obs.get("ascent_m"),
            "descent_m":    obs.get("descent_m"),
            "step_delta":       obs.get("step_delta"),
            "stop_class":       obs.get("stop_class"),
            "dwell_ms":         obs.get("dwell_ms"),
            "moving_ms":        obs.get("moving_ms"),
            "avg_gps_accuracy": obs.get("avg_gps_accuracy"),
            "device_model":     obs.get("device_model"),
            "near_crossing":    obs.get("near_crossing"),
            "facility":         obs.get("facility"),
            "valid":            obs.get("valid"),
            "slope_source":     obs.get("slope_source"),
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
                obs.get("dwell_ms", 0) or 0,
            )
            if speed is None:
                continue
            zk = _zone_key_for_slope(float(obs["slope_mean"]), user_type)
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

    # segment_feedback 테이블은 삭제됐다(위 init_db 참고, 실질적으로 죽은
    # 신호였음 — FE가 이 필드를 채워 보낸 적이 없어 segment_feedback_in은 항상
    # 빈 배열이었다). 파라미터/응답 필드는 그대로 남겨 /collect/batch 요청
    # 바디 계약을 안 건드린다 — 그냥 아무 데도 쓰지 않고 개수만 되돌려준다.

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
    reached_destination: bool | None = None,
    session_id: str | None = None,
) -> dict | None:
    """안내 종료 — navigation_measurements 집계로 확정, routes.status 결정.

    total_duration_ms는 더 이상 FE가 보낸 값을 그대로 믿지 않는다(예전엔 FE의
    벽시계 총 경과시간을 그대로 저장했다 — 백그라운드 방치 등으로 부풀려질 수
    있었다). 대신 실제 GPS로 측정된(status='measured') unit들의 elapsed_ms 합을
    BE가 직접 계산한다. skipped/애초에 제출 안 된 unit은 elapsed_ms가 NULL이라
    SUM이 자동으로 건너뛴다 — 값을 지어내 채우지 않는다(클러스터 B 재발 방지).

    reached_destination:
      - True  → status='completed' (목적지까지 정상 도달)
      - False → status='completed_partial' (중간에 안내 종료 — 걸은 만큼만 기록.
                남은 unit은 아무 행도 만들지 않는다 — "안 지나간 것"과 "지나갔는데
                측정을 놓친 것(skipped)"은 의미가 다르므로 구분해서 비워 둔다)
      - None  → (구버전 FE 호환용 임시 fallback) 이 필드를 아직 안 보내는 동안은
                기존과 동일하게 'completed'로 처리한다. FE가 이 필드를 보내기
                시작하면 이 분기는 더 이상 타지 않아야 한다.

    session_id가 있으면 sessions.ended_at/end_reason도 함께 닫는다 — end_reason은
    routes.status와 동일한 값 체계('completed'/'completed_partial')를 그대로 쓴다
    (별도 어휘를 만들면 나중에 둘이 따로 놀 위험이 있어 하나로 통일). session_id가
    없거나(구버전 FE) 그 uid 소유가 아니면 조용히 건너뛴다 — routes 확정 자체를
    막을 이유는 아니다(세션 종료 기록은 부가 정보).
    """
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
            COALESCE(SUM(ABS(slope_pct) * distance_m) / NULLIF(SUM(distance_m), 0), 0),
            COALESCE(SUM(elapsed_ms), 0)
        FROM navigation_measurements
        WHERE route_id = :route_id
    """), {"route_id": route_id}).fetchone()

    total_length_m    = round(float(agg[0]), 1)
    avg_slope_pct     = round(float(agg[1]), 2)
    total_duration_ms = int(agg[2])
    status = "completed_partial" if reached_destination is False else "completed"

    db.execute(text("""
        UPDATE routes
        SET total_length_m    = :total_length_m,
            avg_slope_pct     = :avg_slope_pct,
            total_duration_ms = :total_duration_ms,
            status            = :status
        WHERE id = :id AND uid = :uid
    """), {
        "id":                route_id,
        "uid":               uid,
        "total_length_m":    total_length_m,
        "avg_slope_pct":     avg_slope_pct,
        "total_duration_ms": total_duration_ms,
        "status":            status,
    })

    if session_id:
        db.execute(text("""
            UPDATE sessions
            SET ended_at = NOW(), end_reason = :status
            WHERE session_id = :session_id AND uid = :uid
        """), {"session_id": session_id, "uid": uid, "status": status})

    # pace(1m당 소요시간) 상위 구간을 지금(종료 시점) 미리 계산해 캐시에 저장 —
    # 안내 종료 직후 FE 가 /navigation/{id}/slow-segments 로 바로 읽어간다.
    # (이 랭킹은 legacy navigation_segments 기반 — 범위 밖, 손대지 않음)
    ranked = _rank_and_store_slow_segments(db, route_id)
    db.commit()

    return {
        "route_id":          route_id,
        "status":            status,
        "total_length_m":    total_length_m,
        "avg_slope_pct":     avg_slope_pct,
        "total_duration_ms": total_duration_ms,
        "slow_segments_ranked": ranked,
    }


# ── 구간 체감 난이도 평가 (⑭' — 1m당 소요시간 pace 기준) ─────────────────────
# navigation_measurements(routing/measurement_units.py, ≥30m 단위) 기준으로
# pace 상위 구간을 골라 랭킹한다. 레거시 navigation_segments(엣지 단위, ~5~10m)는
# 더 이상 이 랭킹의 소스가 아니다 — measurement_units는 이미 GPS 판정 가능한
# 크기로 묶여 있어 옛 _same_slope_band 같은 재병합이 필요 없다(그 로직은 제거).
# ⚠️ 이 전환으로 navigation_measurements 행이 없는 구버전(마이그레이션 이전) 경로는
# 재계산 시 "평가할 구간 없음"으로 나온다 — 소급 재구성하지 않는다(모르는 데이터를
# 지어내지 않는다는 이 파이프라인 전체 원칙과 동일).
#
# 2026-09 설계 확장(기술적 완화 아님, 의도적 범위 확장): 예전엔 _slow_seg_eligible이
# abs(slope_pct) < FLAT_THRESHOLD 구간을 전부 제외했다 — "경사로 인한 숨은 부담
# 포착"이 D 신호의 유일한 목적이었기 때문. 그런데 이 앱의 가장 흔한 실사용
# 패턴(도보 30분 넘으면 대중교통으로 대체됨 → 실제로 걷는 경로는 대부분 짧고
# 완만함)에서는 이 필터가 측정된 구간을 통째로 걸러내 설문 자체가 거의 안 뜨는
# 결과를 낳았다(예: route 176 — measured 7개 전부 slope 0~0.29%로 필터에 전부
# 탈락). 그래서 D 신호의 목적을 "경사로 인한 부담 포착"에서 "구간 체감에 대한
# 일반 피드백 수집(경사 여부 무관)"으로 넓힌다 — 평지 구간의 "편했어요" 응답도
# 이제 유의미하다(나중에 "완만한 오르막이 평지 대비 얼마나 불편한가"를 비교할
# baseline이 된다). 순위 기준(pace_s_per_m 내림차순)은 애초에 경사가 아니라
# 속도 기준이었으므로 그대로 둔다 — 완전 평지 route에서도 "그나마 상대적으로
# 느렸던 구간"을 자연히 뽑아준다. 유효 구간이 1~4개뿐이면 그만큼만(SLOW_SEG_MAX_RANKED는
# 상한일 뿐 하한이 아님) 물어본다 — 이것도 정렬 후 슬라이스로 이미 자연히 동작한다.
SLOW_SEG_MIN_DIST_M = 25.0   # 구간이 이보다 짧으면 제외 (pickFeedbackSegments 와 동일)
SLOW_SEG_MAX_RANKED = 5      # 상위 몇 구간까지 물어볼지 — 파일럿 참가자 수·구간 밀도
                             # 보면서 조정할 값이라 코드 상수로 뺐다(재배포로 조정,
                             # DB 설정 테이블화는 불필요 — 실시간 변경 요구 없음).
                             # 유효 구간이 이보다 적으면 그 전부를 질문 대상으로 삼는다
                             # (아래 정렬 후 슬라이스가 자연히 그렇게 동작함).
SLOW_SEG_SPEED_MIN  = 0.05   # m/s — 거리/시간 이 범위 밖이면 GPS 점프/정지 이상치
SLOW_SEG_SPEED_MAX  = 2.50   # (routing/speed.py _SPEED_MIN/_MAX 와 동일)
SLOW_SEG_RANDOM = 2          # S4 — 순위 미포함 유효 단위에서 뽑는 무작위 대조 문항 수

_SLOW_SEG_SELECT = """
    SELECT rank, seg_index, seg_index_end, distance_m, slope_pct, direction, zone,
           name, elapsed_ms, pace_s_per_m, asked_by, question_order, rank_position
    FROM route_slow_segments
    WHERE route_id = :rid
    ORDER BY question_order
"""


def _route_measurement_groups(db: Session, route_id: int) -> list[dict]:
    """
    navigation_measurements → 피드백 질문 후보 목록. 각 행이 이미 하나의 "구간"
    (MeasurementUnit, ≥30m)이라 레거시 _route_segment_groups처럼 인접 엣지를
    다시 밴드로 묶을 필요가 없다 — status='measured'(실측) 행만 그대로 쓴다.
    skipped/미제출 unit은 elapsed_ms가 없어 pace를 낼 수 없으므로 제외한다.

    seg_index/seg_index_end에는 둘 다 unit_index를 넣는다 — route_slow_segments/
    segment_hardship_feedback 테이블을 새로 만들지 않고 재사용하기 위함으로,
    레거시(엣지 범위) 때와 달리 항상 start==end(병합 구간이 아닌 단일 unit)다.
    zone/name은 navigation_measurements에 없는 정보라 zone은 slope로 다시
    분류하고 name은 빈 값으로 둔다(지어내지 않음 — street name은 알 수 없음).
    """
    rows = db.execute(text("""
        SELECT unit_index, distance_m, slope_pct, elapsed_ms, moving_ms, valid, facility
        FROM navigation_measurements
        WHERE route_id = :rid AND status = 'measured'
        ORDER BY unit_index ASC
    """), {"rid": route_id}).fetchall()

    groups = []
    for unit_index, dist, slope, elapsed, moving_ms, valid, facility in rows:
        dist    = float(dist or 0.0)
        elapsed = int(elapsed or 0)
        slope   = 0.0 if slope is None else float(slope)
        if dist <= 0 or elapsed <= 0:
            continue
        # S4 — 랭킹 대상은 valid=true AND facility=false만(스펙 고정). S2가 채운
        # 값이라 구버전 행(이 컬럼 도입 전)은 valid가 NULL → 여기서 자연히 제외된다.
        moving = int(moving_ms) if moving_ms is not None else elapsed
        direction = "flat" if abs(slope) < FLAT_THRESHOLD else ("up" if slope > 0 else "down")
        groups.append({
            "seg_index":     int(unit_index),
            "seg_index_end": int(unit_index),
            "distance_m":    dist,
            "elapsed_ms":    elapsed,
            "moving_ms":     moving,
            "valid":         bool(valid) if valid is not None else False,
            "facility":      bool(facility) if facility is not None else False,
            "slope_pct":     slope,
            "direction":     direction,
            "zone":          None,   # 랭킹 후 최종 선정된 것만 classify_zone으로 채움
            "name":          "",
            "pace_s_per_m":  round((moving / 1000.0) / dist, 4) if moving > 0 else None,
        })
    return groups


def _slow_seg_eligible(g: dict) -> bool:
    """랭킹/대조 대상 구간인지 — S4: valid=true AND facility=false만(경사 유무는
    필터 아님, 2026-09 설계 확장). 그 위에 충분한 길이·현실적인 이동속도(GPS
    이상치 배제)까지 확인한다. moving_ms 기반 pace라 이동시간이 0이면(전부
    정지) pace를 못 내 여기서 걸러진다.
    """
    if not g["valid"] or g["facility"]:
        return False
    d, moving, pace = g["distance_m"], g["moving_ms"], g["pace_s_per_m"]
    if d < SLOW_SEG_MIN_DIST_M or moving <= 0 or pace is None:
        return False
    spd = d / (moving / 1000.0)
    return SLOW_SEG_SPEED_MIN < spd < SLOW_SEG_SPEED_MAX


def _rank_and_store_slow_segments(db: Session, route_id: int, seed: int | None = None) -> int:
    """
    navigation_measurements → 이동 pace(moving_ms 기준, 정지시간 제외) 큰 순으로
    상위 SLOW_SEG_MAX_RANKED 구간 + 무작위 대조 SLOW_SEG_RANDOM 구간을
    route_slow_segments 에 저장한다(S4). 정렬: pace 내림차순 → 거리 큰 순 →
    unit_index 오름차순. 대조는 순위에 안 든 유효 단위 중 무작위(seed 고정,
    재현 가능) — 유효 단위가 부족하면 있는 만큼만(하한 아님). 제시 순서
    (question_order)는 순위/대조를 섞은 무작위 순서, 버튼 순서는 항상 고정이라
    이 순서와 무관. 커밋은 호출측 책임.
    """
    if seed is None:
        seed = random.SystemRandom().getrandbits(31)
    rng = random.Random(seed)

    eligible = [g for g in _route_measurement_groups(db, route_id) if _slow_seg_eligible(g)]
    ranked = sorted(
        eligible,
        key=lambda g: (-g["pace_s_per_m"], -g["distance_m"], g["seg_index"]),
    )[:SLOW_SEG_MAX_RANKED]
    ranked_idx = {g["seg_index"] for g in ranked}

    remaining = [g for g in eligible if g["seg_index"] not in ranked_idx]
    rng.shuffle(remaining)
    control = remaining[:SLOW_SEG_RANDOM]

    db.execute(text("DELETE FROM route_slow_segments WHERE route_id = :rid"),
               {"rid": route_id})

    selected = [(g, "rank", i + 1) for i, g in enumerate(ranked)] + \
               [(g, "random", None) for g in control]
    if not selected:
        return 0

    # 제시 순서 — 순위/대조를 구분 못 하게 섞는다(같은 seed로 재현 가능).
    order = list(range(1, len(selected) + 1))
    rng.shuffle(order)

    user_type_row = db.execute(
        text("SELECT user_type FROM routes WHERE id = :rid"), {"rid": route_id}
    ).fetchone()
    user_type = (user_type_row[0] if user_type_row and user_type_row[0] else "elderly")

    for i, (g, asked_by, rank_position) in enumerate(selected):
        db_rank = i + 1  # route_slow_segments PK(route_id, rank) — 1..5=순위, 6..7=대조
        zone = classify_zone(g["slope_pct"], g["direction"], user_type)
        db.execute(text("""
            INSERT INTO route_slow_segments
                (route_id, rank, seg_index, seg_index_end, distance_m, slope_pct,
                 direction, zone, name, elapsed_ms, pace_s_per_m,
                 asked_by, question_order, rank_position, seed)
            VALUES
                (:rid, :rank, :seg_index, :seg_index_end, :distance_m, :slope_pct,
                 :direction, :zone, :name, :elapsed_ms, :pace,
                 :asked_by, :question_order, :rank_position, :seed)
        """), {
            "rid": route_id, "rank": db_rank,
            "seg_index": g["seg_index"], "seg_index_end": g["seg_index_end"],
            "distance_m": round(g["distance_m"], 1), "slope_pct": g["slope_pct"],
            "direction": g["direction"], "zone": zone,
            "name": g["name"] or None,
            "elapsed_ms": g["elapsed_ms"], "pace": g["pace_s_per_m"],
            "asked_by": asked_by, "question_order": order[i], "rank_position": rank_position,
            "seed": seed,
        })
    return len(selected)


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

    # meta 는 navigation_measurements 구간(unit) 기준으로 센다. eligible_groups는
    # 예전엔 "경사 있는 구간 수"였지만(2026-09 설계 확장 이후) 지금은 "GPS
    # 이상치를 뺀, 질문 후보가 될 수 있는 구간 수"를 뜻한다 — 경사 무관.
    groups          = _route_measurement_groups(db, route_id)
    total_groups    = len(groups)
    eligible_groups = sum(1 for g in groups if _slow_seg_eligible(g))

    rows = db.execute(text(_SLOW_SEG_SELECT), {"rid": route_id}).fetchall()
    if not rows:
        # 미리 계산 결과가 없으면 즉석 계산 후 저장 (폴백)
        _rank_and_store_slow_segments(db, route_id)
        db.commit()
        rows = db.execute(text(_SLOW_SEG_SELECT), {"rid": route_id}).fetchall()

    segments = [{
        "rank":           int(r[0]),
        "seg_index":      int(r[1]),
        "seg_index_end":  int(r[2]) if r[2] is not None else int(r[1]),
        "distance_m":     round(float(r[3]), 1),
        "slope_pct":      round(float(r[4]), 2),
        "direction":      r[5],
        "zone":           r[6],
        "name":           r[7],
        "elapsed_ms":     int(r[8]),
        "pace_s_per_m":   round(float(r[9]), 3),
        "asked_by":       r[10],
        "question_order": int(r[11]) if r[11] is not None else int(r[0]),
        "rank_position":  int(r[12]) if r[12] is not None else None,
    } for r in rows]

    ranked_count = sum(1 for s in segments if s["asked_by"] == "rank")
    random_count = sum(1 for s in segments if s["asked_by"] == "random")
    meta = {
        "total_segments":    total_groups,       # 경로를 묶었을 때의 구간 수
        "eligible_segments": eligible_groups,    # 그중 질문 후보인 구간 수(valid AND NOT facility, GPS 이상치 제외)
        "ranked":            ranked_count,        # 순위 문항 수 (min(SLOW_SEG_MAX_RANKED, eligible))
        "random_asked":      random_count,        # 무작위 대조 문항 수 (min(SLOW_SEG_RANDOM, 남은 유효 단위))
        # S4 — 목표(5+2=7)에 못 미치면(유효 단위 부족) 그 차이를 보고 필드로 노출.
        "target_total":      SLOW_SEG_MAX_RANKED + SLOW_SEG_RANDOM,
        "asked_total":       len(segments),
    }

    if not segments:
        if status == "in_progress" and total_groups == 0:
            reason = "route_not_completed"
        elif total_groups == 0:
            reason = "no_measured_segments"
        else:
            # 경사 필터가 없어진 뒤(위 2026-09 설계 확장) 이 분기는 사실상 전부
            # GPS 이상치(SLOW_SEG_SPEED_MIN/MAX 밖)로 제외된 극단 케이스만 남는다.
            reason = "no_eligible_segments"
        return {"eligible": False, "reason": reason, "route_id": route_id,
                "segments": [], "meta": meta}

    return {"eligible": True, "route_id": route_id, "segments": segments, "meta": meta}


def get_route_measurements(db: Session, route_id: int, uid: str) -> dict | None:
    """RouteDetailScreen 용 — navigation_measurements(BE 실측, 신뢰 소스)를 그대로 반환.
    소유자가 아니거나 경로가 없으면 None(호출측이 404) — get_slow_segments와 동일 패턴.

    status='measured' 행만 돌려준다 — 'skipped'는 elapsed_ms가 없어 화면에 보여줄
    소요시간이 없고, FE 로컬(measuredMsRef) 쪽도 이미 미측정 구간은 저장하지 않는
    동일한 "모아진 것만 남긴다" 원칙을 쓰고 있다(§ navigation_measurements 설계 메모).
    """
    if not engine:
        return None

    owns = db.execute(
        text("SELECT status FROM routes WHERE id = :id AND uid = :uid"),
        {"id": route_id, "uid": uid},
    ).fetchone()
    if not owns:
        return None

    rows = db.execute(text("""
        SELECT unit_index, distance_m, slope_pct, elapsed_ms,
               start_lat, start_lon, end_lat, end_lon
        FROM navigation_measurements
        WHERE route_id = :rid AND status = 'measured'
        ORDER BY unit_index ASC
    """), {"rid": route_id}).fetchall()

    def _coords(lat, lon):
        # [lon, lat] — FE MeasurementUnit.start_coords/end_coords와 동일한
        # GeoJSON 순서. 이 컬럼 추가 이전에 쌓인 행은 None(지도 없이 폴백).
        return [float(lon), float(lat)] if lat is not None and lon is not None else None

    segments = [{
        "index":        int(r[0]),
        "distance_m":   round(float(r[1]), 1),
        "slope_pct":    round(float(r[2]), 2),
        "elapsed_ms":   int(r[3]),
        "start_coords": _coords(r[4], r[5]),
        "end_coords":   _coords(r[6], r[7]),
    } for r in rows]

    return {"route_id": route_id, "segments": segments}


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
    zone, verdict(-1 힘들었어요 / 0 보통이었어요 / +1 편했어요, 1단계 3버튼).
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
        verdict = int(a["verdict"])
        if verdict not in (-1, 0, 1):
            raise ValueError(f"seg_index={a.get('seg_index')}: verdict는 -1/0/1이어야 합니다")

        seg_end = a.get("seg_index_end")
        seg_end = int(seg_end) if seg_end is not None else None

        rank_position = a.get("rank_position")
        rank_position = int(rank_position) if rank_position is not None else None

        db.execute(text("""
            INSERT INTO segment_hardship_feedback
                (uid, route_id, session_id, seg_index, seg_index_end, rank, pace_s_per_m,
                 elapsed_ms, distance_m, slope_pct, zone, verdict, asked_by, rank_position)
            VALUES
                (:uid, :route_id, :session_id, :seg_index, :seg_end, :rank, :pace,
                 :elapsed_ms, :distance_m, :slope_pct, :zone, :verdict, :asked_by, :rank_position)
            ON CONFLICT (route_id, seg_index) DO UPDATE SET
                session_id    = EXCLUDED.session_id,
                seg_index_end = EXCLUDED.seg_index_end,
                rank          = EXCLUDED.rank,
                pace_s_per_m  = EXCLUDED.pace_s_per_m,
                elapsed_ms    = EXCLUDED.elapsed_ms,
                distance_m    = EXCLUDED.distance_m,
                slope_pct     = EXCLUDED.slope_pct,
                zone          = EXCLUDED.zone,
                verdict       = EXCLUDED.verdict,
                asked_by      = EXCLUDED.asked_by,
                rank_position = EXCLUDED.rank_position,
                answered_at   = NOW()
        """), {
            "uid": uid, "route_id": route_id, "session_id": session_id,
            "seg_index": int(a["seg_index"]), "seg_end": seg_end, "rank": int(a["rank"]),
            "pace": float(a["pace_s_per_m"]), "elapsed_ms": int(a["elapsed_ms"]),
            "distance_m": float(a["distance_m"]), "slope_pct": float(a["slope_pct"]),
            "zone": a.get("zone"), "verdict": verdict,
            "asked_by": a.get("asked_by"), "rank_position": rank_position,
        })
        count += 1

    db.commit()
    return {"ok": True, "count": count}


def get_segment_hardship_feedback(db: Session, route_id: int, uid: str) -> dict | None:
    """이 경로에서 사용자가 실제로 답한 D 신호(주관 평가) 응답 목록.
    RouteDetailScreen이 객관 경사 분류(getSlopeEffort)와 나란히 보여줄 때 쓴다.
    seg_index는 unit_index다 — navigation_measurements 기준(서버 소스)
    RouteDetailScreen에만 안전하게 매칭된다. 로컬 폴백(routeSegments raw edge
    인덱스)에는 이 인덱스 체계가 안 맞으니 FE가 dataSource==='server'일 때만
    써야 한다(같은 종류의 인덱스 불일치를 이미 measurementUnits 쪽에서 한 번
    겪었음). 소유자가 아니거나 경로가 없으면 None(호출측이 404)."""
    if not engine:
        return None

    owns = db.execute(
        text("SELECT 1 FROM routes WHERE id = :id AND uid = :uid"),
        {"id": route_id, "uid": uid},
    ).fetchone()
    if not owns:
        return None

    rows = db.execute(text("""
        SELECT seg_index, seg_index_end, verdict
        FROM segment_hardship_feedback
        WHERE route_id = :rid
        ORDER BY seg_index ASC
    """), {"rid": route_id}).fetchall()

    answers = [{
        "seg_index":     int(r[0]),
        "seg_index_end": int(r[1]) if r[1] is not None else int(r[0]),
        "verdict":       int(r[2]),
    } for r in rows]

    return {"route_id": route_id, "answers": answers}


def save_segment_hardest_pick(
    db: Session,
    route_id: int,
    uid: str,
    session_id: str | None,
    shown_seg_indices: list[int],
    picked_seg_index: int | None,
    picked_none: bool,
) -> dict | None:
    """S5 — "가장 힘들었던 구간" 응답 저장(route_id당 1행, upsert). 3버튼 흐름
    (segment_hardship_feedback)과 별개 엔드포인트로 분리했다 — 문항 성격이
    "구간마다 1개씩"이 아니라 "이 경로 전체에서 1개"라 저장 단위 자체가
    다르고, 3버튼 제출이 이미 끝난 뒤에만 보여줄 화면이라 순서 의존성만
    지키면 되지 원자적으로 묶어야 할 이유가 없다(둘 다 실패해도 서로 무관하게
    재시도 가능 — 부분 실패 시 복구가 오히려 더 단순함).
    소유자가 아니거나 경로가 없으면 None."""
    if not engine:
        return None
    if picked_none and picked_seg_index is not None:
        raise ValueError("picked_none=true면 picked_seg_index는 없어야 합니다")
    if not picked_none and picked_seg_index is None:
        raise ValueError("picked_none=false면 picked_seg_index가 필요합니다")

    owns = db.execute(
        text("SELECT 1 FROM routes WHERE id = :id AND uid = :uid"),
        {"id": route_id, "uid": uid},
    ).fetchone()
    if not owns:
        return None

    db.execute(text("""
        INSERT INTO segment_hardest_pick
            (uid, route_id, session_id, shown_seg_indices, picked_seg_index, picked_none)
        VALUES
            (:uid, :route_id, :session_id, :shown, :picked, :picked_none)
        ON CONFLICT (route_id) DO UPDATE SET
            session_id        = EXCLUDED.session_id,
            shown_seg_indices = EXCLUDED.shown_seg_indices,
            picked_seg_index  = EXCLUDED.picked_seg_index,
            picked_none       = EXCLUDED.picked_none,
            answered_at       = NOW()
    """), {
        "uid": uid, "route_id": route_id, "session_id": session_id,
        "shown": shown_seg_indices, "picked": picked_seg_index, "picked_none": picked_none,
    })
    db.commit()
    return {"ok": True}


def get_segment_hardest_pick(db: Session, route_id: int, uid: str) -> dict | None:
    """이 경로의 "가장 힘들었던 구간" 응답. 소유자가 아니거나 없으면 None."""
    if not engine:
        return None

    row = db.execute(text("""
        SELECT shown_seg_indices, picked_seg_index, picked_none
        FROM segment_hardest_pick sp
        JOIN routes r ON r.id = sp.route_id
        WHERE sp.route_id = :rid AND r.uid = :uid
    """), {"rid": route_id, "uid": uid}).fetchone()
    if not row:
        return None

    return {
        "route_id":          route_id,
        "shown_seg_indices": list(row[0]),
        "picked_seg_index":  int(row[1]) if row[1] is not None else None,
        "picked_none":       bool(row[2]),
    }
