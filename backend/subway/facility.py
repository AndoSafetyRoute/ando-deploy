"""
subway/facility.py — 지하철역 편의시설 DB

역할:
  1. CSV 로드 (정적): 엘리베이터·에스컬레이터·휠체어리프트 설치현황
  2. 출구 좌표 캐시: 카카오 Places API "역명 N번출구" 검색
  3. 실시간 운행상태: 서울 열린데이터광장 REST API (OA-22740 / OA-22742)
  4. 출구 스냅: user_type에 따라 가장 가까운 접근 가능 출구 반환

출구 스냅 기준
  수동/전동 휠체어, 워커  → 엘리베이터 출구 (운행 중인 것 중 가장 가까운 곳)
  지팡이·다리부상·고령자  → 에스컬레이터 출구 우선, 없으면 엘리베이터 출구

데이터 파일 (subway_data/)
  서울교통공사_엘리베이터 설치 정보_20250310.csv      (OA-13241, 863행)
  서울교통공사_에스컬레이터 설치 정보_20250310.csv    (OA-13242, 1872행)
  서울교통공사_9호선2_3단계 에스컬레이터 설치현황.CSV  (OA-22443, 202행)
  서울교통공사_휠체어리프트 설치현황_20250310.csv      (OA-13192, 71행)

서울 열린데이터광장 REST API (확인일: 2026-05-28, 충전기 API 확인일: 2026-07-29)
  Base URL : http://openapi.seoul.go.kr:8088/{KEY}/json/{SERVICE}/{START}/{END}/
  OA-22740  서비스명 getWksnElvtr      교통약자이용정보 엘리베이터 현황 (약 865건, 5분 갱신)
  OA-22742  서비스명 getWksnEsctr      교통약자이용정보 에스컬레이터 현황 (약 1882건, 5분 갱신)
  OA-22745  서비스명 getWksnWhclCharge 지하철역 내 전동휠체어 충전설비 현황 (119건, 1~8호선 전역)
  공통 응답: { "response": { "header": {"resultCode":"00"}, "body": { "items": {"item":[...]}, "totalCount": N } } }
  고장 판별: oprtngSitu 필드 — M=사용가능(정상), D=삭제, S=보수중, T=중지, I=점검중, B=공사중
  일련번호:  elvtrSn 필드 (CSV의 '승강기 일련번호' 와 동일)

  충전기(OA-22745) 응답 필드 (실측 확인):
    lineNm/stnNm/stnNo : 호선/역명/역번호
    stnFlr             : 설치 층 (예: "B1")
    dtlPstn            : 상세 위치 설명 (예: "3, 4번 출구쪽 게이트 방면 45m 지점")
    elctcFacCnt        : 설치 대수
    grndUdgdSe         : 지상/지하 구분
    ※ 가동상태(oprtngSitu) 필드는 없음 — 실시간 고장여부가 아니라 설치 현황 등록 정보
"""

import os
import re
import math
import logging
import requests

from config import (
    KAKAO_REST_KEY,
    SEOUL_ELEVATOR_KEY,
    SEOUL_ESCALATOR_KEY,
    SEOUL_CHARGER_KEY,
    SUBWAY_DATA_DIR,
)

log = logging.getLogger(__name__)

# ── 인코딩 ───────────────────────────────────────────────────────────────────
_ENC = "euc-kr"

# ── 서울 열린데이터광장 API 베이스 ────────────────────────────────────────────
# http://openapi.seoul.go.kr:8088/{KEY}/json/{SERVICE}/{START}/{END}/
_SEOUL_API_BASE = "http://openapi.seoul.go.kr:8088"

# 서비스명 (2026-05-28 API 명세 다운로드로 확인)
_SVC_ELEVATOR   = "getWksnElvtr"      # OA-22740 교통약자이용정보 엘리베이터 현황
_SVC_ESCALATOR  = "getWksnEsctr"      # OA-22742 교통약자이용정보 에스컬레이터 현황
_SVC_CHARGER    = "getWksnWhclCharge" # OA-22745 지하철역 내 전동휠체어 충전설비 현황

# 가동현황 코드 — oprtngSitu 값이 아래에 없으면 고장/미운행으로 처리
_OPERATING_OK   = {"M"}            # M=사용가능  (나머지: D삭제 S보수중 T중지 I점검중 B공사중)

# ── user_type 분류 ────────────────────────────────────────────────────────────
# 엘리베이터만 사용 가능
_ELEVATOR_ONLY  = {"manual_wheelchair", "electric_wheelchair", "walker"}
# 에스컬레이터 이용 가능 (우선 안내, 없으면 엘리베이터)
_ESC_PREFERRED  = {"cane", "leg_injury", "elderly"}

# S7 — 에스컬레이터 운행 방향(CSV "상하행구분" 그대로, _load_escalators 참고).
# entering(길에서 역으로 내려감) → 하행 에스컬레이터만 실제로 도움이 됨.
# exiting(플랫폼에서 지상으로 올라옴) → 상행만. 방향 필드가 비어 있는 행은
# 데이터 결측이지 "이 방향 아님"이 아니므로 양쪽 다 후보로 남긴다.
_ESC_DOWN = {"하행"}
_ESC_UP   = {"상행"}


# ════════════════════════════════════════════════════════════════════════════
#  출구 번호 정규화
# ════════════════════════════════════════════════════════════════════════════

def _normalize_exit(raw: str) -> list[str] | None:
    """
    CSV의 (근접)출입구번호 원본값 → 출구번호 리스트 또는 None

    규칙:
      "4번출구" / "4번 출구" / "4번 출입구"  →  ["4"]
      "1-1번출구"                            →  ["1-1"]
      "1번 2번출구"  (9호선 복수)             →  ["1", "2"]
      "내부" / "외부" / "방면" 포함 / 빈값    →  None  (스냅 대상 아님)
      '"3' 같은 따옴표 잔재                   →  ["3"]
    """
    v = raw.strip().strip('"').strip()
    if not v:
        return None
    if v in ("내부", "외부") or "방면" in v:
        return None

    # 숫자(-포함) + "번" 패턴을 모두 추출
    hits = re.findall(r"(\d+(?:-\d+)?)번", v)
    if hits:
        return hits

    # 순수 숫자만 남은 경우 (따옴표 제거 후 "3" 등)
    if re.fullmatch(r"\d+(?:-\d+)?", v):
        return [v]

    return None


# ════════════════════════════════════════════════════════════════════════════
#  역명 정규화  "서울역(1)" → "서울역"
# ════════════════════════════════════════════════════════════════════════════

def _normalize_station(raw: str) -> str:
    """호선 구분자 제거: '종로3가(1)' → '종로3가'"""
    return re.sub(r"\(\d+\w*\)$", "", raw.strip()).strip()


# ════════════════════════════════════════════════════════════════════════════
#  CSV 로더
# ════════════════════════════════════════════════════════════════════════════

def _read_csv(path: str) -> list[list[str]]:
    """EUC-KR CSV → 행 리스트 (헤더 제외)"""
    with open(path, encoding=_ENC, errors="replace") as f:
        lines = f.read().splitlines()
    rows = []
    for line in lines[1:]:          # 헤더 스킵
        if line.strip():
            rows.append(line.split(","))
    return rows


def _load_elevators(path: str) -> dict:
    """
    엘리베이터 설치 정보 → {역명: [exit_entry, ...]}
    exit_entry = {"exit_no": "2", "section": "B1-G1", "serial": "0104-656"}
    """
    db: dict[str, list] = {}
    for cols in _read_csv(path):
        if len(cols) < 14:
            continue
        station = _normalize_station(cols[2])
        exits   = _normalize_exit(cols[4])      # (근접)출입구번호
        section = cols[13].strip() if len(cols) > 13 else ""
        serial  = cols[12].strip() if len(cols) > 12 else ""
        if exits:
            for ex in exits:
                db.setdefault(station, []).append({
                    "type":    "elevator",
                    "exit_no": ex,
                    "section": section,
                    "serial":  serial,
                })
    return db


def _load_escalators(path: str, is_line9: bool = False) -> dict:
    """
    에스컬레이터 설치 정보 → {역명: [exit_entry, ...]}
    exit_entry = {"exit_no": "4", "direction": "상행", "section": "B1-G1", "serial": "..."}
    """
    db: dict[str, list] = {}
    for cols in _read_csv(path):
        if len(cols) < 14:
            continue
        station   = _normalize_station(cols[2])
        direction = cols[4].strip()            # 상하행구분 (col4)
        exits     = _normalize_exit(cols[5])   # (근접)출입구번호 (col5)
        serial    = cols[13].strip() if len(cols) > 13 else ""

        # 9호선은 col14에 운행구간, col15에 설치위치
        section = cols[14].strip() if (is_line9 and len(cols) > 14) else ""

        if exits:
            for ex in exits:
                db.setdefault(station, []).append({
                    "type":      "escalator",
                    "exit_no":   ex,
                    "direction": direction,
                    "section":   section,
                    "serial":    serial,
                })
    return db


def _load_lifts(path: str) -> dict:
    """
    휠체어리프트 설치 정보 → {역명: [exit_entry, ...]}
    """
    db: dict[str, list] = {}
    for cols in _read_csv(path):
        if len(cols) < 15:
            continue
        station = _normalize_station(cols[2])
        exits   = _normalize_exit(cols[4])     # (근접) 출입구번호
        serial  = cols[14].strip() if len(cols) > 14 else ""
        if exits:
            for ex in exits:
                db.setdefault(station, []).append({
                    "type":    "lift",
                    "exit_no": ex,
                    "serial":  serial,
                })
    return db


# ════════════════════════════════════════════════════════════════════════════
#  출구 좌표: 카카오 Places API 캐시
# ════════════════════════════════════════════════════════════════════════════

_exit_coord_cache: dict[str, tuple[float, float] | None] = {}


def _kakao_exit_coord(station: str, exit_no: str) -> tuple[float, float] | None:
    """카카오 장소 검색 '역명 N번출구' → (lat, lon) 또는 None"""
    cache_key = f"{station}_{exit_no}"
    if cache_key in _exit_coord_cache:
        return _exit_coord_cache[cache_key]

    query = f"{station} {exit_no}번출구"
    try:
        resp = requests.get(
            "https://dapi.kakao.com/v2/local/search/keyword.json",
            headers={"Authorization": f"KakaoAK {KAKAO_REST_KEY}"},
            params={"query": query, "size": 1},
            timeout=5.0,
        )
        resp.raise_for_status()
        docs = resp.json().get("documents", [])
        if docs:
            coord = (float(docs[0]["y"]), float(docs[0]["x"]))  # (lat, lon)
            _exit_coord_cache[cache_key] = coord
            return coord
    except Exception as e:
        log.warning("카카오 출구 좌표 조회 실패 [%s]: %s", query, e)

    _exit_coord_cache[cache_key] = None
    return None


# ════════════════════════════════════════════════════════════════════════════
#  실시간 운행상태 (서울 열린데이터광장)
# ════════════════════════════════════════════════════════════════════════════

def _fetch_seoul_api(key: str, service: str) -> list[dict]:
    """
    서울 열린데이터광장 REST API 호출 → 전체 item 리스트 (페이지네이션 처리)

    응답 형식:
      { "response": { "header": {"resultCode":"00"}, "body": { "items": {"item":[...]}, "totalCount": N } } }

    resultCode "00" = 정상. 그 외는 오류로 처리.
    한 번에 최대 1000건 → totalCount > 1000 이면 여러 번 호출.
    """
    if not key:
        return []

    PAGE = 1000
    all_items: list[dict] = []
    start = 1

    while True:
        end = start + PAGE - 1
        url = f"{_SEOUL_API_BASE}/{key}/json/{service}/{start}/{end}/"
        try:
            resp = requests.get(url, timeout=10.0)
            resp.raise_for_status()
            body = resp.json()

            header = body.get("response", {}).get("header", {})
            if header.get("resultCode") != "00":
                log.warning("서울 API 오류 [%s]: %s", service, header.get("resultMsg"))
                break

            api_body   = body["response"]["body"]
            total      = int(api_body.get("totalCount", 0))
            items_wrap = api_body.get("items", {})
            items      = items_wrap.get("item", [])

            # 단일 결과는 dict로 반환되는 경우 있음
            if isinstance(items, dict):
                items = [items]

            all_items.extend(items)

            if end >= total:
                break
            start = end + 1

        except Exception as e:
            log.warning("서울 API 호출 실패 [%s, %d~%d]: %s", service, start, end, e)
            break

    return all_items


def get_broken_serials() -> set[str]:
    """
    현재 고장/운행중단 승강기 일련번호 집합 반환
    OA-22740 (엘리베이터, getWksnElvtr) + OA-22742 (에스컬레이터, getWksnEsctr) 합산

    핵심 필드:
      elvtrSn    — 승강기 일련번호 (CSV의 '승강기 일련번호' 와 동일)
      oprtngSitu — 가동현황 코드 (M=정상, 나머지=고장·중단)
    """
    broken: set[str] = set()

    for key, svc in [
        (SEOUL_ELEVATOR_KEY,  _SVC_ELEVATOR),
        (SEOUL_ESCALATOR_KEY, _SVC_ESCALATOR),
    ]:
        items = _fetch_seoul_api(key, svc)
        for item in items:
            serial = item.get("elvtrSn", "").strip()
            status = item.get("oprtngSitu", "")
            if serial and status not in _OPERATING_OK:
                broken.add(serial)

    return broken


def get_station_chargers(station_name: str | None = None) -> list[dict]:
    """
    지하철역 내 전동휠체어 충전설비 목록 (OA-22745, 1~8호선 전역 119건)

    station_name 지정 시 해당 역만 필터링(정규화 후 부분 일치).
    가동상태 필드가 없는 정적 설치현황 데이터이므로, 급속충전소 CSV(커뮤니티센터 등
    역 밖 시설)와는 별개의 보완 데이터로 취급한다 — 지하철 이용 중 배터리 부족
    상황에서 "이 역 안에 충전기가 있는지"를 바로 알려주는 용도.
    """
    items = _fetch_seoul_api(SEOUL_CHARGER_KEY, _SVC_CHARGER)
    result = [
        {
            "line":     item.get("lineNm", ""),
            "station":  item.get("stnNm", ""),
            "floor":    item.get("stnFlr", ""),
            "position": item.get("dtlPstn", ""),
            "count":    item.get("elctcFacCnt", 1),
        }
        for item in items
    ]
    if station_name:
        target = _normalize_station(station_name)
        result = [r for r in result if _normalize_station(r["station"]) == target]
    return result


# ════════════════════════════════════════════════════════════════════════════
#  거리 계산 (Haversine)
# ════════════════════════════════════════════════════════════════════════════

def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000.0
    f1, f2 = math.radians(lat1), math.radians(lat2)
    df = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a  = math.sin(df / 2) ** 2 + math.cos(f1) * math.cos(f2) * math.sin(dl / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


# ════════════════════════════════════════════════════════════════════════════
#  메인 DB 클래스
# ════════════════════════════════════════════════════════════════════════════

class SubwayFacilityDB:
    """
    서버 시작 시 1회 초기화. 이후 get_best_exit()로 사용.
    """

    def __init__(self, data_dir: str = SUBWAY_DATA_DIR):
        self._elev: dict  = {}   # {역명: [{type, exit_no, section, serial}]}
        self._esc:  dict  = {}   # 에스컬레이터
        self._lift: dict  = {}   # 휠체어리프트
        self._load(data_dir)

    # ── CSV 로드 ─────────────────────────────────────────────────────────────
    def _load(self, data_dir: str):
        def _fp(name):
            return os.path.join(data_dir, name)

        # 엘리베이터
        elev_path = _fp("서울교통공사_엘리베이터 설치 정보_20250310.csv")
        if os.path.exists(elev_path):
            self._elev = _load_elevators(elev_path)
            log.info("[SubwayFacility] 엘리베이터 %d역 로드", len(self._elev))

        # 에스컬레이터 (1-8호선)
        esc_path = _fp("서울교통공사_에스컬레이터 설치 정보_20250310.csv")
        if os.path.exists(esc_path):
            self._esc = _load_escalators(esc_path)

        # 에스컬레이터 (9호선) — 병합
        esc9_path = _fp("서울교통공사_9호선2_3단계 에스컬레이터 설치현황_20260131.CSV")
        if os.path.exists(esc9_path):
            line9 = _load_escalators(esc9_path, is_line9=True)
            for stn, entries in line9.items():
                self._esc.setdefault(stn, []).extend(entries)
        log.info("[SubwayFacility] 에스컬레이터 %d역 로드", len(self._esc))

        # 휠체어리프트
        lift_path = _fp("서울교통공사_휠체어리프트 설치현황_20250310.csv")
        if os.path.exists(lift_path):
            self._lift = _load_lifts(lift_path)
            log.info("[SubwayFacility] 휠체어리프트 %d역 로드", len(self._lift))

    # ── 내부 헬퍼 ────────────────────────────────────────────────────────────
    def _active(self, entries: list[dict], broken: set[str]) -> list[dict]:
        """고장 serial 제외한 운행 중 항목만 반환"""
        return [e for e in entries if e.get("serial", "") not in broken]

    def _with_coord(
        self,
        station: str,
        entries: list[dict],
    ) -> list[dict]:
        """exit_no별 좌표 추가 (카카오 캐시 활용), 좌표 없는 항목 제외"""
        result = []
        for e in entries:
            coord = _kakao_exit_coord(station, e["exit_no"])
            if coord:
                result.append({**e, "lat": coord[0], "lon": coord[1]})
        return result

    def _nearest(
        self,
        candidates: list[dict],
        user_lat: float,
        user_lon: float,
    ) -> dict | None:
        """좌표 포함된 candidates 중 user 위치와 가장 가까운 출구 반환"""
        if not candidates:
            return None
        return min(
            candidates,
            key=lambda c: _haversine(user_lat, user_lon, c["lat"], c["lon"]),
        )

    # ── 공개 API ─────────────────────────────────────────────────────────────
    def get_exit_candidates(
        self,
        station_name: str,
        user_type: str,
        direction: str = "entering",
    ) -> list[dict]:
        """
        user_type·방향 기준으로 이용 가능한 출구 후보 전체(좌표 포함) — 정렬 없음.
        정렬(최근접/경로비용)은 호출측이 목적에 맞게 한다.

        direction: "entering"(길 → 역, 하행 에스컬레이터만 후보) |
                   "exiting"(플랫폼 → 지상, 상행만). 방향 필드가 빈 CSV 행은
                   데이터 결측이지 "이 방향 아님"이 아니므로 양쪽 다 후보로 남긴다.
        """
        stn    = _normalize_station(station_name)
        broken = get_broken_serials()
        need_dir = _ESC_DOWN if direction == "entering" else _ESC_UP

        if user_type in _ELEVATOR_ONLY:
            active = self._active(self._elev.get(stn, []), broken)
            return self._with_coord(stn, active)

        if user_type in _ESC_PREFERRED:
            active_esc = self._active(self._esc.get(stn, []), broken)
            dir_matched = [e for e in active_esc if not e.get("direction") or e["direction"] in need_dir]
            candidates = self._with_coord(stn, dir_matched)
            if candidates:
                return candidates
            # 방향 맞는(또는 방향 미상) 에스컬레이터 없음 → 엘리베이터 폴백
            active_elev = self._active(self._elev.get(stn, []), broken)
            return self._with_coord(stn, active_elev)

        return []

    def get_best_exit(
        self,
        station_name: str,
        user_type: str,
        user_lat: float,
        user_lon: float,
        direction: str = "exiting",
    ) -> dict | None:
        """
        user_type·위치·방향 기준 최적 출구 반환 — **직선거리 최근접**.
        지하 구간(플랫폼→지상)은 보행 그래프가 없어 경로비용을 낼 수 없으므로
        이 방식이 최선이다. 지상 구간(길→역, 진입) 비용 비교가 필요하면
        get_exit_candidates() + 그래프 라우팅을 쓸 것(app.py /route 참고).

        반환 dict:
          type      : "elevator" | "escalator" | "lift"
          exit_no   : "2"
          lat / lon : 출구 위경도
          serial    : 승강기 일련번호
          direction : (에스컬레이터만) "상행" | "하행"
          message   : FE 안내 텍스트
        """
        candidates = self.get_exit_candidates(station_name, user_type, direction)
        best = self._nearest(candidates, user_lat, user_lon)
        if not best:
            return None

        if best.get("type") == "escalator":
            msg = (
                f"{best['exit_no']}번 출구 에스컬레이터를 이용하세요. "
                f"({best.get('direction', '')} 방향)"
            ).strip()
        elif user_type in _ESC_PREFERRED:
            msg = f"{best['exit_no']}번 출구 엘리베이터를 이용하세요. (에스컬레이터 없음)"
        else:
            msg = f"{best['exit_no']}번 출구 엘리베이터를 이용하세요."
        return {**best, "message": msg}

    def station_summary(self, station_name: str) -> dict:
        """역 시설 현황 요약 (디버그·FE 참고용)"""
        stn = _normalize_station(station_name)
        return {
            "station":    stn,
            "elevators":  len(self._elev.get(stn, [])),
            "escalators": len(self._esc.get(stn, [])),
            "lifts":      len(self._lift.get(stn, [])),
        }


# ── 싱글톤 ────────────────────────────────────────────────────────────────────
_db: SubwayFacilityDB | None = None


def get_facility_db() -> SubwayFacilityDB:
    global _db
    if _db is None:
        _db = SubwayFacilityDB()
    return _db
