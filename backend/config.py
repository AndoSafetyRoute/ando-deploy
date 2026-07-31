import os
from dotenv import load_dotenv

load_dotenv(encoding='utf-8-sig')

# ── 카카오 API ────────────────────────────────────────────────────────────────
KAKAO_REST_KEY = os.environ.get("KAKAO_REST_API_KEY", "")
KAKAO_JS_KEY   = os.environ.get("KAKAO_JS_API_KEY", "")
KAKAO_CENTER   = {"x": "126.9905", "y": "37.5326"}        # 용산구 중심

# ── 데이터 경로 ───────────────────────────────────────────────────────────────
BASE_DIR     = os.path.dirname(__file__)

# 활성 라우팅 데이터 경로
# 용산구(기본): data/road_5m_slope.geojson
# 서울 전체:    GEOJSON_PATH=data/road_10m_slope_seoul.geojson python app.py
GEOJSON_PATH = os.environ.get(
    "GEOJSON_PATH",
    os.path.join(BASE_DIR, "data", "road_5m_slope.geojson"),
)

# 서울 전체 경로 (환경변수 없이 직접 참조할 때)
GEOJSON_SEOUL_PATH = os.environ.get(
    "GEOJSON_SEOUL_PATH",
    os.path.join(BASE_DIR, "data", "road_10m_slope_seoul.geojson"),
)

# ── 지하철 편의시설 공공 API (서울 열린데이터광장) ────────────────────────────
# 각 키는 발급 내역에서 API 이름 확인 후 매핑
# OA-22740 : 교통약자이용정보 엘리베이터 현황  (5분 실시간)
SEOUL_ELEVATOR_KEY       = os.environ.get("SEOUL_ELEVATOR_KEY", "")
# OA-22742 : 교통약자이용정보 에스컬레이터 현황 (5분 실시간)
SEOUL_ESCALATOR_KEY      = os.environ.get("SEOUL_ESCALATOR_KEY", "")
# OA-22728 : 편의시설위치정보 에스컬레이터 현황 (실시간)
SEOUL_ESC_FACILITY_KEY   = os.environ.get("SEOUL_ESC_FACILITY_KEY", "")
# OA-15994 : 승강기 가동현황                   (매일, 폴백용)
SEOUL_LIFT_STATUS_KEY    = os.environ.get("SEOUL_LIFT_STATUS_KEY", "")
# OA-22745 : 휠체어 급속충전기 위치정보         (5분, 전동휠체어 전용)
SEOUL_CHARGER_KEY        = os.environ.get("SEOUL_CHARGER_KEY", "")

# ── 지하철 CSV 데이터 경로 ────────────────────────────────────────────────────
SUBWAY_DATA_DIR = os.environ.get(
    "SUBWAY_DATA_DIR",
    os.path.join(BASE_DIR, "..", "subway_data"),   # gradpj/subway_data/
)

# ── 저상버스 노선별 보유율 (OA-22229, REST API 없음 — 파일 다운로드 방식) ────
# https://data.seoul.go.kr/dataList/OA-22229/F/1/datasetView.do 에서 XLSX
# 다운로드 후 이 경로에 위치시켜야 함. 없으면 저상버스 정보 없이 동작(폴백).
LOWFLOOR_BUS_XLSX = os.environ.get(
    "LOWFLOOR_BUS_XLSX",
    os.path.join(BASE_DIR, "data", "저상버스_노선별_보유율.xlsx"),
)

# ── 대중교통 API ──────────────────────────────────────────────────────────────
# 대중교통 경로탐색(ODsay)/PathFinder는 사용하지 않기로 결정 — 프론트에서 카카오
# 대중교통 API로 직접 조회한다.
# 서울 지하철 실시간 도착 (data.seoul.go.kr OA-12764, swopenapi.seoul.go.kr 전용 키)
# → openapi.seoul.go.kr 키(SEOUL_ELEVATOR_KEY 등)와 다른 별도 발급 필요. 현재 미사용.
SEOUL_REALTIME_KEY = os.environ.get("SEOUL_REALTIME_KEY", "")

# ── 라우팅 파라미터 ───────────────────────────────────────────────────────────
FLAT_THRESHOLD    = 0.5    # elevation 차이 이 미만 → 평지 (%)
STDDEV_THRESHOLD  = 1.0    # slope1_stddev 기준값
BRIDGE_GAP_M      = 50.0   # 연결 성분 브리지 최대 거리(m)
MAX_DETOUR_RATIO  = 1.3    # 최단거리 대비 허용 최대 우회 배율
FORBIDDEN_PENALTY = 15.0   # 금지 구간 거리 대비 패널티 배율 (1e6 → 15)
