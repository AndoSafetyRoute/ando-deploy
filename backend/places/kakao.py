"""
카카오 로컬 API — 장소/주소 검색 및 결과 랭킹
"""
import re
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from config import KAKAO_REST_KEY, KAKAO_CENTER

_HEADERS = lambda: {"Authorization": f"KakaoAK {KAKAO_REST_KEY}"}

_CATEGORY_BONUS = {
    "지하철": 12, "전철": 12, "기차": 12, "공항": 12,
    "버스":   10,
    "병원":    8, "대학교":  8, "학교":  8,
    "관공서":  6, "공공기관": 6,
    "쇼핑":    4, "마트":    4,
    "음식점":  2, "카페":    2,
}


def _kakao_keyword(q: str) -> tuple:
    params = {
        "query": q,
        "x":     KAKAO_CENTER["x"],
        "y":     KAKAO_CENTER["y"],
        "size":  15,
        "sort":  "accuracy",
    }
    try:
        r    = requests.get(
            "https://dapi.kakao.com/v2/local/search/keyword.json",
            headers=_HEADERS(), params=params, timeout=3,
        )
        body = r.json()
        if r.status_code != 200:
            return [], {"status": r.status_code, "body": body}

        out, seen = [], set()
        for doc in body.get("documents", []):
            name = re.sub(r"<[^>]+>", "", doc["place_name"])
            key  = (name, doc["x"], doc["y"])
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "name":     name,
                "lon":      float(doc["x"]),
                "lat":      float(doc["y"]),
                "type":     "place",
                "address":  doc.get("road_address_name") or doc.get("address_name", ""),
                "category": doc.get("category_group_name", "") or doc.get("category_name", "").split(" > ")[-1],
                "distance": doc.get("distance", ""),
                "phone":    doc.get("phone", ""),
                "url":      doc.get("place_url", ""),
            })
        return out, {"status": r.status_code, "body": body}
    except Exception as e:
        return [], {"status": -1, "body": {"exception": str(e)}}


def _kakao_address(q: str) -> tuple:
    params = {"query": q, "analyze_type": "similar", "size": 5}
    try:
        r    = requests.get(
            "https://dapi.kakao.com/v2/local/search/address.json",
            headers=_HEADERS(), params=params, timeout=3,
        )
        body = r.json()
        if r.status_code != 200:
            return [], {"status": r.status_code, "body": body}

        out = []
        for doc in body.get("documents", []):
            ra   = doc.get("road_address") or {}
            aa   = doc.get("address")      or {}
            name = ra.get("address_name") or aa.get("address_name", "")
            if not name or not doc.get("x"):
                continue
            out.append({
                "name":     name,
                "lon":      float(doc["x"]),
                "lat":      float(doc["y"]),
                "type":     "address",
                "address":  ra.get("address_name", "") or aa.get("address_name", ""),
                "category": "주소",
                "distance": "", "phone": "", "url": "",
            })
        return out, {"status": r.status_code, "body": body}
    except Exception as e:
        return [], {"status": -1, "body": {"exception": str(e)}}


def _rank_score(item: dict, query: str) -> float:
    q = query.strip().lower()
    n = item["name"].lower()

    if n == q:
        text = 100
    elif n.startswith(q):
        text = 85
    elif q in n:
        pos  = n.index(q)
        text = max(60, 75 - pos * 2)
    else:
        text = 40

    try:
        dist_m = int(item.get("distance") or 9999)
    except ValueError:
        dist_m = 9999
    dist_score = 15 if dist_m <= 300 else 10 if dist_m <= 1000 else 5 if dist_m <= 3000 else 0

    cat       = item.get("category", "")
    cat_score = next((v for k, v in _CATEGORY_BONUS.items() if k in cat), 0)

    return text + dist_score + cat_score


def search_places(q: str, limit: int = 10) -> list:
    """키워드+주소 병렬 검색 후 병합·재정렬."""
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_kw = ex.submit(_kakao_keyword, q)
        f_ad = ex.submit(_kakao_address, q)
        kw_list, _ = f_kw.result()
        ad_list, _ = f_ad.result()

    results, seen_coords = [], set()
    for item in kw_list + ad_list:
        ck = (round(item["lon"], 4), round(item["lat"], 4))
        if ck not in seen_coords:
            seen_coords.add(ck)
            results.append(item)

    results.sort(key=lambda x: _rank_score(x, q), reverse=True)
    return results[:limit]


def debug_raw(q: str) -> dict:
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_kw = ex.submit(_kakao_keyword, q)
        f_ad = ex.submit(_kakao_address, q)
        kw_list, kw_info = f_kw.result()
        ad_list, ad_info = f_ad.result()
    return {
        "query":   q,
        "keyword": {"http_status": kw_info["status"], "raw": kw_info["body"], "parsed": kw_list},
        "address": {"http_status": ad_info["status"], "raw": ad_info["body"], "parsed": ad_list},
    }
