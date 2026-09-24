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
import csv
import math
import time
import logging
import threading
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
# 엘리베이터 출구만 — 휠체어·워커·다리부상 (에스컬레이터 탑승 불가/위험)
_ELEVATOR_ONLY  = {"manual_wheelchair", "electric_wheelchair", "walker", "leg_injury"}
# 에스컬레이터 또는 엘리베이터 출구 — 지팡이·고령자. 둘 다 후보로 두고 출발지에서
# 가까운(실제 도보 비용) 출구를 고른다(우선순위 없음).
# S6 — 'general'(실험 참가자, 비보행약자)도 같은 정책.
_ESC_OR_ELEV    = {"cane", "elderly", "general"}

# S7 — 에스컬레이터 운행 방향(CSV "상하행구분" 그대로, _load_escalators 참고).
# entering(길에서 역으로 내려감) → 하행 에스컬레이터만 실제로 도움이 됨.
# exiting(플랫폼에서 지상으로 올라옴) → 상행만. 방향 필드가 비어 있는 행은
# 데이터 결측이지 "이 방향 아님"이 아니므로 양쪽 다 후보로 남긴다.
_ESC_DOWN = {"하행"}
_ESC_UP   = {"상행"}


def _esc_dir_ok(direction: str | None, need: set) -> bool:
    """방향 결측·겸용("상/하겸용")은 양방향 모두 이용 가능으로 본다."""
    return not direction or direction in need or "겸용" in direction


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
    """
    앱/카카오 역명과 서울교통공사 CSV 역명을 동일한 키로 정규화.

    예:
      "숙대입구역 4호선" -> "숙대입구"
      "4호선 숙대입구역" -> "숙대입구"
      "서울역(1)"        -> "서울"
      "서울역 1호선"     -> "서울"
      "종로3가(1)"       -> "종로3가"
    """
    if not raw:
        return ""

    name = str(raw).strip()

    # 연속 공백 정리
    name = re.sub(r"\s+", " ", name).strip()

    # 끝 괄호 제거 — CSV 호선 표기와 카카오 부역명 모두
    # 종로3가(1) -> 종로3가, 숙대입구(서울시교육청) -> 숙대입구
    # (카카오 대중교통 도보 구간은 괄호 붙은 이름을 준다 — 숫자 괄호만 떼면 매칭 실패)
    name = re.sub(r"\s*[\(（][^)）]*[\)）]\s*$", "", name).strip()

    # 뒤쪽 호선 제거
    # 숙대입구역 4호선 -> 숙대입구역
    name = re.sub(r"\s*\d+(?:-\d+)?호선\s*$", "", name).strip()

    # 앞쪽 호선 제거
    # 4호선 숙대입구역 -> 숙대입구역
    name = re.sub(r"^\s*\d+(?:-\d+)?호선\s*", "", name).strip()

    # 마지막 '역' 제거
    # 숙대입구역 -> 숙대입구
    if name.endswith("역"):
        name = name[:-1].strip()

    return name



# ════════════════════════════════════════════════════════════════════════════
#  CSV 로더
# ════════════════════════════════════════════════════════════════════════════

def _read_csv(path: str) -> list[list[str]]:
    """
    서울교통공사 CSV를 안전하게 읽는다.
    단순 split(",") 대신 csv.reader를 사용해 따옴표/쉼표가 포함된 필드도 처리한다.
    """
    rows: list[list[str]] = []
    with open(path, "r", encoding=_ENC, errors="replace", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)  # 헤더 스킵
        for row in reader:
            if row and any(str(v).strip() for v in row):
                rows.append(row)
    return rows


def _load_elevators(path: str) -> dict:
    """
    엘리베이터 CSV 실제 구조:
      0 연번
      1 호선
      2 역명
      3 관리번호
      4 (근접)출입구번호
      ...
      12 승강기 일련번호
      13 데이터 기준일자
    """
    db: dict[str, list] = {}

    for cols in _read_csv(path):
        if len(cols) < 14:
            continue

        station = _normalize_station(cols[2])
        exits = _normalize_exit(cols[4])
        serial = cols[12].strip()
        data_date = cols[13].strip()

        # 출구와 직접 연결되지 않는 "내부" 엘리베이터는 스냅 후보에서 제외
        if not station or not exits:
            continue

        for ex in exits:
            db.setdefault(station, []).append({
                "type": "elevator",
                "exit_no": ex,
                "serial": serial,
                "data_date": data_date,
            })

    return db


def _normalize_escalator_direction(raw: str) -> str:
    """
    '상행', '상 행', '하행', '하 행' 등을 동일하게 처리.
    9호선 CSV에는 '하 행'처럼 공백이 들어간 값이 존재한다.
    """
    value = re.sub(r"\s+", "", str(raw or ""))

    if value == "상행":
        return "상행"
    if value == "하행":
        return "하행"

    return value


def _load_escalators(path: str, is_line9: bool = False) -> dict:
    """
    에스컬레이터 CSV 실제 구조:
      0 연번
      1 호선
      2 역명
      3 관리번호
      4 상하행구분
      5 (근접)출입구번호
      ...
      13 승강기 일련번호
      14 데이터 기준일자 (1~8호선)
         또는 운행구간 (9호선)
      15 설치위치 (9호선)
    """
    db: dict[str, list] = {}

    for cols in _read_csv(path):
        if len(cols) < 14:
            continue

        station = _normalize_station(cols[2])
        direction = _normalize_escalator_direction(cols[4])
        exits = _normalize_exit(cols[5])
        serial = cols[13].strip()

        section = ""
        data_date = ""

        if is_line9:
            section = cols[14].strip() if len(cols) > 14 else ""
        else:
            data_date = cols[14].strip() if len(cols) > 14 else ""

        if not station or not exits:
            continue

        for ex in exits:
            db.setdefault(station, []).append({
                "type": "escalator",
                "exit_no": ex,
                "direction": direction,
                "section": section,
                "serial": serial,
                "data_date": data_date,
            })

    return db


def _load_lifts(path: str) -> dict:
    """
    휠체어리프트 CSV 실제 구조:
      0 연번
      1 호선
      2 역명
      3 관리번호
      4 (근접)출입구번호
      ...
      14 승강기 일련번호
      15 데이터 기준일자
    """
    db: dict[str, list] = {}

    for cols in _read_csv(path):
        if len(cols) < 15:
            continue

        station = _normalize_station(cols[2])
        exits = _normalize_exit(cols[4])
        serial = cols[14].strip()
        data_date = cols[15].strip() if len(cols) > 15 else ""

        if not station or not exits:
            continue

        for ex in exits:
            db.setdefault(station, []).append({
                "type": "lift",
                "exit_no": ex,
                "serial": serial,
                "data_date": data_date,
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

    query = f"{station}역 {exit_no}번출구"
    try:
        resp = requests.get(
            "https://dapi.kakao.com/v2/local/search/keyword.json",
            headers={"Authorization": f"KakaoAK {KAKAO_REST_KEY}"},
            params={"query": query, "size": 5},
            timeout=5.0,
        )
        resp.raise_for_status()
        docs = resp.json().get("documents", [])
        # 1위가 다른 출구번호일 때가 있어(실측: 가산디지털단지 6번 → 9번) 이름에
        # "N번" 이 정확히 들어간 결과를 우선한다. "1번" 이 "11번" 에 걸리지 않게 앞 숫자 확인.
        exact = [d for d in docs
                 if re.search(rf"(?<![\d-]){re.escape(exit_no)}번", d.get("place_name", ""))]
        if exact:
            docs = exact
        elif docs and re.search(r"\d+(?:-\d+)?번", docs[0].get("place_name", "")):
            # 다른 번호의 출구만 나오면 이 출구는 좌표 없음 처리(틀린 출구로 안내하지 않게
            # 후보에서 빠진다). 번호 없는 결과(역 자체 등)는 기존처럼 그대로 쓴다.
            docs = []
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
    return _fetch_seoul_api_checked(key, service)[0]


def _fetch_seoul_api_checked(key: str, service: str) -> tuple[list[dict], bool]:
    """
    서울 열린데이터광장 REST API 호출 → 전체 item 리스트 (페이지네이션 처리)

    응답 형식:
      { "response": { "header": {"resultCode":"00"}, "body": { "items": {"item":[...]}, "totalCount": N } } }

    resultCode "00" = 정상. 그 외는 오류로 처리.
    한 번에 최대 1000건 → totalCount > 1000 이면 여러 번 호출.
    """
    if not key:
        return [], True

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
                return all_items, False

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
            return all_items, False

    return all_items, True


# 운행상태 캐시 — 이 API는 호출 한 번에 ~5초, 엘리베이터+에스컬레이터 합쳐 ~15초라
# 요청마다 부르면 역 이름이 도착지인 /route 가 매번 15~30초 걸렸다(실측 2026-09).
# 고장 현황은 분 단위로 바뀌므로 TTL 동안 재사용하고, 만료 후엔 이전 값을 바로
# 돌려주면서 백그라운드에서 갱신한다(요청이 API 응답을 기다리지 않음). 캐시가
# 아예 없을 때(부팅 직후 워밍 전)만 동기로 한 번 조회하며, 동시 요청은 락으로
# 한 번만 부른다.
_BROKEN_TTL_OK_S   = 300.0   # 정상 조회 결과 재사용 시간
_BROKEN_TTL_FAIL_S = 60.0    # 조회 실패(일부/전체) 시 — 빨리 재시도
_broken_cache: tuple[float, float, set[str]] | None = None   # (조회시각, ttl, serials)
_broken_lock = threading.Lock()
_broken_refreshing = False


def _fetch_broken_serials() -> tuple[set[str], bool]:
    """
    현재 고장/운행중단 승강기 일련번호 집합 + 전부 정상 조회됐는지
    OA-22740 (엘리베이터, getWksnElvtr) + OA-22742 (에스컬레이터, getWksnEsctr) 합산

    핵심 필드:
      elvtrSn    — 승강기 일련번호 (CSV의 '승강기 일련번호' 와 동일)
      oprtngSitu — 가동현황 코드 (M=정상, 나머지=고장·중단)
    """
    broken: set[str] = set()
    all_ok = True
    for key, svc in [
        (SEOUL_ELEVATOR_KEY,  _SVC_ELEVATOR),
        (SEOUL_ESCALATOR_KEY, _SVC_ESCALATOR),
    ]:
        items, ok = _fetch_seoul_api_checked(key, svc)
        all_ok = all_ok and ok
        for item in items:
            serial = item.get("elvtrSn", "").strip()
            status = item.get("oprtngSitu", "")
            if serial and status not in _OPERATING_OK:
                broken.add(serial)
    return broken, all_ok


def _refresh_broken_serials() -> set[str]:
    global _broken_cache
    t0 = time.monotonic()
    broken, ok = _fetch_broken_serials()
    prev = _broken_cache
    # 실패했는데 이전 값이 있으면 이전 값 유지(빈 집합으로 덮으면 고장 승강기를 추천하게 됨)
    if not ok and prev is not None and not broken:
        broken = prev[2]
    _broken_cache = (time.monotonic(), _BROKEN_TTL_OK_S if ok else _BROKEN_TTL_FAIL_S, broken)
    log.info("승강기 운행상태 갱신: 고장 %d건, ok=%s, %.1fs", len(broken), ok, time.monotonic() - t0)
    return broken


def _refresh_broken_serials_bg() -> None:
    global _broken_refreshing
    try:
        with _broken_lock:
            _refresh_broken_serials()
    except Exception as e:
        log.warning("승강기 운행상태 백그라운드 갱신 실패: %s", e)
    finally:
        _broken_refreshing = False


def warm_broken_serials() -> None:
    """서버 기동 시 백그라운드로 한 번 채워 둔다 — 첫 요청이 기다리지 않게."""
    global _broken_refreshing
    if _broken_refreshing:
        return
    _broken_refreshing = True
    threading.Thread(target=_refresh_broken_serials_bg, daemon=True, name="broken-serials").start()


def get_broken_serials() -> set[str]:
    """
    현재 고장/운행중단 승강기 일련번호 집합(캐시). 캐시가 만료됐으면 이전 값을
    그대로 돌려주고 백그라운드 갱신만 건다. 캐시가 없으면 동기로 한 번 조회.
    """
    global _broken_refreshing
    hit = _broken_cache
    if hit is not None:
        fetched_at, ttl, serials = hit
        if time.monotonic() - fetched_at >= ttl and not _broken_refreshing:
            warm_broken_serials()
        return serials
    with _broken_lock:
        if _broken_cache is not None:           # 락 기다리는 동안 다른 요청이 채움
            return _broken_cache[2]
        return _refresh_broken_serials()


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
        """
        편의시설 CSV를 서버 시작 시 한 번 로드한다.
        파일이 없거나 경로가 틀리면 빈 DB로 조용히 넘어가지 않고 로그를 남긴다.
        """
        data_dir = os.path.abspath(os.path.expanduser(str(data_dir)))

        print("\n========== FACILITY CSV LOAD ==========")
        print(f"[CSV] data_dir     = {data_dir}")
        print(f"[CSV] dir exists   = {os.path.isdir(data_dir)}")

        if os.path.isdir(data_dir):
            try:
                print(f"[CSV] files        = {os.listdir(data_dir)}")
            except Exception as e:
                print(f"[CSV] listdir fail = {e}")
        else:
            log.error("[SubwayFacility] 데이터 폴더가 없습니다: %s", data_dir)

        def _fp(name: str) -> str:
            return os.path.join(data_dir, name)

        # 엘리베이터
        elev_path = _fp("서울교통공사_엘리베이터 설치 정보_20250310.csv")
        print(f"[CSV] elevator exists={os.path.isfile(elev_path)} path={elev_path}")

        if os.path.isfile(elev_path):
            try:
                self._elev = _load_elevators(elev_path)
                log.info("[SubwayFacility] 엘리베이터 %d역 로드", len(self._elev))
                print(f"[CSV] elevator stations={len(self._elev)}")
                print(f"[CSV] 숙대입구 elevators={self._elev.get('숙대입구', [])}")
            except Exception:
                log.exception("[SubwayFacility] 엘리베이터 CSV 로드 실패: %s", elev_path)
        else:
            log.error("[SubwayFacility] 엘리베이터 CSV 없음: %s", elev_path)

        # 에스컬레이터 1~8호선
        esc_path = _fp("서울교통공사_에스컬레이터 설치 정보_20250310.csv")
        print(f"[CSV] escalator exists={os.path.isfile(esc_path)} path={esc_path}")

        if os.path.isfile(esc_path):
            try:
                self._esc = _load_escalators(esc_path)
                log.info("[SubwayFacility] 에스컬레이터(1~8호선) %d역 로드", len(self._esc))
            except Exception:
                log.exception("[SubwayFacility] 에스컬레이터 CSV 로드 실패: %s", esc_path)
        else:
            log.error("[SubwayFacility] 에스컬레이터 CSV 없음: %s", esc_path)

        # 에스컬레이터 9호선 2·3단계
        # 실제 업로드 파일명(20260131)과 예전 파일명 둘 다 허용
        esc9_candidates = [
            "서울교통공사_9호선2_3단계 에스컬레이터 설치현황_20260131.CSV",
            "서울교통공사_9호선2_3단계 에스컬레이터 설치현황.CSV",
        ]

        esc9_path = None
        for filename in esc9_candidates:
            candidate = _fp(filename)
            if os.path.isfile(candidate):
                esc9_path = candidate
                break

        print(f"[CSV] escalator9 path={esc9_path}")

        if esc9_path:
            try:
                line9 = _load_escalators(esc9_path, is_line9=True)
                for stn, entries in line9.items():
                    self._esc.setdefault(stn, []).extend(entries)
                log.info("[SubwayFacility] 9호선 에스컬레이터 병합 완료")
            except Exception:
                log.exception("[SubwayFacility] 9호선 에스컬레이터 CSV 로드 실패: %s", esc9_path)
        else:
            log.warning("[SubwayFacility] 9호선 에스컬레이터 CSV 없음")

        # 휠체어리프트
        lift_path = _fp("서울교통공사_휠체어리프트 설치현황_20250310.csv")
        print(f"[CSV] lift exists={os.path.isfile(lift_path)} path={lift_path}")

        if os.path.isfile(lift_path):
            try:
                self._lift = _load_lifts(lift_path)
                log.info("[SubwayFacility] 휠체어리프트 %d역 로드", len(self._lift))
            except Exception:
                log.exception("[SubwayFacility] 휠체어리프트 CSV 로드 실패: %s", lift_path)
        else:
            log.error("[SubwayFacility] 휠체어리프트 CSV 없음: %s", lift_path)

        print(
            "[CSV] FINAL "
            f"elevator_stations={len(self._elev)} "
            f"escalator_stations={len(self._esc)} "
            f"lift_stations={len(self._lift)}"
        )
        print("=======================================\n")

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
        print(f"[FACILITY] station_name={station_name!r} normalized={stn!r}")
        print(f"[FACILITY] user_type={user_type} direction={direction}")
        print(f"[FACILITY] raw elevators={self._elev.get(stn, [])}")
        print(f"[FACILITY] raw escalators={self._esc.get(stn, [])}")
        print(
            f"[FACILITY] loaded counts: "
            f"elev={len(self._elev)} esc={len(self._esc)} lift={len(self._lift)}"
        )

        # 이 역에 해당 시설 데이터가 아예 없으면(광화문 등) 운행상태 조회 없이 끝낸다.
        if user_type not in _ELEVATOR_ONLY and user_type not in _ESC_OR_ELEV:
            return []
        if not self._elev.get(stn) and not (user_type in _ESC_OR_ELEV and self._esc.get(stn)):
            return []
        broken = get_broken_serials()
        need_dir = _ESC_DOWN if direction == "entering" else _ESC_UP

        if user_type in _ELEVATOR_ONLY:
            active = self._active(self._elev.get(stn, []), broken)
            return self._with_coord(stn, active)

        if user_type in _ESC_OR_ELEV:
            active_esc = self._active(self._esc.get(stn, []), broken)
            dir_matched = [e for e in active_esc if _esc_dir_ok(e.get("direction"), need_dir)]
            active_elev = self._active(self._elev.get(stn, []), broken)
            return self._with_coord(stn, dir_matched + active_elev)

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
        return {**best, **describe_exit(station_name, best, candidates, direction)}

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


_FACILITY_LABEL = {"elevator": "엘리베이터", "escalator": "에스컬레이터", "lift": "휠체어리프트"}


def describe_exit(station_name: str, best: dict, candidates: list[dict],
                  direction: str = "entering") -> dict:
    """
    고른 출구(best) → FE 표시용 정보. 같은 출구번호에 엘리베이터·에스컬레이터가
    함께 있으면(후보 안에서) 둘 다 알려준다.
      { station:"숙대입구역", exit_no:"10", facilities:["elevator"],
        message:"숙대입구역 10번 출구 엘리베이터를 이용하세요." }
    direction="exiting"(역에서 나옴)이면 "…엘리베이터로 나오세요."
    """
    exit_no = best["exit_no"]
    types = []
    for c in candidates:
        if c.get("exit_no") == exit_no and c.get("type") not in types:
            types.append(c.get("type"))
    if best.get("type") not in types:
        types.insert(0, best.get("type"))
    order = {"elevator": 0, "escalator": 1, "lift": 2}
    types.sort(key=lambda t: order.get(t, 9))
    station = f"{_normalize_station(station_name)}역"
    label = "·".join(_FACILITY_LABEL.get(t, t) for t in types)
    return {
        "station":    station,
        "exit_no":    exit_no,
        "facilities": types,
        "direction":  direction,
        "message":    (f"{station} {exit_no}번 출구 {label}로 나오세요." if direction == "exiting"
                       else f"{station} {exit_no}번 출구 {label}를 이용하세요."),
    }


def get_facility_db() -> SubwayFacilityDB:
    global _db
    if _db is None:
        _db = SubwayFacilityDB()
    return _db