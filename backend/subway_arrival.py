"""
서울시 지하철 실시간 도착정보 조회.

공공데이터포털 '서울시 지하철 실시간 도착정보' (제공: 서울교통공사 등, 호스트:
swopenapi.seoul.go.kr/api/subway). 역명(예: "강남역" → "강남")으로 조회하며,
한 역에 여러 노선(운영사)이 겹치는 경우 API가 모든 노선의 열차를 섞어 돌려주므로
line_no 로 필터링해 요청한 호선만 골라낸다(그래도 없으면 첫 결과로 폴백).

인증키: config.SEOUL_REALTIME_KEY (env SEOUL_REALTIME_KEY). 미설정이면 모든
함수가 None / 빈 결과를 돌려주고 절대 예외를 던지지 않는다 — bus_arrival.py 와
동일한 graceful degradation 원칙.
"""
from __future__ import annotations

import time
from datetime import datetime
from typing import Any

import requests

try:
    from config import SEOUL_REALTIME_KEY
except Exception:                       # config 에 아직 없을 때도 임포트는 되게
    import os
    SEOUL_REALTIME_KEY = os.environ.get("SEOUL_REALTIME_KEY", "")

_BASE = "http://swopenapi.seoul.go.kr/api/subway"
_TIMEOUT = 6
_CACHE_TTL_S = 15.0                     # 실시간이지만 15초 안엔 재호출 안 함(쿼터/부하)

# subwayId(API 응답) → 호선 번호. 표준 공공데이터 코드(1001~1009 = 1~9호선).
# 확인 안 된 지선/광역철도는 넣지 않는다(틀린 매핑은 실시간을 조용히 오염시킨다).
_SUBWAY_ID_TO_LINE: dict[str, str] = {
    "1001": "1", "1002": "2", "1003": "3", "1004": "4",
    "1005": "5", "1006": "6", "1007": "7", "1008": "8", "1009": "9",
}

_cache: dict[str, tuple[float, Any]] = {}


# ── 저수준 HTTP ──────────────────────────────────────────────────────────────
def _get(station: str) -> dict | None:
    if not SEOUL_REALTIME_KEY:
        return None
    url = f"{_BASE}/{SEOUL_REALTIME_KEY}/json/realtimeStationArrival/0/20/{station}"
    try:
        r = requests.get(url, timeout=_TIMEOUT)
    except requests.RequestException as e:
        print(f"[subway_arrival] 요청 실패 {station}: {e}")
        return None
    if r.status_code != 200:
        print(f"[subway_arrival] HTTP {r.status_code}: {r.text[:160]}")
        return None
    try:
        data = r.json()
    except ValueError:
        print(f"[subway_arrival] JSON 파싱 실패: {r.text[:160]}")
        return None
    result = data.get("errorMessage") or {}
    code = str(result.get("code", "INFO-000"))
    if code not in ("INFO-000",):       # INFO-200 = 데이터없음(정상), 그 외 오류
        if code != "INFO-200":
            print(f"[subway_arrival] 응답 코드 {code}: {result.get('message')}")
        return data if code == "INFO-200" else None
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


def _line_no(it: dict) -> str | None:
    subway_id = str(it.get("subwayId") or "").strip()
    if subway_id in _SUBWAY_ID_TO_LINE:
        return _SUBWAY_ID_TO_LINE[subway_id]
    # 매핑 안 된 노선(지선/광역철도)은 trainLineNm 선두 숫자로 최대한 추정.
    name = str(it.get("trainLineNm") or "")
    digits = "".join(ch for ch in name.split("호선")[0] if ch.isdigit())
    return digits or None


def _normalize_train(it: dict) -> dict:
    sec = _to_int(it.get("barvlDt"))
    arvl_cd = str(it.get("arvlCd", "")).strip()
    msg = (it.get("arvlMsg2") or it.get("arvlMsg3") or "").strip()
    return {
        "seconds":     sec if sec > 0 else None,
        "text":        msg or None,
        "current_pos": (it.get("bstatnNm") or "").strip() or None,
        "line_no":     _line_no(it),
        "direction":   (it.get("trainLineNm") or "").strip() or None,
        "updn_line":   (it.get("updnLine") or "").strip() or None,
        "train_type":  (it.get("btrainSttus") or "").strip() or None,
        "arriving":    arvl_cd in ("0", "1") or "전역" in msg or "곧" in msg,
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


def _norm_station(station: str) -> str:
    # 카카오 stops[].name 은 "강남역", "강남역(2)" 처럼 "역"과 괄호가 붙어 오므로,
    # API가 기대하는 순수 역명("강남")으로 맞춘다.
    s = (station or "").strip().split("(")[0].strip()
    return s[:-1] if s.endswith("역") else s


# ── 공개 API ────────────────────────────────────────────────────────────────
def station_arrivals(station: str) -> list[dict] | None:
    """한 역의 실시간 전체 열차(모든 노선 섞임). 키 없음/오류 시 None."""
    name = _norm_station(station)
    if not name:
        return None
    return _cached(
        f"st:{name}",
        lambda: [_normalize_train(it) for it in _items(_get(name))] or None,
    )


def arrival_for_boarding(station: str, line_no: str | None = None) -> dict:
    """
    FE용 집계. 카카오 스텝의 승차역명(+ 있으면 노선번호)으로 실시간 도착을 찾아
    돌려준다.

    반환(항상 dict, 실패해도 available=false 로):
      { available, station, line_no, trains:[...], data_age_s, reason? }
    """
    out: dict = {
        "available": False, "station": station, "line_no": line_no,
        "trains": [], "data_age_s": None,
    }
    if not SEOUL_REALTIME_KEY:
        out["reason"] = "key_unset"
        return out

    trains = station_arrivals(station)
    if trains is None:
        out["reason"] = "api_unavailable"
        return out

    if line_no:
        matched = [t for t in trains if t["line_no"] == str(line_no).strip()]
        # 요청한 호선 열차가 하나도 없으면(같은 역명을 다른 노선이 쓰는 경우),
        # 그래도 뭔가는 보여주는 게 나으므로 전체로 폴백한다 — FE가
        # line_no 불일치를 감지해 안내 문구를 붙인다.
        trains = matched if matched else trains

    if not trains:
        out["reason"] = "no_active_train"
        return out

    trains = sorted(trains, key=lambda t: (t["seconds"] is None, t["seconds"] or 0))
    out.update({
        "available": True,
        "trains": trains[:5],
        "data_age_s": trains[0]["data_age_s"],
    })
    return out
