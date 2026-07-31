"""
lowfloor_bus.py — 노선별 저상버스 보유율 (서울 열린데이터광장 OA-22229)

OA-22229 "서울시 저상버스 도입 노선 및 노선별 보유율"은 REST API가 아니라
XLSX 파일 다운로드로만 제공된다.

다운로드:
  https://data.seoul.go.kr/dataList/OA-22229/F/1/datasetView.do
  → XLSX 다운로드 후 config.LOWFLOOR_BUS_XLSX 경로에 위치시킬 것
  → 실시간 아님(2025.04.25 갱신본 기준), 노선번호 기준 정적 보유율 정보

실제 파일 구조(2025.04.25 배포본, 349행 4열, 헤더에 개행 포함):
  '노선\n번호'   : 노선번호 — 숫자만(예: 100) 또는 영문 포함(예: '01A', '0411') 혼재.
                   openpyxl이 순수 숫자는 int로 반환하므로 반드시 str() 변환 필요.
  '인가\n대수'   : 인가대수 (int)
  '저상버스 대수' : 저상버스 대수 (int)
  '저상보유율'   : 0~1 사이 소수(예: 0.6129...) — 퍼센트 아님, 로딩 시 ×100 변환.

카카오 대중교통 API는 저상버스 여부를 전혀 제공하지 않아(요청/응답 모두),
이 정적 데이터를 vehicles[].name(버스 번호)으로 매칭해 보완한다.
"""

import logging

import openpyxl

from config import LOWFLOOR_BUS_XLSX

log = logging.getLogger(__name__)

_cache: dict[str, dict] | None = None

# 실제 배포본 헤더 기준(위 docstring 참고). 향후 배포본에서 헤더가 바뀌면
# 여기에 후보를 추가하면 된다 — 개행/공백은 _clean_header()가 미리 제거한다.
_COLUMN_ALIASES = {
    "route":    ["노선번호", "노선명", "버스노선번호"],
    "licensed": ["인가대수"],
    "lowfloor": ["저상버스대수", "저상대수"],
    "ratio":    ["저상보유율", "보유율", "저상버스보유율"],
}


def _clean_header(value) -> str:
    """헤더 셀의 개행·공백 제거 (예: '노선\\n번호' → '노선번호')."""
    return "".join(str(value).split()) if value is not None else ""


def _normalize_route(route_no) -> str:
    """
    openpyxl은 숫자만 있는 노선번호(예: 100)를 int로 반환하고,
    영문 포함 노선번호(예: '01A')는 str로 반환한다 — 둘 다 문자열로 통일.
    '402번' / ' 402 ' 같은 표기 편차도 함께 제거.
    """
    return str(route_no).strip().rstrip("번").strip()


def _find_col(headers: list[str], aliases: list[str]) -> int | None:
    for alias in aliases:
        if alias in headers:
            return headers.index(alias)
    return None


def _load() -> dict[str, dict]:
    """
    XLSX 1회 로드 후 캐싱. 파일이 없거나 컬럼명이 예상과 다르면
    빈 dict를 반환해 저상버스 정보 없이 나머지 기능은 그대로 동작하게 한다.
    """
    global _cache
    if _cache is not None:
        return _cache

    result: dict[str, dict] = {}
    try:
        wb = openpyxl.load_workbook(LOWFLOOR_BUS_XLSX, data_only=True, read_only=True)
        ws = wb[wb.sheetnames[0]]

        rows = ws.iter_rows(values_only=True)
        header_row = next(rows)
        headers = [_clean_header(h) for h in header_row]

        col_route    = _find_col(headers, _COLUMN_ALIASES["route"])
        col_licensed = _find_col(headers, _COLUMN_ALIASES["licensed"])
        col_lowfloor = _find_col(headers, _COLUMN_ALIASES["lowfloor"])
        col_ratio    = _find_col(headers, _COLUMN_ALIASES["ratio"])

        if col_route is None or col_ratio is None:
            log.warning(
                "[저상버스] XLSX 헤더에서 노선번호/보유율 컬럼을 못 찾음 "
                "(실제 헤더: %s) — lowfloor_bus.py의 _COLUMN_ALIASES 확인 필요",
                headers,
            )
            wb.close()
            _cache = {}
            return _cache

        for row in rows:
            if row[col_route] is None:
                continue
            route = _normalize_route(row[col_route])
            if not route:
                continue

            raw_ratio = row[col_ratio]
            try:
                ratio_frac = float(raw_ratio) if raw_ratio is not None else 0.0
            except (TypeError, ValueError):
                ratio_frac = 0.0
            # 0~1 소수 → 퍼센트. 혹시 이미 퍼센트(예: 61.29)로 온 배포본이면
            # 1.0 초과 값은 그대로 두어 이중 변환을 방지.
            ratio_pct = ratio_frac * 100 if ratio_frac <= 1.0 else ratio_frac

            result[route] = {
                "route":    route,
                "licensed": int(row[col_licensed]) if col_licensed is not None and row[col_licensed] is not None else None,
                "lowfloor": int(row[col_lowfloor]) if col_lowfloor is not None and row[col_lowfloor] is not None else None,
                "ratio":    round(ratio_pct, 1),
            }

        wb.close()
        log.info("[저상버스] %d개 노선 데이터 로딩 완료 (%s)", len(result), LOWFLOOR_BUS_XLSX)

    except FileNotFoundError:
        log.warning(
            "[저상버스] 데이터 파일 없음 (%s) — 저상버스 정보 없이 동작. "
            "https://data.seoul.go.kr/dataList/OA-22229/F/1/datasetView.do 에서 다운로드 필요",
            LOWFLOOR_BUS_XLSX,
        )
        result = {}
    except Exception as e:
        log.warning("[저상버스] 데이터 로딩 실패: %s", e)
        result = {}

    _cache = result
    return _cache


def get_lowfloor_info(route_no: str) -> dict | None:
    """
    버스 번호(카카오 vehicles[].name과 동일한 표기, 예: '402')로 조회.
    데이터 없거나 매칭 안 되면 None — 호출부는 일반 안내 문구로 폴백해야 한다.
    """
    data = _load()
    return data.get(_normalize_route(route_no))
