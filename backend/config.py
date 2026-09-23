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
# 서울 지하철 실시간 도착 (data.seoul.go.kr 발급 포털에서 별도 발급, 카탈로그 페이지엔
# "서비스 종료 안내"로 나오는 경우가 있으나 실제 엔드포인트는 살아있음 — 2026-09 확인).
# openapi.seoul.go.kr 키(SEOUL_ELEVATOR_KEY 등)와는 다른 별도 키. subway_arrival.py 참고.
# 키 없으면 실시간 배지는 자동으로 숨겨진다(그래도 카카오 정적 시간은 그대로 표시).
SEOUL_REALTIME_KEY = os.environ.get("SEOUL_REALTIME_KEY", "")

# 서울시 버스도착정보 실시간 (공공데이터포털 '서울특별시_버스도착정보조회 서비스',
# ws.bus.go.kr/api/rest/arrive/*). 노선명→busRouteId 변환은 '서울특별시_노선정보조회
# 서비스'(ws.bus.go.kr/api/rest/busRouteInfo/*)가 추가로 활용신청돼 있어야 동적 가능
# → 그 경우 BUS_ROUTE_INFO_ENABLED=1. 두 서비스가 계정이 달라 인증키가 서로 다를 수
# 있어(실제로 그랬음, 2026-09), BUS_ROUTE_INFO_KEY 를 따로 둔다 — 비어있으면
# BUS_ARRIVAL_KEY 를 그대로 재사용(같은 계정인 경우 대비).
# bus_arrival.py 참고. 키 없으면 실시간 배지는 자동으로 숨겨진다(정적 시간 유지).
BUS_ARRIVAL_KEY        = os.environ.get("BUS_ARRIVAL_KEY", "")
BUS_ROUTE_INFO_KEY     = os.environ.get("BUS_ROUTE_INFO_KEY", "") or BUS_ARRIVAL_KEY
BUS_ROUTE_INFO_ENABLED = os.environ.get("BUS_ROUTE_INFO_ENABLED", "") == "1"

# ── 라우팅 파라미터 ───────────────────────────────────────────────────────────
FLAT_THRESHOLD    = 0.5    # elevation 차이 이 미만 → 평지 (%)
STDDEV_THRESHOLD  = 1.0    # slope1_stddev 기준값
SNAP_TOL_M        = 5.0    # 그래프 빌드 시 이 거리 이내 미연결 노드쌍에 보행 링크 추가
                           # (원본 OSM 노딩 틈 메움 — 서울역 광장 15km 우회 해소, README §104)
BRIDGE_GAP_M      = 50.0   # 연결 성분 브리지 최대 거리(m)
MAX_DETOUR_RATIO  = 1.3    # 최단거리 대비 허용 최대 우회 배율
FORBIDDEN_PENALTY = 15.0   # 금지 구간 거리 대비 패널티 배율 (1e6 → 15)

# ── 개인화 코스트 커브 기저함수 (ando_dev_final.md 7.1/7.3절) ─────────────────
# c_u(g) 를 15개 3차 B-spline 기저함수로 표현.
#
# 도메인은 그래프에 존재하는 signed slope_pct 전체를 덮어야 한다(도메인 밖 엣지는
# 가중치를 못 매겨 라우팅이 깨짐 — basis.py 는 그 방어로 경계값 clip).
# 용산 5m(road_5m_slope) 실측 분포(scripts/pers_cch_probe.py):
#   엣지 p1/p99 = ∓21.3%, |g|>25% = 1.07%, 길이가중 p99.9 = ±35.4%, min/max ±60%.
# g_warn 최대 8.33% 초과는 어차피 FORBIDDEN_PENALTY 로 배제되므로 20%와 60%를
# 구분할 실익이 없다 → ±25% 로 clip. 극단 ±60% 는 DEM 노이즈/교량으로 판단.
#
# 매듭은 균등 배치 금지: 관측이 몰리는 코어(±10%)에 조밀하게, 꼬리는 성기게.
# (±25 균등 15개면 간격 3.3% 라 실제 학습 구간 해상도가 무너짐 — 문서 7.1절)
BASIS_N_KNOTS = 15     # 기저함수 개수 — 문서 7.1절
BASIS_DEGREE  = 3      # 3차(cubic) B-spline
BASIS_G_MIN   = -25.0  # clip 하한(%) — 실측 분포 기반
BASIS_G_MAX   = 25.0   # clip 상한(%)
BASIS_CORE_MIN = -10.0 # 조밀 매듭 코어 구간(관측 실질 범위 −6~+7% 를 여유있게 덮음)
BASIS_CORE_MAX = 10.0
BASIS_KNOTS_LEFT  = 3  # [G_MIN, CORE_MIN] 구간 매듭 수 (양 끝 포함)
BASIS_KNOTS_CORE  = 9  # [CORE_MIN, CORE_MAX] 구간 매듭 수 (양 끝 포함, ~2.5% 간격)
BASIS_KNOTS_RIGHT = 3  # [CORE_MAX, G_MAX] 구간 매듭 수 (양 끝 포함)
# 내부 매듭 합 = LEFT + (CORE-1) + (RIGHT-1) = N_KNOTS - DEGREE + 1 = 13 이어야 함

# ── 개인화 속도 프로파일 캘리브레이션 (문서 3.9/3.10절) ───────────────────────
# v̄_flat 은 신호 A·B 정규화의 기준이라 "틀리면 전부 틀어지는" 값(3.10절).
# 평지(|g|<0.5%) 누적 관측 거리가 이 값에 도달하기 전엔 EMA 결과를 쓰지 않고
# 유형 문헌 기본값으로 폴백한다(별도 캘리브레이션 화면 없이 자동 누적).
CALIBRATION_FLAT_M = 300.0
