"""
서울시 지하철 실시간 도착정보 조회.

서울 열린데이터광장(data.seoul.go.kr) '지하철 실시간 도착정보' —
swopenapi.seoul.go.kr 전용 키로 인증한다(호출 방식이 버스 API와 다름: 키가
쿼리스트링이 아니라 URL 경로에 들어간다). 역명으로 바로 조회 가능해서
버스처럼 별도의 ID 변환 서비스가 필요 없다.

한 역엔 상행/하행(또는 내선/외선) 두 방향의 열차가 같이 조회되는데, 이 API는
방향을 노선 위상(topology) 없이는 확정적으로 알 수 없다. 그래서 방향을 추측해서
숨기지 않고, 방향 텍스트(도착지 방면)를 항상 같이 돌려줘서 사용자가 스스로
맞는 방향인지 확인할 수 있게 한다(실제 역 전자게시판과 같은 방식) — 틀린
방향을 자신 있게 보여주는 것보다 훨씬 안전하다.

인증키: config.SEOUL_REALTIME_KEY (env SEOUL_REALTIME_KEY). 미설정이면 모든
함수가 None / 빈 결과를 돌려주고 절대 예외를 던지지 않는다.
"""
from __future__ import annotations

import re
import time
from datetime import datetime
from typing import Any

import requests

try:
    from config import SEOUL_REALTIME_KEY
except Exception:
    import os
    SEOUL_REALTIME_KEY = os.environ.get("SEOUL_REALTIME_KEY", "")

_BASE = "http://swopenapi.seoul.go.kr/api/subway"
_TIMEOUT = 6
_CACHE_TTL_S = 15.0                     # 실시간이지만 15초 안엔 재호출 안 함(쿼터/부하)

# subwayId(서울 열린데이터광장 코드) → 사용자에게 보여줄 노선명. 카카오
# vehicle.name("4호선" 등)에서 "호선"만 뗀 값과 매칭하려고 만든 표.
_LINE_NAMES = {
    "1001": "1", "1002": "2", "1003": "3", "1004": "4",
    "1005": "5", "1006": "6", "1007": "7", "1008": "8", "1009": "9",
    # 1032/1063/1065는 서울역 실측 응답(trainLineNm·행선지)으로 확인(2026-09).
    # 나머지는 서울 열린데이터광장 실시간 도착정보 명세의 subwayId 표 기준.
    "1032": "GTX-A", "1061": "중앙", "1063": "경의중앙", "1065": "공항철도",
    "1067": "경춘", "1075": "수인분당", "1077": "신분당", "1081": "경강",
    "1092": "우이신설", "1093": "서해", "1094": "신림",
}

_cache: dict[str, tuple[float, Any]] = {}


# 카카오가 동명역 구분용으로 붙이는 괄호 설명("숙대입구(서울시교육청)" 등)을 뗀다.
# 실시간 API는 순수 역명만 인식해서, 안 떼면 조용히 매칭 실패한다(실측 확인, 2026-09).
_STATION_SUFFIX_RE = re.compile(r"\s*[\(（][^)）]*[\)）]\s*$")


def _clean_station_name(name: str) -> str:
    return _STATION_SUFFIX_RE.sub("", (name or "").strip()).strip()


# ── 저수준 HTTP ──────────────────────────────────────────────────────────────
def _get(station_name: str) -> dict | None:
    station_name = _clean_station_name(station_name)
    if not SEOUL_REALTIME_KEY or not station_name:
        return None
    url = f"{_BASE}/{SEOUL_REALTIME_KEY}/json/realtimeStationArrival/0/20/{station_name}"
    try:
        r = requests.get(url, timeout=_TIMEOUT)
    except requests.RequestException as e:
        print(f"[subway_arrival] 요청 실패: {e}")
        return None
    if r.status_code != 200:
        print(f"[subway_arrival] HTTP {r.status_code}: {r.text[:160]}")
        return None
    try:
        data = r.json()
    except ValueError:
        print(f"[subway_arrival] JSON 파싱 실패: {r.text[:160]}")
        return None
    err = (data.get("errorMessage") or {})
    if str(err.get("status", "")) != "200":
        print(f"[subway_arrival] 응답 코드 {err.get('code')}: {err.get('message')}")
        return None
    return data


def _items(data: dict | None) -> list[dict]:
    if not data:
        return []
    lst = data.get("realtimeArrivalList")
    if lst is None:
        return []
    return lst if isinstance(lst, list) else [lst]


# ── 파싱 ────────────────────────────────────────────────────────────────────
def _to_int(v: Any, default: int = 0) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _data_age_s(recptn_dt: str | None) -> int | None:
    if not recptn_dt:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
        try:
            dt = datetime.strptime(recptn_dt.strip(), fmt)
            return max(0, int(datetime.now().timestamp() - dt.timestamp()))
        except ValueError:
            continue
    return None


def _train_slot(it: dict) -> dict:
    sec = _to_int(it.get("barvlDt"))
    arvl_cd = (it.get("arvlCd") or "").strip()
    return {
        "seconds":     sec if sec > 0 else None,
        "text":        (it.get("arvlMsg2") or "").strip() or None,
        "current_pos": (it.get("arvlMsg3") or "").strip() or None,
        "line_no":     _LINE_NAMES.get((it.get("subwayId") or "").strip()),
        # "봉화산행" 등 종착지 방면 — 방향을 확정할 수 없으니 항상 같이 보여준다.
        "direction":   (it.get("bstatnNm") or "").strip() or None,
        "updn_line":   (it.get("updnLine") or "").strip() or None,
        "train_type":  (it.get("btrainSttus") or "").strip() or None,
        # arvlCd: 0/1/4/5 =진입~전역도착 근접 상태, 99=일반운행중
        "arriving":    arvl_cd in ("0", "1", "4", "5"),
        "data_age_s":  _data_age_s(it.get("recptnDt")),
    }


# ── 캐시 래퍼 ───────────────────────────────────────────────────────────────
def _cached(key: str, producer):
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]
    val = producer()
    if val is not None:
        _cache[key] = (now, val)
    return val


# ── 공개 API ────────────────────────────────────────────────────────────────
def station_arrivals(station_name: str) -> list[dict] | None:
    """한 역의 실시간 도착 전체(양방향 다 섞여 있음). 키 없음/오류 시 None."""
    if not station_name:
        return None

    def _fetch():
        rows = [_train_slot(it) for it in _items(_get(station_name))]
        # 카카오는 "서울역"처럼 "역"을 붙여 주는데, 실시간 API에서 1·4호선/경의중앙/
        # 공항철도는 "서울"로 등록돼 있고 "서울역"으로 찾으면 GTX-A 열차만 나온다
        # (실측, 2026-09). "역"으로 끝나면 뗀 이름으로도 조회해 합친다 — 원래 이름이
        # "역"으로 끝나는 역도 첫 조회 결과가 그대로 남으니 깨지지 않는다.
        base = _clean_station_name(station_name)
        if len(base) > 2 and base.endswith("역"):
            rows += [_train_slot(it) for it in _items(_get(base[:-1]))]
        return rows or None

    return _cached(f"st:{station_name}", _fetch)


def arrival_for_boarding(station_name: str, line_no: str | None = None) -> dict:
    """
    FE용 집계. 카카오 지하철 스텝의 승차역명(+ 노선번호, "4"처럼 "호선" 뗀 값)으로
    실시간 도착을 찾아 돌려준다.

    방향(상행/하행)은 노선 위상 정보 없이는 어느 쪽이 사용자의 하차 방향인지
    확정할 수 없다 — 그래서 이 함수는 방향을 추측하지 않고, 가장 빨리 오는 열차부터
    최대 2개(보통 서로 다른 방향)를 방향 텍스트(direction)와 함께 그대로 돌려준다.
    FE는 "OO행" 텍스트를 같이 보여줘서 사용자가 맞는 방향인지 바로 확인할 수 있게 한다.

    반환(항상 dict, 실패해도 available=false 로):
      { available, station, line_no, trains:[...], data_age_s, reason? }
    """
    out: dict = {
        "available": False, "station": station_name, "line_no": line_no,
        "trains": [], "data_age_s": None,
    }
    if not SEOUL_REALTIME_KEY:
        out["reason"] = "key_unset"
        return out

    items = station_arrivals(station_name)
    if items is None:
        out["reason"] = "api_unavailable"
        return out

    if line_no:
        # FE는 카카오 vehicle.name에서 "호선"만 떼서 보내므로 "경의중앙선"·"수인분당선"·
        # "신분당선"처럼 "선"이 남는다 — 표 값("경의중앙" 등)과 맞추려고 뗀다.
        wanted = re.sub(r"(호선|선)$", "", line_no.strip())
        filtered = [t for t in items if t["line_no"] == wanted]
        # 노선 코드 매칭 실패(표에 없는 노선 등) 시 전체로 폴백 — 방향 텍스트로
        # 사용자가 스스로 구분 가능하니 아예 숨기는 것보단 낫다.
        if filtered:
            items = filtered

    trains = sorted(
        (t for t in items if t["seconds"] is not None or t["arriving"]),
        key=lambda t: t["seconds"] if t["seconds"] is not None else 0,
    )[:2]

    out.update({
        "available": bool(trains),
        "trains": trains,
        "data_age_s": trains[0]["data_age_s"] if trains else None,
    })
    if not trains:
        out["reason"] = "no_active_train"
    return out
