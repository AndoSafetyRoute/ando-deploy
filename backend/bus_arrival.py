"""
서울시 버스도착정보 실시간 조회.

공공데이터포털 '서울특별시_버스도착정보조회 서비스' (제공: 서울특별시,
호스트: ws.bus.go.kr/api/rest/arrive/*). busRouteId (+ stId, ord) 로 조회한다.

노선명("753") → busRouteId("100100118") 변환은 별도 서비스
('서울특별시_노선정보조회 서비스')가 활용신청돼 있어야 동적으로 가능하다(선택).
없으면 호출측이 busRouteId 를 직접 넘기거나, resolve_route_id() 가 None 을 돌려
FE 는 실시간 배지를 그냥 숨긴다(정적 카카오 시간 유지 — graceful degradation).

인증키: config.BUS_ARRIVAL_KEY (env BUS_ARRIVAL_KEY). 미설정이면 모든 함수가
None / 빈 결과를 돌려주고 절대 예외를 던지지 않는다.
"""
from __future__ import annotations

import time
from datetime import datetime
from typing import Any

import requests

try:
    from config import BUS_ARRIVAL_KEY, BUS_ROUTE_INFO_ENABLED
except Exception:                       # config 에 아직 없을 때도 임포트는 되게
    import os
    BUS_ARRIVAL_KEY = os.environ.get("BUS_ARRIVAL_KEY", "")
    BUS_ROUTE_INFO_ENABLED = os.environ.get("BUS_ROUTE_INFO_ENABLED", "") == "1"

_ARRIVE_BASE = "http://ws.bus.go.kr/api/rest/arrive"
_ROUTEINFO_BASE = "http://ws.bus.go.kr/api/rest/busRouteInfo"
_TIMEOUT = 6
_CACHE_TTL_S = 15.0                     # 실시간이지만 15초 안엔 재호출 안 함(쿼터/부하)

# 혼잡도 코드(서울) → 라벨
_CONGESTION = {0: None, 3: "여유", 4: "보통", 5: "혼잡", 6: "매우혼잡"}

# 노선정보조회 서비스가 없을 때 쓰는 최소 seed. 정확한 값만 넣는다(틀린 ID는
# 실시간을 조용히 오염시키므로 넣지 않느니만 못하다). 확인된 것만 추가할 것.
_SEED_ROUTE_IDS: dict[str, str] = {
    # "노선명(정확표기)": "busRouteId",
}

_cache: dict[str, tuple[float, Any]] = {}


# ── 저수준 HTTP ──────────────────────────────────────────────────────────────
def _get(base: str, path: str, params: dict) -> dict | None:
    if not BUS_ARRIVAL_KEY:
        return None
    q = {"serviceKey": BUS_ARRIVAL_KEY, "resultType": "json", **params}
    try:
        r = requests.get(f"{base}/{path}", params=q, timeout=_TIMEOUT)
    except requests.RequestException as e:
        print(f"[bus_arrival] 요청 실패 {path}: {e}")
        return None
    if r.status_code != 200:
        print(f"[bus_arrival] {path} HTTP {r.status_code}: {r.text[:160]}")
        return None
    try:
        data = r.json()
    except ValueError:
        print(f"[bus_arrival] {path} JSON 파싱 실패: {r.text[:160]}")
        return None
    hdr = (data.get("msgHeader") or {})
    if str(hdr.get("headerCd", "0")) not in ("0", "4"):   # 4 = 결과없음(정상)
        print(f"[bus_arrival] {path} 응답 코드 {hdr.get('headerCd')}: {hdr.get('headerMsg')}")
        return None
    return data


def _items(data: dict | None) -> list[dict]:
    if not data:
        return []
    body = data.get("msgBody") or {}
    lst = body.get("itemList")
    if lst is None:
        return []
    return lst if isinstance(lst, list) else [lst]


# ── 파싱 ────────────────────────────────────────────────────────────────────
def _to_int(v: Any, default: int = 0) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _data_age_s(mk_tm: str | None) -> int | None:
    if not mk_tm:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(mk_tm.strip(), fmt)
            return max(0, int(datetime.now().timestamp() - dt.timestamp()))
        except ValueError:
            continue
    return None


def _bus_slot(it: dict, n: int) -> dict | None:
    """n=1 또는 2 (다음차/다다음차). 유효 도착정보 없으면 None."""
    msg = (it.get(f"arrmsg{n}") or "").strip()
    sec = _to_int(it.get(f"traTime{n}"))
    if not msg or msg in ("출발대기", "운행종료") or (sec <= 0 and "곧 도착" not in msg and "전" not in msg):
        # 출발대기/운행종료/빈 슬롯 → 표시할 실시간 없음
        if msg in ("", "출발대기", "운행종료"):
            return None
    return {
        "seconds":     sec if sec > 0 else None,
        "text":        msg or None,
        "vehicle_no":  (it.get(f"plainNo{n}") or "").strip() or None,
        "congestion":  _CONGESTION.get(_to_int(it.get(f"full{n}")), None),
        "arriving":    str(it.get(f"isArrive{n}", "0")) == "1",
        "last_bus":    str(it.get(f"isLast{n}", "0")) == "1",
    }


def _normalize_stop(it: dict) -> dict:
    buses = [b for b in (_bus_slot(it, 1), _bus_slot(it, 2)) if b]
    return {
        "st_id":     (it.get("stId") or "").strip() or None,
        "ars_id":    (it.get("arsId") or "").strip() or None,
        "stop_name": (it.get("stNm") or "").strip() or None,
        "ord":       _to_int(it.get("staOrd")) or None,
        "route_name": (it.get("rtNm") or it.get("busRouteAbrv") or "").strip() or None,
        "buses":     buses,
        "data_age_s": _data_age_s(it.get("mkTm")),
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
def resolve_route_id(route_name: str) -> str | None:
    """노선명 → busRouteId. seed 표 우선, 그다음 노선정보조회 서비스(선택)."""
    if not route_name:
        return None
    name = route_name.strip()
    if name in _SEED_ROUTE_IDS:
        return _SEED_ROUTE_IDS[name]
    if not BUS_ROUTE_INFO_ENABLED:
        return None

    def _fetch():
        data = _get(_ROUTEINFO_BASE, "getBusRouteList", {"strSrch": name})
        for it in _items(data):
            if (it.get("busRouteNm") or it.get("busRouteAbrv") or "").strip() == name:
                return (it.get("busRouteId") or "").strip() or None
        # 정확 일치 없으면 첫 결과
        its = _items(data)
        return (its[0].get("busRouteId") or "").strip() if its else None

    return _cached(f"rid:{name}", _fetch)


def route_arrivals(bus_route_id: str) -> list[dict] | None:
    """한 노선의 전체 정류소 실시간 도착. 키 없음/오류 시 None."""
    if not bus_route_id:
        return None
    return _cached(
        f"all:{bus_route_id}",
        lambda: [_normalize_stop(it) for it in _items(
            _get(_ARRIVE_BASE, "getArrInfoByRouteAll", {"busRouteId": bus_route_id})
        )] or None,
    )


def _norm(s: str) -> str:
    return "".join(ch for ch in (s or "") if not ch.isspace()).replace(".", "").lower()


def arrival_for_boarding(
    route_name: str,
    stop_name: str | None = None,
    ars_id: str | None = None,
    bus_route_id: str | None = None,
    walk_remaining_s: float | None = None,
) -> dict:
    """
    FE용 집계. 카카오 스텝의 노선명 + 승차 정류소명(또는 arsId)으로 실시간 도착을
    찾아, 도보 잔여시간 대비 놓칠 위험까지 계산해 돌려준다.

    반환(항상 dict, 실패해도 available=false 로):
      { available, route_name, bus_route_id, stop, buses:[...],
        next_bus_s, will_miss(bool|None), margin_s(int|None), data_age_s }
    """
    out: dict = {
        "available": False, "route_name": route_name, "bus_route_id": None,
        "stop": None, "buses": [], "next_bus_s": None,
        "will_miss": None, "margin_s": None, "data_age_s": None,
    }
    rid = (bus_route_id or "").strip() or resolve_route_id(route_name)
    if not rid:
        out["reason"] = "route_id_unresolved"
        return out
    out["bus_route_id"] = rid

    stops = route_arrivals(rid)
    if stops is None:
        out["reason"] = "api_unavailable"
        return out

    target = None
    if ars_id:
        target = next((s for s in stops if s["ars_id"] == str(ars_id).strip()), None)
    if target is None and stop_name:
        key = _norm(stop_name)
        target = next((s for s in stops if _norm(s["stop_name"]) == key), None)
        if target is None:                       # 부분일치 폴백
            target = next((s for s in stops
                           if key and (key in _norm(s["stop_name"]) or _norm(s["stop_name"]) in key)), None)
    if target is None:
        out["reason"] = "stop_not_matched"
        return out

    buses = target["buses"]
    out.update({
        "available": bool(buses),
        "stop": target["stop_name"],
        "buses": buses,
        "data_age_s": target["data_age_s"],
    })
    next_s = next((b["seconds"] for b in buses if b.get("seconds")), None)
    out["next_bus_s"] = next_s
    if next_s is not None and walk_remaining_s is not None:
        margin = int(next_s - walk_remaining_s)
        out["margin_s"] = margin
        out["will_miss"] = margin < 0
    if not buses:
        out["reason"] = "no_active_bus"
    return out
