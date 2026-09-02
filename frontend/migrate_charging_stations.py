"""
용산구 전동보장구 급속충전소 데이터를 Supabase PostgreSQL(PostGIS)로 마이그레이션.

사용법:
    pip install psycopg2-binary
    python scripts/migrate_charging_stations.py

Supabase 접속 정보:
    Supabase 대시보드 > Settings > Database > Connection string 참조.
    아래 DB_CONFIG의 host/password를 본인 프로젝트 값으로 교체하거나
    환경변수(DB_HOST, DB_PASSWORD 등)로 주입하세요.
"""

import csv
import os
import psycopg2
from psycopg2.extras import execute_values

CSV_PATH = r"C:\Users\juyeong\Desktop\서울시 전동보장구 급속충전소.csv"
TARGET_GU = "용산구"

DB_CONFIG = {
    "host":     os.getenv("DB_HOST", "db.YOUR_PROJECT_REF.supabase.co"),
    "port":     int(os.getenv("DB_PORT", 5432)),
    "dbname":   os.getenv("DB_NAME", "postgres"),
    "user":     os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", "YOUR_DB_PASSWORD"),
    "sslmode":  "require",
}

CREATE_EXTENSION = "CREATE EXTENSION IF NOT EXISTS postgis;"

CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS charging_stations (
    id                BIGSERIAL        PRIMARY KEY,
    name              TEXT             NOT NULL,
    address_road      TEXT             NOT NULL,
    lat               DOUBLE PRECISION NOT NULL,
    lng               DOUBLE PRECISION NOT NULL,
    geom              GEOMETRY(Point, 4326) NOT NULL,
    operating_hours   TEXT             NOT NULL,
    has_air_pump      BOOLEAN          NOT NULL DEFAULT FALSE,
    has_phone_charger BOOLEAN          NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ      NOT NULL DEFAULT now()
);
"""

CREATE_INDEX = """
CREATE INDEX IF NOT EXISTS idx_charging_stations_geom
    ON charging_stations USING GIST (geom);
"""

INSERT_SQL = """
INSERT INTO charging_stations
    (name, address_road, lat, lng, geom, operating_hours, has_air_pump, has_phone_charger)
VALUES %s
ON CONFLICT DO NOTHING;
"""

def parse_bool(value: str) -> bool:
    return value.strip().rstrip("|").strip().upper() == "Y"

def clean_text(value: str) -> str:
    return value.strip().strip("|").strip()

def load_csv(path: str, target_gu: str) -> list[tuple]:
    rows = []
    seen = set()

    with open(path, encoding="cp949", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("구명", "").strip() != target_gu:
                continue

            name    = clean_text(row["콘텐츠명"])
            address = clean_text(row["도로명주소"])
            lng     = float(row["X좌표"])
            lat     = float(row["Y좌표"])
            hours   = clean_text(row["운영시간"]).replace("|", " / ")
            air     = parse_bool(row["공기주입 가능여부"])
            phone   = parse_bool(row["휴대전화충전 가능여부"])

            key = (name, lng, lat)
            if key in seen:
                continue
            seen.add(key)

            geom_wkt = f"SRID=4326;POINT({lng} {lat})"
            rows.append((name, address, lat, lng, geom_wkt, hours, air, phone))

    return rows

def main():
    records = load_csv(CSV_PATH, TARGET_GU)
    print(f"[INFO] {TARGET_GU} 충전소 {len(records)}개 로드 완료")

    conn = psycopg2.connect(**DB_CONFIG)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(CREATE_EXTENSION)
                cur.execute(CREATE_TABLE)
                cur.execute(CREATE_INDEX)

                execute_values(
                    cur,
                    INSERT_SQL,
                    records,
                    template="(%s, %s, %s, %s, ST_GeomFromEWKT(%s), %s, %s, %s)",
                )
                print(f"[INFO] {cur.rowcount}행 삽입 완료")
    finally:
        conn.close()

    print("[DONE] 마이그레이션 성공")

if __name__ == "__main__":
    main()
