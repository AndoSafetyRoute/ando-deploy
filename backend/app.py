"""
app.py — Ando 접근성 경로 탐색 FastAPI 서버
실행: uvicorn app:app --reload --host 0.0.0.0 --port 5000

--host 를 안 쓰면 uvicorn 기본값 127.0.0.1 로 떠서 이 PC 자신만 접속 가능하다 —
에뮬레이터(10.0.2.2)도, 실기기(LAN IP)도, 배포 서버도 전부 접속이 안 되는
"로그인은 성공하는데 그 다음 백엔드 호출이 전부 실패하는" 원인이 된다.
0.0.0.0 으로 띄워야 같은 네트워크의 다른 기기에서 접속할 수 있다.
"""
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Depends, Header
from sqlalchemy.orm import Session
from sqlalchemy import text
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import GEOJSON_PATH
from routing import build_graph, USER_TYPES, classify_zone, precompute_edge_costs
from routing.search import build_spatial_index, nearest_node
from routing.graph import haversine
from routing.cch_engine import build_cch_engine, CCHEngine
from routing.personal_cache import PersonalMetricCache
from places.kakao import search_places, debug_raw
from database import (
    init_db, get_db, get_or_create_user, update_user_type,
    get_user_profile, get_user_stats, save_user_route, get_user_routes,
    delete_user_route,
    get_user_bookmarks, save_user_bookmark, delete_user_bookmark,
    get_search_history, save_search_history,
    start_navigation, add_navigation_segment, complete_navigation,
    save_zone_observation, get_user_speed_profile, save_collect_batch,
    delete_user_account, get_personalization_status,
    get_slow_segments, save_segment_hardship_feedback, get_segment_hardship_feedback,
    save_segment_hardest_pick, get_segment_hardest_pick,
    start_session, record_gps_fix_stage, add_navigation_measurement, save_gps_batch,
    get_route_measurements,
)
from routing.speed import get_zone_key, estimate_route_time, get_default_speed
from routing.segments import build_navigation_segments, extract_waypoints
from routing.measurement_units import build_measurement_units
from routing.voice_guidance import calculate_bearing, get_turn_direction, generate_guidance_text
from routing.travel_time import estimate_route_time as estimate_nav_time
from firebase import verify_token, delete_firebase_user
from subway import get_facility_db, SubwayFacilityDB
from subway.facility import get_station_chargers
from lowfloor_bus import get_lowfloor_info
import bus_arrival
import subway_arrival

G = None
_spatial_index = None
_cch: CCHEngine | None = None
_personal_cache: PersonalMetricCache | None = None
_subway_db: SubwayFacilityDB | None = None
# extract_waypoints(G)는 그래프 전체 노드를 순회해 교차로를 찾는다 — 서울 전역
# 그래프(수십만 노드)에서 이걸 매 /route 요청마다 다시 계산하면 요청당 유의미한
# 지연이 생긴다. 그래프는 서버 실행 중 바뀌지 않으므로 1회만 계산해 재사용한다.
_waypoints_set: set | None = None


def _nav_segs_and_waypoints(path_nodes: list, user_type: str) -> tuple[list, list]:
    """
    path_nodes → (navigation_segments 응답 dict 리스트, waypoints 응답 dict 리스트).

    메인("type") 경로만 이걸 계산하고 compare 후보(distance/personal)는 안 붙여주고
    있었다 — 그 상태로 distance/personal 을 골라 안내를 시작하면 navigation_segments
    가 없어 지도 zone 색칠이 구식 getSegmentColor 폴백(3%/8% 고정 임계)으로 떨어지고
    회전 음성안내(waypoints)가 아예 안 나오는 문제가 있었다 (⑬ 활성화 전 발견).
    이 함수로 뽑아내 compare 후보들에도 동일하게 계산해 붙인다.
    """
    node_to_path_idx: dict = {}
    for i, n in enumerate(path_nodes):
        if n not in node_to_path_idx:
            node_to_path_idx[n] = i

    nav_segs = build_navigation_segments(G, path_nodes, user_type, waypoints_set=_waypoints_set)
    nav_time = estimate_nav_time(nav_segs, user_type)

    nav_segs_json = [
        {
            "segment_id":        s.segment_id,
            "length_m":          round(s.length_m, 1),
            "slope_mean":        s.slope_mean,
            "slope_max":         s.slope_max,
            "slope_stddev":      s.slope_stddev,
            "zone":              s.zone,
            "is_stairs":         s.is_stairs,
            "estimated_seconds": (nav_time["segments"][i]["estimated_seconds"]
                                  if nav_time.get("segments") and i < len(nav_time["segments"])
                                  else 0.0),
            "coord_start_idx":   node_to_path_idx.get(s.start_node, 0),
            "coord_end_idx":     node_to_path_idx.get(s.end_node, 0),
            "start_coords":      [round(G.nodes[s.start_node]["lon"], 7),
                                  round(G.nodes[s.start_node]["lat"], 7)],
            "end_coords":        [round(G.nodes[s.end_node]["lon"], 7),
                                  round(G.nodes[s.end_node]["lat"], 7)],
        }
        for i, s in enumerate(nav_segs)
    ]

    waypoints: list = []
    for i, seg in enumerate(nav_segs[:-1]):
        wp = G.nodes[seg.end_node]
        prev_nd_key = (seg.intermediate_nodes[-1] if seg.intermediate_nodes else seg.start_node)
        prev_nd = G.nodes[prev_nd_key]
        cur_bearing = calculate_bearing(prev_nd["lon"], prev_nd["lat"], wp["lon"], wp["lat"])

        next_seg = nav_segs[i + 1]
        next_nd_key = (next_seg.intermediate_nodes[0] if next_seg.intermediate_nodes else next_seg.end_node)
        next_nd = G.nodes[next_nd_key]
        next_bearing = calculate_bearing(wp["lon"], wp["lat"], next_nd["lon"], next_nd["lat"])

        turn = get_turn_direction(cur_bearing, next_bearing)
        waypoints.append({
            "lat":              wp["lat"],
            "lon":              wp["lon"],
            "turn_direction":   turn,
            "guidance_text":    generate_guidance_text(turn, next_seg),
            "distance_to_next": round(next_seg.length_m, 1),
        })

    return nav_segs_json, waypoints


def _measurement_units_payload(path_nodes: list) -> list:
    """
    path_nodes → measurement_units 응답 dict 리스트.

    _nav_segs_and_waypoints 와 같은 문제가 measurement_units 에도 있었다 —
    compare 후보 중 메인("type")만 이걸 계산해 붙였고 distance/personal 은
    아예 빠져 있어서, 사용자가 그 후보를 선택해 안내를 시작하면
    POST /navigation/{route_id}/segment 로 보낼 unit 자체가 없어 신호 A(경사
    구간 관측)·D(navigation_measurements) 가 처음부터 하나도 안 쌓였다
    (실기기/에뮬 GPS 재생 테스트로 확인, trip_slope_observations 0건 고착).
    """
    node_to_path_idx: dict = {}
    for i, n in enumerate(path_nodes):
        if n not in node_to_path_idx:
            node_to_path_idx[n] = i

    units = build_measurement_units(G, path_nodes)
    return [
        {
            "unit_index":      u.unit_index,
            "distance_m":      u.distance_m,
            "slope_pct":       u.slope_pct,
            "is_stairs":       u.is_stairs,
            "coord_start_idx": node_to_path_idx.get(u.start_node, 0),
            "coord_end_idx":   node_to_path_idx.get(u.end_node, 0),
            "start_coords":    [round(G.nodes[u.start_node]["lon"], 7),
                                round(G.nodes[u.start_node]["lat"], 7)],
            "end_coords":      [round(G.nodes[u.end_node]["lon"], 7),
                                round(G.nodes[u.end_node]["lat"], 7)],
        }
        for u in units
    ]


def _candidate_segs(raw_segments: list, user_type: str) -> list:
    """
    CCH 결과의 원본 segment(slope_pct / length_m / direction …)를 FE 가 바로 쓰는
    형식으로 정규화한다. FE(SlopeBinTracker, routeChoiceModel.slopeProfile)는
    `slope` / `length` 를 읽으므로 이 별칭이 없으면 `seg.length ?? 5` 로 5m 로
    떨어진다 (data-collection-plan §3, 이슈 §1-A). type 후보의 `segs` 와 같은 shape.
    """
    out = []
    for s in raw_segments:
        slope_pct = s.get("slope_pct", s.get("slope", 0.0))
        length_m  = s.get("length_m", s.get("length", 0.0))
        direction = s.get("direction", "flat")
        out.append({
            "name":      s.get("name", ""),
            "direction": direction,
            "slope_pct": round(slope_pct, 2),
            "length_m":  round(length_m, 1),
            "slope":     round(slope_pct, 2),
            "length":    round(length_m, 1),
            "zone":      classify_zone(slope_pct, direction, user_type),
        })
    return out


def _seoul_leg_segs(raw_segments: list, user_type: str) -> list:
    """CCH 결과 segment → FE 형식 (start/end 좌표 포함, outside_seoul=False)."""
    out = []
    for s in raw_segments:
        sp = s.get("slope_pct", 0.0)
        ln = s.get("length_m", 0.0)
        dr = s.get("direction", "flat")
        u, v = s.get("u"), s.get("v")
        ul = G.nodes[u]["lon"] if (u is not None and u in G.nodes) else None
        ula = G.nodes[u]["lat"] if (u is not None and u in G.nodes) else None
        vl = G.nodes[v]["lon"] if (v is not None and v in G.nodes) else None
        vla = G.nodes[v]["lat"] if (v is not None and v in G.nodes) else None
        out.append({
            "name":      s.get("name", ""),
            "direction": dr,
            "slope_pct": round(sp, 2),
            "length_m":  round(ln, 1),
            "zone":      classify_zone(sp, dr, user_type),
            "coords":    [[ul, ula], [vl, vla]],
            "start":     {"latitude": ula, "longitude": ul},
            "end":       {"latitude": vla, "longitude": vl},
            "slope":     round(sp, 2),
            "length":    round(ln, 1),
            "outside_seoul": False,
        })
    return out


def _seoul_leg_route(o: tuple, d: tuple, user_type: str, seoul_mode: str):
    """서울 안 두 점 사이 leg. seoul_mode: 'type'|'shortest'. → (coords, result) | None.

    CCH 미가용이면 실패 처리(None) → 호출측(_hybrid_walk_response)이 기존
    흐름으로 폴백한다. pathfinder.find_route() NetworkX 폴백 제거(#4) — CCH
    전용 경로가 됐다."""
    if _cch is None:
        print(f"[hybrid] 서울 leg 실패 ({seoul_mode}): CCH 엔진 미가용")
        return None
    try:
        r = (_cch.find_distance_route(o, d, avoid_stairs=True) if seoul_mode == "shortest"
             else _cch.find_route(o, d, user_type))
    except Exception as e:
        print(f"[hybrid] 서울 leg 실패 ({seoul_mode}): {e}")
        return None
    try:
        coords = [[G.nodes[n]["lon"], G.nodes[n]["lat"]] for n in r["path_nodes"]]
    except Exception:
        return None
    return coords, r


def _hybrid_walk_response(origin: tuple, dest: tuple, user_type: str,
                          o_in: bool, d_in: bool) -> dict | None:
    """
    출발/도착 중 하나 이상이 서울 밖일 때: 에러 대신 하이브리드 경로.
      서울 안 구간 = CCH(유형별 또는 최단),  서울 밖 구간 = 직선(경사 데이터 없음).
    도보 선택지 2개를 routes[]로 돌려준다:
      routes[0] 유형별+최단(밖) / routes[1] 최단+최단(밖).
    실패(서울 leg 조회 불가 등) 시 None → 호출측이 기존 흐름으로 폴백.
    """
    try:
        from routing.seoul_bounds import is_in_seoul
        from routing.geo_leg import boundary_attach, densify, straight_leg_segments, path_length_m
    except Exception as e:
        print(f"[hybrid] 모듈 로드 실패: {e}")
        return None

    def build(seoul_mode: str):
        if o_in and not d_in:
            attach = boundary_attach(origin, dest, is_in_seoul)
            leg = _seoul_leg_route(tuple(origin), tuple(attach), user_type, seoul_mode)
            if leg is None:
                return None
            s_coords, s_r = leg
            ext = densify(tuple(s_coords[-1]), tuple(dest))
            coords = s_coords + ext[1:]
            segs = _seoul_leg_segs(s_r["segments"], user_type) + straight_leg_segments(ext)
            seoul_nodes = s_r["path_nodes"]
        elif d_in and not o_in:
            attach = boundary_attach(dest, origin, is_in_seoul)
            leg = _seoul_leg_route(tuple(attach), tuple(dest), user_type, seoul_mode)
            if leg is None:
                return None
            s_coords, s_r = leg
            ext = densify(tuple(origin), tuple(s_coords[0]))
            coords = ext[:-1] + s_coords
            segs = straight_leg_segments(ext) + _seoul_leg_segs(s_r["segments"], user_type)
            seoul_nodes = s_r["path_nodes"]
        else:
            # 둘 다 서울 밖 → 전 구간 직선 (중간이 서울을 지나도 단순화)
            ext = densify(tuple(origin), tuple(dest))
            coords, segs, seoul_nodes = ext, straight_leg_segments(ext), None

        total_m = round(path_length_m(coords), 1)
        sloped = [s for s in segs if s.get("slope_pct") is not None]
        sloped_len = sum(s["length_m"] for s in sloped)
        avg_slope = (round(sum(abs(s["slope_pct"]) * s["length_m"] for s in sloped) / sloped_len, 2)
                     if sloped_len > 0 else 0.0)
        ext_len = round(sum(s["length_m"] for s in segs if s.get("outside_seoul")), 1)
        est_s = estimate_route_time(segs, user_type, {})
        return {
            "coords": coords, "segs": segs, "total_m": total_m, "avg_slope": avg_slope,
            "ext_len": ext_len, "est_s": est_s, "seoul_nodes": seoul_nodes,
        }

    opt_type  = build("type")
    opt_short = build("shortest")
    if opt_type is None and opt_short is None:
        return None
    primary = opt_type or opt_short

    routes = []
    for rid, tag, color, opt in (
        ("accessibility", USER_TYPES[user_type]["label"], "#3DBFA8", opt_type),
        ("shortest",      "최단",                          "#8A8FA3", opt_short),
    ):
        if opt is None:
            continue
        routes.append({
            "id":             rid,
            "tag":            tag,
            "color":          color,
            "coordinates":    opt["coords"],
            "totalDistance":  opt["total_m"],
            "avgSlope":       opt["avg_slope"],
            "routeSegments":  opt["segs"],
            "estimatedTimeS": opt["est_s"],
            "hasExternalLeg": opt["ext_len"] > 0,
            "externalLengthM": opt["ext_len"],
        })

    # 서울 구간 GPS 안내(navigation_segments/waypoints)는 primary 의 서울 부분만
    nav_json: list = []
    if primary["seoul_nodes"] and len(primary["seoul_nodes"]) >= 2:
        try:
            nav_json, _ = _nav_segs_and_waypoints(primary["seoul_nodes"], user_type)
        except Exception as e:
            print(f"[hybrid] nav_segs 생성 실패(무시): {e}")

    return {
        "routes":         routes,
        "coordinates":    primary["coords"],
        "routeSegments":  primary["segs"],
        "segments":       primary["segs"],
        "total_length_m": primary["total_m"],
        "avg_slope_pct":  primary["avg_slope"],
        "estimatedTimeS": primary["est_s"],
        "estimated_time_min": round(primary["est_s"] / 60.0, 1),
        "navigation_segments": nav_json,
        "waypoints":      [],
        "algorithm":      "hybrid",
        "service_area": {
            "origin_in_seoul": o_in,
            "dest_in_seoul":   d_in,
            "partial_coverage": True,
            "external_length_m": primary["ext_len"],
            "note": "서울 밖 구간은 경사 데이터가 없어 최단(직선) 안내만 제공됩니다.",
        },
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    global G, _spatial_index, _cch, _personal_cache, _subway_db, _waypoints_set
    print("그래프 로딩 중... (최초 1회)")
    G = build_graph(GEOJSON_PATH)
    precompute_edge_costs(G)
    _spatial_index = build_spatial_index(G)
    _waypoints_set = extract_waypoints(G)
    print(f"그래프 로딩 완료 (교차로 {len(_waypoints_set):,}개 사전 계산)")

    # CCH 전처리 — #4로 pathfinder.find_route()(NetworkX) 폴백이 삭제되면서
    # CCH가 유일한 라우팅 엔진이 됐다. 이전엔 소규모(용산구 등 <20만 노드)
    # 개발용 그래프는 NetworkX로도 충분하다고 보고 CCH 전처리를 건너뛰었는데,
    # 그 폴백이 없어진 지금 건너뛰면 _cch가 영원히 None이라 그 모드에서
    # /route 가 전부 실패한다 — 그래프 크기와 무관하게 항상 CCH를 빌드한다.
    try:
        print(f"[CCH] 노드 {G.number_of_nodes():,}개 - CCH 전처리 시작 (서울 전역 1~5분, 소규모 그래프는 훨씬 빠름)")
        # inertial order 디스크 캐시 - 위상 동일 시 재부팅에서 ~146s 절약
        _cch_order_cache = os.path.splitext(GEOJSON_PATH)[0] + ".cchorder.pkl"
        _cch = build_cch_engine(G, order_cache_path=_cch_order_cache)
        print("[CCH] 준비 완료 - 이후 /route 요청은 CCH로 처리됩니다")
        # 개인 맞춤 metric 캐시 (⑧) - 시작 시엔 비어있음, 배치 스크립트(⑨)가
        # /personal/refresh 등으로 채워야 우선 채워짐. 요청 경로에서는
        # 절대 여기서 학습하지 않고, 이미 채워진 걸 읽기만 한다.
        _personal_cache = PersonalMetricCache(_cch.cch, _cch.basis_weights)
    except Exception as e:
        print(f"[CCH] 초기화 실패: {e}")
        _cch = None
        _personal_cache = None

    try:
        init_db()
    except Exception as e:
        print(f"[DB] 초기화 실패 (DB 없이 계속 실행): {e}")
    try:
        _subway_db = get_facility_db()
        print("[Subway] 편의시설 DB 로딩 완료")
        # 승강기 운행상태 캐시를 백그라운드로 미리 채움(~15초) — 첫 역 도착 /route 가 안 기다리게
        from subway.facility import warm_broken_serials
        warm_broken_serials()
    except Exception as e:
        print(f"[Subway] 편의시설 DB 초기화 실패 (subway 기능 비활성): {e}")
    yield


app = FastAPI(title="Ando API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── auth 헬퍼 ────────────────────────────────────────────────────────────────
def _verified(authorization: str = Header(default="")) -> dict:
    """Authorization: Bearer <firebase_id_token> 검증 → decoded 딕셔너리 반환"""
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Authorization: Bearer <token> 헤더 필요")
    try:
        return verify_token(authorization.removeprefix("Bearer "))
    except Exception:
        raise HTTPException(401, "유효하지 않은 Firebase 토큰")


def _optional_verified(authorization: str = Header(default="")) -> dict | None:
    """토큰이 있으면 검증, 없으면 None 반환 (비로그인 허용 엔드포인트용)"""
    if not authorization.startswith("Bearer "):
        return None
    try:
        return verify_token(authorization.removeprefix("Bearer "))
    except Exception:
        return None


# ── auth 엔드포인트 ───────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    id_token: str


@app.post("/auth/login")
def api_auth_login(body: LoginRequest, db: Session = Depends(get_db)):
    """Firebase ID 토큰 검증 → 신규 유저 생성 또는 기존 유저 조회 후 반환"""
    try:
        decoded = verify_token(body.id_token)
    except Exception as e:
        print(f"[Firebase 오류] {e}")
        raise HTTPException(401, "유효하지 않은 Firebase 토큰")
    return get_or_create_user(
        db,
        uid=decoded["uid"],
        email=decoded["email"],
        display_name=decoded.get("display_name", ""),
        photo_url=decoded.get("photo_url", ""),
    )


class UserTypeRequest(BaseModel):
    user_type: str


@app.get("/user/me")
def api_get_me(
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """로그인 유저 프로필 조회"""
    profile = get_user_profile(db, decoded["uid"])
    if not profile:
        raise HTTPException(404, "유저를 찾을 수 없습니다")
    return profile


@app.get("/user/stats")
def api_get_stats(
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """마이페이지 통계 — 총 경로 수, 총 거리, 총 시간, 평균 경사도, 평균 만족도"""
    return get_user_stats(db, decoded["uid"])


@app.patch("/user/type")
def api_update_user_type(
    body: UserTypeRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """로그인된 유저의 이동 유형(user_type) 변경"""
    if body.user_type not in USER_TYPES:
        raise HTTPException(400, f"유효하지 않은 user_type: {body.user_type}")
    return update_user_type(db, decoded["uid"], body.user_type)


@app.delete("/user/me")
def api_delete_account(
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """회원 탈퇴 — DB에서 계정(+연쇄 데이터) 삭제 후 Firebase 계정 자체도 삭제.
    routes.uid는 ON DELETE SET NULL이라 경로/경사도 데이터는 익명으로 남는다."""
    uid = decoded["uid"]
    deleted_from_db = delete_user_account(db, uid)
    try:
        delete_firebase_user(uid)
    except Exception as e:
        print(f"[Auth] Firebase 계정 삭제 실패 (DB는 삭제됨): {e}")
    return {"ok": True, "deleted_from_db": deleted_from_db}


# ── 마이페이지 엔드포인트 ─────────────────────────────────────────────────────

class SegmentPayload(BaseModel):
    index:        int
    distanceM:    float
    slopePercent: float
    elapsedMs:    int
    measured:     bool = False
    direction:    str | None = None
    zone:         str | None = None
    name:         str | None = None


class UserRouteRequest(BaseModel):
    from_name:         str
    to_name:           str
    mode:              str  = "walk"
    walker_type:       str  = "elderly"
    total_duration_ms: int  = 0
    date:              str
    segments:          list[SegmentPayload] = []


@app.post("/user/routes")
def api_save_user_route(
    body: UserRouteRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """FE 안내 완료 후 경로 + 구간 데이터 저장 → route_id 반환"""
    route_id = save_user_route(
        db,
        uid=decoded["uid"],
        from_name=body.from_name,
        to_name=body.to_name,
        mode=body.mode,
        walker_type=body.walker_type,
        total_duration_ms=body.total_duration_ms,
        date_iso=body.date,
        segments=[s.model_dump() for s in body.segments],
    )
    if route_id is None:
        raise HTTPException(503, "DB 미설정 — 경로 저장 불가")
    return {"route_id": route_id}


@app.get("/user/routes")
def api_get_user_routes(
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """마이페이지 경로 목록 조회 (만족도 포함)"""
    return get_user_routes(db, decoded["uid"])


@app.delete("/user/routes/{route_id}")
def api_delete_user_route(
    route_id: int,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """본인 경로 삭제 (연결된 segments·feedback 자동 cascade 삭제)"""
    deleted = delete_user_route(db, route_id, decoded["uid"])
    if not deleted:
        raise HTTPException(404, "경로를 찾을 수 없거나 삭제 권한이 없습니다")
    return {"deleted": route_id}


# (제거됨) POST /routes/{id}/feedback — 전체 경로 별점 만족도. 구간별 평가
# (segment-hardship-feedback)로 대체되어 FE 호출부가 전무. `feedback` 테이블과
# database.save_or_update_feedback 은 기존 파일럿 데이터 보존 위해 남겨 둠(비활성).


# ── 북마크 엔드포인트 ─────────────────────────────────────────────────────────

class BookmarkRequest(BaseModel):
    place_id:  str
    name:      str
    address:   str   = ""
    latitude:  float = 0.0
    longitude: float = 0.0
    category:  str   = ""
    phone:     str | None = None


@app.get("/user/bookmarks")
def api_get_bookmarks(
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """사용자 북마크 목록 조회"""
    return get_user_bookmarks(db, decoded["uid"])


@app.post("/user/bookmarks")
def api_add_bookmark(
    body: BookmarkRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """북마크 추가 (이미 있으면 갱신)"""
    return save_user_bookmark(
        db,
        uid=decoded["uid"],
        place_id=body.place_id,
        name=body.name,
        address=body.address,
        latitude=body.latitude,
        longitude=body.longitude,
        category=body.category,
        phone=body.phone,
    )


@app.delete("/user/bookmarks/{place_id}")
def api_delete_bookmark(
    place_id: str,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """북마크 삭제"""
    deleted = delete_user_bookmark(db, decoded["uid"], place_id)
    if not deleted:
        raise HTTPException(404, "북마크를 찾을 수 없습니다")
    return {"deleted": place_id}


# ── 검색기록 엔드포인트 ───────────────────────────────────────────────────────
# 출발지/도착지 구분 없음 — "이 장소를 검색해서 선택했다"만 기록.

class SearchHistoryRequest(BaseModel):
    place_id:  str
    name:      str
    address:   str   = ""
    latitude:  float = 0.0
    longitude: float = 0.0
    category:  str   = ""
    phone:     str | None = None


@app.get("/user/search-history")
def api_get_search_history(
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """최근 검색기록 조회 (최신순, 최대 20개)"""
    return get_search_history(db, decoded["uid"])


@app.post("/user/search-history")
def api_add_search_history(
    body: SearchHistoryRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """검색기록 추가 (같은 장소면 최신 시각으로 갱신)"""
    return save_search_history(
        db,
        uid=decoded["uid"],
        place_id=body.place_id,
        name=body.name,
        address=body.address,
        latitude=body.latitude,
        longitude=body.longitude,
        category=body.category,
        phone=body.phone,
    )


# ── 네비게이션 세션 엔드포인트 ─────────────────────────────────────────────────

class NavigationStartRequest(BaseModel):
    from_name:      str
    to_name:        str
    mode:           str        = "walk"
    walker_type:    str        = "elderly"
    total_segments: int | None = None   # FE 전송값, 현재 미사용
    origin_lat:     float | None = None
    origin_lon:     float | None = None
    dest_lat:       float | None = None
    dest_lon:       float | None = None
    date:           str | None = None
    # ── 측정 파이프라인 v2 세션 발급 (인터페이스만 우선 도입) ────────────────
    # FE는 아직 이 필드들을 보내지 않는다(FE 연동은 다음 턴) — 그때까지는
    # 전부 생략된 채로 오고, 기존과 동일하게 route_id만 발급된다(세션 없음).
    # session_id는 BE가 발급하지 않는다 — 기존 CollectSession과 같은 포맷으로
    # FE가 만들어 보낸 값을 그대로 신뢰해 저장한다(발급 체계 이원화 방지).
    session_id:     str | None = None
    app_version:    str | None = None
    schema_ver:     int | None = None


@app.post("/navigation/start")
def api_navigation_start(
    body: NavigationStartRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
    x_app_version: str = Header(default=""),
    x_schema_version: str = Header(default=""),
):
    """안내 시작 — routes에 in_progress 행 생성 + (session_id가 있으면) sessions
    행도 함께 생성, route_id 반환.

    app_version/schema_ver는 바디 필드를 우선하고, 없으면 X-App-Version /
    X-Schema-Version 헤더를 본다 — FE가 아직 어느 쪽으로도 안 보내면(현재)
    세션 없이 route_id만 발급하던 기존 동작 그대로 유지된다.
    """
    if body.walker_type not in USER_TYPES:
        raise HTTPException(400, f"유효하지 않은 walker_type: {body.walker_type}")

    route_id = start_navigation(
        db,
        uid=decoded["uid"],
        from_name=body.from_name,
        to_name=body.to_name,
        mode=body.mode,
        walker_type=body.walker_type,
        origin_lat=body.origin_lat,
        origin_lon=body.origin_lon,
        dest_lat=body.dest_lat,
        dest_lon=body.dest_lon,
        date_iso=body.date,
    )
    if route_id is None:
        raise HTTPException(503, "DB 미설정")

    if body.session_id:
        app_version = body.app_version or x_app_version or None
        schema_ver  = body.schema_ver
        if schema_ver is None and x_schema_version:
            try:
                schema_ver = int(x_schema_version)
            except ValueError:
                schema_ver = None
        if not app_version or schema_ver is None:
            raise HTTPException(400, "session_id를 보낼 땐 app_version과 schema_ver도 함께 필요합니다")
        start_session(
            db,
            session_id=body.session_id,
            uid=decoded["uid"],
            user_type=body.walker_type,
            app_version=app_version,
            schema_ver=schema_ver,
        )

    return {"route_id": route_id}


class NavigationSegmentRequest(BaseModel):
    # ── 측정 파이프라인 v2 ── navigation_measurements 대상 필드.
    # session_id는 필수다 — 없는 요청은 (하위호환을 위해 조용히 무시하지 않고)
    # 400으로 즉시 드러낸다. 이 프로젝트는 결측을 거리비례 추정 등으로 조용히
    # 메우다 데이터가 오염된 전례가 있어, "실패는 조용히 감추지 말고 드러내라"가
    # 원칙이다. 구버전 FE(이 필드가 아예 없는 요청 본문)는 이 시점부터 이
    # 엔드포인트가 전부 실패하는데, 이는 의도된 동작 — BE·FE는 같은 시점에
    # 배포하는 걸 전제로 하고, 배포 틈에는 조용한 데이터 유실보다 드러난 실패를
    # 택한다(테스터 소수 규모라 재빌드 배포로 충분히 대응 가능).
    session_id: str
    unit_index: int             # routing/measurement_units.py의 MeasurementUnit.unit_index
    distance_m: float
    slope_pct:  float           # 부호 있는 값 (양수=오르막, 음수=내리막), 거리가중평균
    status:     str             # 'measured' | 'skipped'
    elapsed_ms: int | None = None   # status='measured'일 때만 필수, 'skipped'면 반드시 None
    # 경로 좌표 배열 인덱스(measurement_units[i].coord_start_idx/coord_end_idx를
    # FE가 그대로 되돌려 보냄) — gps_traces 사후 투영 재계산에 필요. session_id와
    # 달리 optional로 둔다: 없어도 status/elapsed_ms 자체의 신뢰도엔 영향이 없는
    # 부가 위치정보라 실패로 드러낼 이유가 없음(구버전 FE 호환 목적은 아님 —
    # 이번 release_v9와 같은 배포 주기 안에서 추가된 필드).
    coord_start_idx: int | None = None
    coord_end_idx:   int | None = None
    # 실제 위/경도 — RouteDetailScreen "구간 설문조사"(나중에 평가)가 이 구간을
    # 지도에 그리는 데 쓴다(coord_start_idx/coord_end_idx는 좌표 배열 인덱스일
    # 뿐 그 배열 자체가 저장 안 돼 있어 나중엔 역참조 불가 — database.py
    # navigation_measurements 컬럼 주석 참고). FE가 measurement_units[i]에서
    # 이미 갖고 있어 비용이 거의 없다. optional — 없어도 다른 필드 신뢰도엔 영향 없음.
    start_lat: float | None = None
    start_lon: float | None = None
    end_lat:   float | None = None
    end_lon:   float | None = None
    # S2(stopClassifier) 집계 결과 — FE utils/stopClassifier.ts::aggregateRow()가
    # 계산해 그대로 보낸다(판정 로직 중복 구현 안 함). status='measured'일 때만
    # 의미 있음 — 구버전 FE는 안 보내 전부 None(nullable, 하위호환).
    valid:         bool | None = None
    dwell_ms:      int  | None = None
    moving_ms:     int  | None = None
    facility:      bool | None = None
    stop_class:    str  | None = None   # 'moving'|'gps_gap'|'uncertain'|'confirmed_stop'
    near_crossing: bool | None = None
    # ── 레거시 navigation_segments(마이페이지 표시용) 병행 기록에만 쓰는 필드 ──
    zone:       str | None = None
    direction:  str | None = None


@app.post("/navigation/{route_id}/segment")
def api_add_segment(
    route_id: int,
    body: NavigationSegmentRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """구간(측정 단위) 완료/스킵 시 호출 — navigation_measurements에 실측 데이터
    저장(주 기록) + navigation_segments에도 병행 기록(마이페이지 표시용, 레거시).

    catch-up(한 번에 여러 unit을 건너뜀) 판정과 그 결과 status='skipped' 행
    생성은 이제 FE 책임이다 — BE는 건너뛴 unit의 실제 distance_m/slope_pct를
    모르고(경로 재계산 없이는 알 수 없음), FE는 /route 응답으로 이미 전체
    unit 배열을 갖고 있어 건너뛴 unit도 그대로 제출할 수 있다. BE는 들어오는
    대로 UNIQUE(route_id, unit_index) 기준 upsert(ON CONFLICT DO NOTHING)만
    한다 — 갭을 추론해서 채우지 않는다.
    """
    if body.status not in ("measured", "skipped"):
        raise HTTPException(400, "status는 'measured' 또는 'skipped'여야 합니다")
    if body.status == "measured" and body.elapsed_ms is None:
        raise HTTPException(400, "status='measured'는 elapsed_ms가 필요합니다")
    if body.status == "skipped" and body.elapsed_ms is not None:
        raise HTTPException(400, "status='skipped'는 elapsed_ms를 보내면 안 됩니다")
    _STOP_CLASSES = ("moving", "gps_gap", "uncertain", "confirmed_stop")
    if body.stop_class is not None and body.stop_class not in _STOP_CLASSES:
        raise HTTPException(400, f"stop_class는 {_STOP_CLASSES} 중 하나여야 합니다")

    ok = add_navigation_measurement(
        db,
        route_id=route_id,
        uid=decoded["uid"],
        session_id=body.session_id,
        unit_index=body.unit_index,
        distance_m=body.distance_m,
        slope_pct=body.slope_pct,
        elapsed_ms=body.elapsed_ms,
        status=body.status,
        coord_start_idx=body.coord_start_idx,
        coord_end_idx=body.coord_end_idx,
        start_lat=body.start_lat,
        start_lon=body.start_lon,
        end_lat=body.end_lat,
        end_lon=body.end_lon,
        valid=body.valid,
        dwell_ms=body.dwell_ms,
        moving_ms=body.moving_ms,
        facility=body.facility,
        stop_class=body.stop_class,
        near_crossing=body.near_crossing,
    )
    if not ok:
        raise HTTPException(
            404,
            "진행 중인 경로를 찾을 수 없거나 권한이 없거나, session_id가 유효하지 않습니다",
        )

    # 레거시 navigation_segments — 마이페이지 표시용으로 그대로 유지(범위 밖,
    # 코드 변경 없음). 단 'skipped'는 이 구 테이블에 없던 개념이라 elapsed_ms가
    # NOT NULL이므로, 실측된 unit만 병행 기록한다. 이 병행 기록 실패가 위
    # navigation_measurements(주 기록) 성공까지 무효로 만들진 않는다.
    if body.status == "measured":
        try:
            add_navigation_segment(
                db,
                route_id=route_id,
                uid=decoded["uid"],
                index=body.unit_index,
                distance_m=body.distance_m,
                slope_pct=body.slope_pct,
                elapsed_ms=body.elapsed_ms,
                measured=True,
                zone=body.zone,
                direction=body.direction,
            )
        except Exception as e:
            print(f"[NAV] 레거시 navigation_segments 병행 기록 실패 (무시): {e}")

    return {"ok": True}


class ZoneObservationRequest(BaseModel):
    zone_key:      str
    zone:          str | None = None
    direction:     str | None = None
    slope_pct_avg: float = 0.0
    distance_m:    float
    elapsed_ms:    int
    gps_sample_n:  int = 0


@app.post("/navigation/{route_id}/zone")
def api_zone_observation(
    route_id: int,
    body: ZoneObservationRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """
    zone 통과 완료 시 호출 — 관측값 저장 + 개인화 속도 프로파일 EMA 업데이트.
    zone_key는 FE에서 직접 계산해도 되고, zone+direction 조합을 보내면 BE에서 계산.
    """
    uid = decoded["uid"]

    user_row = db.execute(
        text("SELECT user_type FROM users WHERE uid = :uid"), {"uid": uid}
    ).fetchone()
    user_type = user_row[0] if user_row else "elderly"

    zone_key = body.zone_key or get_zone_key(body.zone, body.direction)

    saved = save_zone_observation(
        db,
        route_id=route_id,
        uid=uid,
        user_type=user_type,
        zone_key=zone_key,
        slope_pct_avg=body.slope_pct_avg,
        distance_m=body.distance_m,
        elapsed_ms=body.elapsed_ms,
        gps_sample_n=body.gps_sample_n,
    )
    return {"ok": True, "saved": saved}


class NavigationCompleteRequest(BaseModel):
    # total_duration_ms 필드는 제거했다 — BE가 navigation_measurements 집계로
    # 직접 계산한다(complete_navigation() 참고). FE가 옛 필드를 계속 보내도
    # Pydantic이 무시하므로(BaseModel 기본 동작) 구버전 요청도 400 없이 통과한다.
    #
    # reached_destination: 목적지까지 정상 도달했는지. FE는 아직 이 필드를 안
    # 보낸다(다음 턴 연동 예정) — 그때까지는 None으로 들어와 기존과 동일하게
    # status='completed'로 확정된다("조기 종료"와 "정상 도착"을 구분 못 하는
    # 구버전 FE의 한계를 그대로 반영한 임시 fallback — 데이터를 지어내는 게
    # 아니라 "이 필드가 없던 시절과 동일하게" 처리하는 것뿐이다).
    reached_destination: bool | None = None
    # session_id: 있으면 sessions.ended_at/end_reason도 함께 닫는다(Optional —
    # 구버전 FE 호환. /navigation/start에서 세션을 안 열었으면 애초에 없는 값).
    session_id: str | None = None


@app.patch("/navigation/{route_id}/complete")
def api_complete_navigation(
    route_id: int,
    body: NavigationCompleteRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """안내 종료 — navigation_measurements 집계로 총 거리·평균 경사·총 소요시간을
    확정하고, reached_destination에 따라 routes.status를
    'completed'/'completed_partial'로 나눠 확정한다. session_id가 있으면 해당
    세션도 같은 값으로 종료 처리한다."""
    result = complete_navigation(
        db,
        route_id=route_id,
        uid=decoded["uid"],
        reached_destination=body.reached_destination,
        session_id=body.session_id,
    )
    if result is None:
        raise HTTPException(404, "진행 중인 경로를 찾을 수 없거나 권한이 없습니다")
    return result


# ── 구간 체감 난이도 평가 (⑭' — pace = 1m당 소요시간 기준) ───────────────────
# 안내 종료 후: pace 상위 min(10, 유효구간수) 구간에 대해 구간마다 1단계 3버튼
# ("이 구간, 어떠셨나요?" 편했어요/보통이었어요/힘들었어요 → verdict -1/0/+1).
# 랭킹은 complete_navigation 이 종료 시점에 미리 계산해 둔다.

@app.get("/navigation/{route_id}/slow-segments")
def api_slow_segments(
    route_id: int,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """pace 상위 구간 목록. eligible=false 면 FE 는 평가 단계를 건너뛴다."""
    result = get_slow_segments(db, route_id, decoded["uid"])
    if result is None:
        raise HTTPException(404, "경로를 찾을 수 없거나 권한이 없습니다")
    return result


@app.get("/navigation/{route_id}/measurements")
def api_route_measurements(
    route_id: int,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """RouteDetailScreen 용 — navigation_measurements(BE 실측, 신뢰 소스) 전체를
    반환한다. 동의 안 했거나 서버 저장이 실패한 경로는 segments가 빈 배열로
    온다 — FE가 이 경우 로컬(record.segments)로 폴백한다."""
    result = get_route_measurements(db, route_id, decoded["uid"])
    if result is None:
        raise HTTPException(404, "경로를 찾을 수 없거나 권한이 없습니다")
    return result


class SegmentHardshipAnswer(BaseModel):
    seg_index:         int
    seg_index_end:     int | None = None   # 묶은 구간의 끝 엣지 (GET 이 준 값 되싣기)
    rank:              int
    pace_s_per_m:      float
    elapsed_ms:        int
    distance_m:        float
    slope_pct:         float
    zone:              str | None = None
    # 1단계 3버튼(편했어요 +1 / 보통이었어요 0 / 힘들었어요 -1). 예전
    # was_uncomfortable(예/아니오)+hardship_score(1~10 점) 2단계 설계에서 전환 —
    # ① "보통"과 "평지보다 편함"을 구분 못 해 s_u(g)가 음의 방향(더 편함) 데이터를
    # 아예 못 받던 커버리지 구멍, ② 10점은 명목 해상도일 뿐 s_u(g)가 애초에
    # 저차 보정항이라 못 씀, ③ 지금 병목은 응답률(2단계 최대 탭10 → 1단계 최대
    # 탭5). 파일럿 전이라 하위호환 불필요 — 구버전 요청은 그냥 422.
    verdict:           int
    # S4 — 이 문항이 순위였는지 무작위 대조였는지(GET 스냅샷 되싣기).
    asked_by:          str | None = None   # 'rank' | 'random'
    rank_position:     int | None = None


class SegmentHardshipRequest(BaseModel):
    session_id: str | None = None
    answers:    list[SegmentHardshipAnswer] = []


@app.post("/navigation/{route_id}/segment-hardship-feedback")
def api_segment_hardship_feedback(
    route_id: int,
    body: SegmentHardshipRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """구간 체감 난이도 응답 저장 (route_id+seg_index upsert)."""
    for a in body.answers:
        if a.verdict not in (-1, 0, 1):
            raise HTTPException(400, f"seg_index={a.seg_index}: verdict는 -1/0/1이어야 합니다")
    result = save_segment_hardship_feedback(
        db,
        route_id=route_id,
        uid=decoded["uid"],
        session_id=body.session_id,
        answers=[a.model_dump() for a in body.answers],
    )
    if result is None:
        raise HTTPException(404, "경로를 찾을 수 없거나 권한이 없습니다")
    return result


@app.get("/navigation/{route_id}/segment-hardship-feedback")
def api_get_segment_hardship_feedback(
    route_id: int,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """이 경로에서 사용자가 실제로 답한 D 신호 응답 목록 — RouteDetailScreen이
    객관 경사 분류와 나란히 보여줄 때 쓴다. 답 안 한 구간은 그냥 응답 목록에
    없다(FE가 seg_index로 찾아서 없으면 빈칸 처리)."""
    result = get_segment_hardship_feedback(db, route_id, decoded["uid"])
    if result is None:
        raise HTTPException(404, "경로를 찾을 수 없거나 권한이 없습니다")
    return result


class SegmentHardestPickRequest(BaseModel):
    session_id:        str | None = None
    shown_seg_indices: list[int]
    picked_seg_index:  int | None = None
    picked_none:       bool = False


@app.post("/navigation/{route_id}/segment-hardest-pick")
def api_segment_hardest_pick(
    route_id: int,
    body: SegmentHardestPickRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """S5 — "가장 힘들었던 구간" 응답 저장(route_id당 1행, upsert). 3버튼 흐름
    (segment-hardship-feedback)과 별도 엔드포인트 — 설계 이유는 database.py
    save_segment_hardest_pick 참고."""
    try:
        result = save_segment_hardest_pick(
            db, route_id=route_id, uid=decoded["uid"], session_id=body.session_id,
            shown_seg_indices=body.shown_seg_indices,
            picked_seg_index=body.picked_seg_index, picked_none=body.picked_none,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    if result is None:
        raise HTTPException(404, "경로를 찾을 수 없거나 권한이 없습니다")
    return result


@app.get("/navigation/{route_id}/segment-hardest-pick")
def api_get_segment_hardest_pick(
    route_id: int,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """이 경로의 "가장 힘들었던 구간" 응답(RouteDetailScreen 참고용)."""
    result = get_segment_hardest_pick(db, route_id, decoded["uid"])
    if result is None:
        raise HTTPException(404, "경로를 찾을 수 없거나 응답이 없습니다")
    return result


# ── 개인 맞춤 경로 추천 — 데이터 수집 (ando_dev_final.md 3.9절) ───────────────
# 신호 A~D를 세션 종료 시 1회(또는 2분/200행마다 중간 플러시) 배치로 받는다.
# 개별 전환마다 개별 POST를 쏘면 요청 폭증 + 배터리 소모가 커서 4종 엔드포인트가
# 아니라 1종으로 통합했다.

class SlopeObservationPayload(BaseModel):
    """S3 — 고정거리(25m) 행. 0.5% bin 방출(slope_bin)을 대체 — 연속값으로
    저장하고 bin은 학습 시점에 계산한다(FE utils/distanceRowTracker.ts)."""
    route_id:     int | None = None
    distance_m:   float
    slope_mean:   float             # 거리가중평균(부호 있음, %)
    slope_max:    float             # 절댓값 최대(%)
    ascent_m:     float = 0.0
    descent_m:    float = 0.0
    elapsed_ms:   int
    gps_sample_n: int
    # S2(stopClassifier) 집계 — 전부 optional(구버전 FE 호환, 하위호환).
    step_delta:       int | None = None
    stop_class:       str | None = None   # 'moving'|'gps_gap'|'uncertain'|'confirmed_stop'
    dwell_ms:         int | None = None
    moving_ms:        int | None = None
    avg_gps_accuracy: float | None = None
    device_model:     str | None = None
    near_crossing:    bool | None = None
    facility:         bool | None = None
    valid:            bool | None = None
    # S6 — slope 0/NULL/교량 구분('dem'|'bridge_zero'|'missing'). 구버전 FE는
    # 이 필드를 안 보내므로 하위호환 optional(BE에서 None→'missing'으로 보정).
    slope_source:     str | None = None
    # 2026-09 — stop_class=='uncertain'일 때 사유('low_sample'|'low_accuracy'|
    # 'step_deadzone'|'other'). 구버전 FE는 안 보냄, optional.
    uncertain_reason: str | None = None


class SpeedSamplePayload(BaseModel):
    route_id:       int | None = None
    slope_bin:      float
    sub_distance_m: float
    speed_ms:       float       # 원본 순간속도. 감속 판정(40% 등)은 학습 시점에 계산 (3.8절)


class RouteCandidatePayload(BaseModel):
    kind:      str              # 'type' | 'distance' | 'personal'
    profile:   list[dict]       # [{bin, length_m}, ...] 경사 히스토그램
    length_m:  float
    shown_pos: int               # 화면에 표시된 위치 (라벨 편향 방지용 무작위 순서 기록)


class RouteChoicePayload(BaseModel):
    candidates:  list[RouteCandidatePayload]
    n_shown:     int
    chosen_kind: str | None = None   # 'type'|'distance'|'personal', None이면 "비교 없음"


class SegmentFeedbackPayload(BaseModel):
    route_id:   int | None = None
    slope_mean: float
    length_m:   float
    verdict:    int             # -1 불편 / 0 보통 / +1 편함


class RouteProfileSegPayload(BaseModel):
    slope:    float                 # 부호 있는 경사(%)
    length_m: float


class RouteProfilePayload(BaseModel):
    # 세션 첫 배치에만 실려 온다. route_id 가 NULL 이어도 경로 형상을 잃지 않게 저장.
    route_id:       int | None = None
    total_length_m: float | None = None
    segments:       list[RouteProfileSegPayload] = []
    coordinates:    list[list[float]] | None = None   # [[lng,lat], ...] (선택)


class CollectBatchRequest(BaseModel):
    session_id:          str
    seq:                 int
    slope_observations:  list[SlopeObservationPayload] = []
    speed_samples:       list[SpeedSamplePayload] = []
    route_choice:        RouteChoicePayload | None = None
    segment_feedback:    list[SegmentFeedbackPayload] = []
    route_profile:       RouteProfilePayload | None = None


class CollectSessionStartRequest(BaseModel):
    session_id:  str
    walker_type: str = "elderly"
    app_version: str
    schema_ver:  int


@app.post("/collect/session/start")
def api_collect_session_start(
    body: CollectSessionStartRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """개인화 계측 세션(sessions 행) 생성 — /navigation/start와 의도적으로 독립적인
    엔드포인트. FE는 동의가 확정되는 시점(beginCollection 호출 시점 — 최초부터
    granted든, 모달 응답이 늦게 온 unknown→granted든)에 이걸 바로 부른다.

    기존엔 session_id 발급이 /navigation/start 요청 본문에만 실려 갔는데, 그
    요청은 동의 모달 응답을 기다리지 않고 즉시 나가서 "unknown 상태로 시작한
    첫 걸음"은 뒤늦게 동의해도 sessions 행이 영영 안 생겼다(실측: uid 9명·
    route 102개 중 session 1건 — "드문 edge case"가 아니라 사실상 모든 최초
    세션이 겪는 기본 경로였음, ⑤ 4순위 판단 철회 근거).

    sessions는 route_id를 갖지 않는 독립 엔티티(스키마 참고)라 이 호출이
    /navigation/start보다 먼저 오든 나중에 오든 순서는 무관하다 —
    navigation_measurements가 둘 다 FK로 참조하는 시점(GPS로 첫 measurement
    unit을 실제로 지날 때, 보통 안내 시작 수십 초~수 분 뒤)까지만 둘 다
    존재하면 된다. session_id는 PK라 /navigation/start 쪽의 기존 session_id
    파라미터와 중복 호출돼도 ON CONFLICT DO NOTHING으로 안전(start_session
    참고) — 그쪽은 하위호환으로 그대로 둔다."""
    ok = start_session(
        db,
        session_id=body.session_id,
        uid=decoded["uid"],
        user_type=body.walker_type,
        app_version=body.app_version,
        schema_ver=body.schema_ver,
    )
    if not ok:
        raise HTTPException(503, "DB 미설정")
    return {"ok": True}


class GpsFixStageRequest(BaseModel):
    session_id: str
    stage:      str   # 'best_nav' | 'high' | 'balanced' | 'none'
    fix_ms:     int


@app.post("/collect/session/gps-fix")
def api_collect_session_gps_fix(
    body: GpsFixStageRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """S0 보완 — GPS 정확도 fallback 중 첫 픽스를 받은 단계 기록(진단용, sessions
    UPDATE). 세션 소유자가 아니거나 sessions 행이 아직 없으면(레이스 — /collect/
    session/start보다 먼저 도착) 조용히 무시한다(안내 흐름을 막을 이유가 없는
    부가 정보라 404로 드러내지 않음, best-effort)."""
    record_gps_fix_stage(
        db,
        session_id=body.session_id,
        uid=decoded["uid"],
        stage=body.stage,
        fix_ms=body.fix_ms,
    )
    return {"ok": True}


@app.post("/collect/batch")
def api_collect_batch(
    body: CollectBatchRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """
    개인 맞춤 경로 추천용 신호 A~D 배치 저장.
    (uid, session_id, seq) 조합으로 멱등 처리 — 같은 배치를 재전송해도 중복 저장 안 됨.
    """
    result = save_collect_batch(
        db,
        uid=decoded["uid"],
        session_id=body.session_id,
        seq=body.seq,
        slope_observations=[o.model_dump() for o in body.slope_observations],
        speed_samples_in=[s.model_dump() for s in body.speed_samples],
        route_choice=body.route_choice.model_dump() if body.route_choice else None,
        segment_feedback_in=[f.model_dump() for f in body.segment_feedback],
        route_profile=body.route_profile.model_dump() if body.route_profile else None,
    )
    return result


class GpsPointPayload(BaseModel):
    seq:        int
    t_ms:       int
    lat:        float
    lon:        float
    accuracy_m: float | None = None
    speed_mps:  float | None = None


class GpsBatchRequest(BaseModel):
    session_id: str
    points:     list[GpsPointPayload] = []


@app.post("/collect/gps-batch")
def api_collect_gps_batch(
    body: GpsBatchRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """GPS 원본 궤적 배치 저장 (gps_traces) — 측정 파이프라인 v2 전용.

    기존 /collect/batch(신호 A~D, CollectBatchRequest)와 완전히 독립된
    엔드포인트다 — session_id 문자열 포맷은 같은 걸 공유하지만(FE가 동일하게
    발급) 저장 대상 테이블도, 멱등 키도 서로 무관하다. (session_id, seq) 기준
    멱등 — 같은 배치를 재전송해도 중복 저장되지 않는다.
    """
    if not body.points:
        return {"ok": True, "saved": 0}
    saved = save_gps_batch(
        db,
        uid=decoded["uid"],
        session_id=body.session_id,
        points=[p.model_dump() for p in body.points],
    )
    return {"ok": True, "saved": saved}


@app.get("/user/personalization-status")
def api_personalization_status(
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """개인화 학습 현황 (캘리브레이션 진행률 + zone별 관측 수). FE 마이페이지/안내 배지용."""
    return get_personalization_status(db, decoded["uid"])


# ── 요청 모델 ─────────────────────────────────────────────────────────────────
class RouteRequest(BaseModel):
    origin_lon: float
    origin_lat: float
    dest_lon:   float
    dest_lat:   float
    user_type:  str = "elderly"
    algorithm:  str = "auto"
    mode:       str = "accessibility"
    # ando_dev_final.md 8.2절 — 개인화 3경로 비교는 순수 보행 탐색 화면에서만 쓴다.
    # 대중교통 도보 구간(TransitContent.tsx의 requestWalkLeg 등)은 반드시 기본값인
    # "single"을 써야 한다. 안 그러면 카카오 후보 15개 × 도보구간 2개 = 최대 30개
    # 쿼리가 90개로 늘어나 대중교통 탭이 지금보다 더 심하게 타임아웃 난다 (8.1절).
    candidates: str = "single"   # "single" | "compare"
    # 목적지가 지하철역이면 역명을 함께 보냄 — 있으면 해당 역의 유형별 최적 출구
    # (엘리베이터/에스컬레이터) 좌표로 도착지를 스냅해서 경로를 계산한다.
    end_station_name: str | None = None
    # true면 교차로 기반 navigation_segments/waypoints(음성안내용) 생성을 생략하고
    # 거리·시간·경사만 반환 — 대중교통 탭에서 사용자가 아직 선택하지 않은 후보
    # 경로 수십 개의 승/하차 도보 구간을 한꺼번에 조회할 때, 실제로는 쓰이지도
    # 않을 GPS 안내 데이터를 매번 계산하는 낭비를 없앤다. 실제로 안내를 시작할
    # 경로(선택된 1개)는 이 플래그 없이 다시 조회해 전체 데이터를 받는다.
    light: bool = False


# ── 장소 검색 ─────────────────────────────────────────────────────────────────
@app.get("/search_places")
def api_search_places(q: str = Query(default="")):
    q = q.strip()
    if not q:
        return []
    return search_places(q)


@app.get("/debug_search")
def api_debug_search(q: str = Query(...)):
    return debug_raw(q.strip())


# ── 경로 탐색 ─────────────────────────────────────────────────────────────────
def _snap_debug(tag: str, lon: float, lat: float) -> None:
    """스냅 전 좌표 → 실제 매칭되는 그래프 노드와 그 사이 거리(m)를 로그로 남긴다.

    CCH KDTree는 LCC(최대 연결성분)에서 살아남은 노드만 담고 있으므로,
    거리가 수십~수백 m로 나오면 원래 가까운 도로가 그래프에서 잘려나갔다는
    뜻이다(= _connect_components의 LCC 삭제가 원인).
    """
    try:
        if _cch is not None:
            idx  = _cch._nearest_id(lon, lat)
            node = _cch.node_list[idx]
            nlon = _cch.G.nodes[node]["lon"]
            nlat = _cch.G.nodes[node]["lat"]
            src  = "CCH"
        else:
            node, _ = nearest_node(G, lon, lat)   # (node, dist) 튜플 반환
            nlon = G.nodes[node]["lon"]
            nlat = G.nodes[node]["lat"]
            src  = "NX"
        d    = haversine(lon, lat, nlon, nlat)
        flag = "  ⚠️ 원거리 스냅" if d > 50 else ""
        print(f"[SNAP/{src}] {tag}: 입력=({lon:.6f},{lat:.6f}) "
              f"→ 노드=({nlon:.6f},{nlat:.6f})  거리={d:.1f}m{flag}")
    except Exception as e:
        print(f"[SNAP] {tag} 스냅 로깅 실패: {e}")


def _segments_payload(segments: list, user_type: str) -> list:
    """result['segments'] → FE(WalkContent/NavigationScreen) 호환 seg 배열.

    유형별 경로와 '최단 거리' 경로가 같은 형식을 쓰므로 한 곳으로 뺐다.
    """
    out = []
    for s in segments:
        direction = s["direction"]
        slope_pct = s["slope_pct"]
        u_lon = G.nodes[s["u"]]["lon"]; u_lat = G.nodes[s["u"]]["lat"]
        v_lon = G.nodes[s["v"]]["lon"]; v_lat = G.nodes[s["v"]]["lat"]
        out.append({
            "name":      s.get("name", ""),
            "direction": direction,
            "slope_pct": round(slope_pct, 2),
            "length_m":  round(s["length_m"], 1),
            "score":     round(s["score_by_type"].get(user_type, 0), 1),
            "zone":      classify_zone(slope_pct, direction, user_type),
            "coords": [[u_lon, u_lat], [v_lon, v_lat]],
            "start": {"latitude": u_lat, "longitude": u_lon},
            "end":   {"latitude": v_lat, "longitude": v_lon},
            "slope":  round(slope_pct, 2),
            "length": round(s["length_m"], 1),
            "is_stairs": s.get("is_stairs", False),
            "slope_source": s.get("slope_source", "missing"),
        })
    return out


def _shortest_route_card(origin: tuple, dest: tuple, user_type: str,
                         type_len_m: float, speed_profile: dict,
                         precomputed_shortest_path: list | None = None) -> dict | None:
    """유형별 경로 옆에 함께 보여줄 '최단 거리'(순수 다익스트라) 카드.

    유형별 경로와 거의 같으면(≤3% 차) 카드 2장이 중복돼 보이므로 None 을 반환한다.
    실패해도 메인 응답을 막지 않게 호출부에서 감싼다.

    precomputed_shortest_path: find_route()가 내부적으로 이미 구해 둔
    shortest_path_nodes(alpha=0 경로) — 있으면 CCH 쿼리를 다시 돌리지 않고
    그대로 세그먼트만 복원한다(#3, 성능). find_distance_route(safe=False)와
    결과가 동일함을 전제로 한다 — 호출부가 safe 경로가 필요 없는 컨텍스트에서만
    넘겨야 한다.
    """
    if _cch is None:
        return None
    # 전 유형 계단 차단이라 카드도 계단을 피한다(SHORTEST_AVOID_STAIRS). find_route가
    # 구해 둔 순수 최단에 계단이 없으면 그게 곧 계단 회피 최단이라 그대로 재사용.
    if precomputed_shortest_path is not None and not _cch.path_has_stairs(precomputed_shortest_path):
        sr = _cch.distance_route_from_path(origin, dest, precomputed_shortest_path)
    else:
        sr = _cch.find_distance_route(origin, dest, avoid_stairs=True)
    s_len = round(sr["total_length_m"], 1)
    if s_len <= 0 or abs(s_len - type_len_m) / max(type_len_m, 1.0) <= 0.03:
        return None
    s_segs = _segments_payload(sr["segments"], user_type)
    return {
        "id":             "shortest",
        "tag":            "최단 거리",
        "color":          "#8A8FA3",
        "coordinates":    [[G.nodes[n]["lon"], G.nodes[n]["lat"]] for n in sr["path_nodes"]],
        "totalDistance":  s_len,
        "totalCost":      round(sr["total_cost"], 2),
        "avgSlope":       round(sr["avg_slope_pct"], 2),
        "routeSegments":  s_segs,
        "estimatedTimeS": estimate_route_time(s_segs, user_type, speed_profile),
    }


def _pick_best_exit_by_route_cost(
    origin: tuple, station_name: str, user_type: str,
) -> dict | None:
    """
    S7 — 출구 선택(진입: 길→역)을 직선거리 최근접 대신 origin에서 각 후보
    출구까지의 실제 경로비용으로 비교한다. 지상 구간이라 그래프가 있어
    가능한 경우 — 승강장→지상(exiting)은 여전히 get_best_exit의 최근접
    방식을 쓴다(subway/facility.py 참고, 그래프 없는 지하 구간이라 비용을
    낼 수 없음).

    비용은 안전거리(CCH metric_dist_safe: 금지구간+계단 배제, alpha=0)로
    비교한다 — 후보마다 개인화 alpha 이진탐색(최대 6회 CCH 쿼리)을 다 돌리면
    후보 수만큼 배가돼 느려지므로, 출구 "선택" 단계는 이미 계단·금지구간을
    배제한 안전 최단 비용으로 비교하고, 실제 표시될 유형별 최적 경로는 이
    함수가 고른 도착 좌표로 /route 가 평소대로(alpha 이진탐색 포함) 다시 계산한다.
    후보가 없거나 전부 라우팅 실패하면 None(호출측이 기존 좌표로 폴백).
    """
    if _subway_db is None or _cch is None:
        return None
    candidates = _subway_db.get_exit_candidates(station_name, user_type, direction="entering")
    if not candidates:
        return None

    # 후보가 여럿이면 출발지에서 가장 가까운(실제 도보 비용) 출구. 같은 출구에
    # 엘리베이터·에스컬레이터가 같이 있으면 좌표가 같으므로 출구당 1번만 계산한다.
    from subway.facility import describe_exit
    best, best_cost = None, float("inf")
    cost_by_exit: dict = {}
    for c in candidates:
        key = (c.get("exit_no"), round(c["lat"], 6), round(c["lon"], 6))
        if key not in cost_by_exit:
            try:
                r = _cch.find_distance_route(origin, (c["lon"], c["lat"]), safe=True)
                cost_by_exit[key] = r.get("total_cost")
            except Exception as e:
                print(f"[NAV] 출구 후보 {c.get('exit_no')} 비용 계산 실패(스킵): {e}")
                cost_by_exit[key] = None
        cost = cost_by_exit[key]
        if cost is not None and cost < best_cost:
            best, best_cost = c, cost

    if best is None:
        return None
    return {**best, **describe_exit(station_name, best, candidates)}


@app.post("/route")
def api_route(
    body: RouteRequest,
    db: Session = Depends(get_db),
    decoded: dict | None = Depends(_optional_verified),
):
    if body.user_type not in USER_TYPES:
        raise HTTPException(400, f"유효하지 않은 user_type: {body.user_type}")
    if body.candidates not in ("single", "compare"):
        raise HTTPException(400, "candidates는 'single' 또는 'compare'여야 합니다")

    _t_handler_start = time.perf_counter()   # [TIMING] 출구 선택까지 포함하려고 맨 앞에서 잰다
    try:
        origin = (body.origin_lon, body.origin_lat)
        dest   = (body.dest_lon,   body.dest_lat)

        # 목적지가 지하철역이면, 유형별 최적 출구 좌표로 도착지를 스냅한다.
        # S7 — 직선거리 최근접이 아니라 origin에서 각 후보까지의 실제 경로비용
        # (안전 최단, 계단·금지구간 배제)으로 비교한다. 후보 계산 실패/후보
        # 없음이면 기존 최근접 방식(get_best_exit)으로, 그마저 없으면 원래
        # 좌표 그대로 사용(다단 폴백).
        exit_info = None
        if body.end_station_name and _subway_db is not None:
            try:
                exit_info = _pick_best_exit_by_route_cost(
                    origin, body.end_station_name, body.user_type,
                )
                if not exit_info:
                    # 경로비용 계산 실패 시 폴백도 "출발지에서 가까운" 출구(직선거리)
                    exit_info = _subway_db.get_best_exit(
                        body.end_station_name, body.user_type, body.origin_lat, body.origin_lon,
                        direction="entering",
                    )
                if exit_info:
                    dest = (exit_info["lon"], exit_info["lat"])
            except Exception as e:
                print(f"[NAV] 역 출구 스냅 실패 → 원래 좌표 사용: {e}")

        # ── 서울 경계 밖 처리 (Task 2) — 에러 화면 대신 하이브리드 최단경로 ────────
        # 출발·도착이 모두 서울 안이면 이 분기는 아무것도 안 하고 지나간다(기존 흐름
        # 100% 불변). 하나라도 서울 밖이면: 서울 구간은 CCH(유형별/최단), 서울 밖은
        # 직선(경사 데이터 없음)으로 이어 붙여 도보 후보 2개를 돌려준다.
        if body.mode == "accessibility" and body.candidates != "compare":
            try:
                from routing.seoul_bounds import is_in_seoul
                _o_in = is_in_seoul(origin[0], origin[1])
                _d_in = is_in_seoul(dest[0], dest[1])
            except Exception:
                _o_in = _d_in = True
            if not (_o_in and _d_in):
                _hybrid = _hybrid_walk_response(origin, dest, body.user_type, _o_in, _d_in)
                if _hybrid is not None:
                    return _hybrid
                # 하이브리드도 실패 → 아래 기존 흐름으로 떨어져 결국 에러 처리
        # ── 진단 로그: 입력 좌표 + 실제 스냅되는 노드와의 거리 ────────────────
        snapped = dest != (body.dest_lon, body.dest_lat)
        print(f"[ROUTE] user_type={body.user_type}  mode={body.mode}  "
              f"end_station={body.end_station_name!r}")
        print(f"[ROUTE] origin=({origin[0]:.6f},{origin[1]:.6f})  "
              f"dest=({dest[0]:.6f},{dest[1]:.6f})"
              + (f"  (역출구 스냅 전=({body.dest_lon:.6f},{body.dest_lat:.6f}))" if snapped else ""))
        _snap_debug("origin", origin[0], origin[1])
        _snap_debug("dest",   dest[0],   dest[1])

        # ── 단계별 타이밍 로그(측정용, #2) — 실제 /route 요청에서 어디가
        # 지배적인지 확인하고 나서 최적화 대상을 정하기 위함. 요청마다 찍히므로
        # 운영 로그가 시끄러워지면 나중에 샘플링/제거 검토.
        _t_route_start = time.perf_counter()

        # CCH 전용 — pathfinder.find_route() NetworkX 폴백 제거(#4). 폴백이
        # 살아있을 때 실측된 지연(우회 이진탐색 시 최대 24~27초, 전체 그래프
        # O(E) 재계산 × 최대 10회)이 60초 타임아웃에 근접해 사실상 실패나
        # 다름없었다 — 느리게 성공하는 대신 즉시 에러로 명확히 실패한다.
        if _cch is None:
            raise ValueError("라우팅 엔진이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.")
        try:
            result = _cch.find_route(origin, dest, body.user_type)
        except Exception as e:
            print(f"[CCH] 쿼리 실패: {e}")
            raise ValueError("경로를 찾을 수 없습니다.")
        _t_find_route = time.perf_counter()

        coords = [
            [G.nodes[n]["lon"], G.nodes[n]["lat"]]
            for n in result["path_nodes"]
        ]

        segs = _segments_payload(result["segments"], body.user_type)

        total_length_m = round(result["total_length_m"], 1)
        total_cost     = round(result["total_cost"], 2)
        avg_slope_pct  = round(result["avg_slope_pct"], 2)
        user_label     = result["user_label"]

        # 개인화 소요시간 추정 (로그인 유저만, 없으면 기본값 사용)
        speed_profile: dict = {}
        if decoded:
            try:
                speed_profile = get_user_speed_profile(db, decoded["uid"])
            except Exception:
                pass
        estimated_time_s = estimate_route_time(segs, body.user_type, speed_profile)

        # WalkContent ServerRoute 형식으로 래핑
        route_obj = {
            "id":              "accessibility",
            "tag":             user_label,
            "color":           "#3DBFA8",
            "coordinates":     coords,
            "totalDistance":   total_length_m,
            "totalCost":       total_cost,
            "avgSlope":        avg_slope_pct,
            "routeSegments":   segs,
            "estimatedTimeS":  estimated_time_s,
        }

        # '최단 거리' 카드 — 유형별 경로와 나란히 WalkContent 2번째 탭으로.
        # light(대중교통 대량 조회) / compare(개인화 3경로)엔 붙이지 않는다.
        shortest_obj = None
        if not body.light and body.candidates != "compare":
            try:
                shortest_obj = _shortest_route_card(
                    origin, dest, body.user_type, total_length_m, speed_profile,
                    precomputed_shortest_path=result.get("shortest_path_nodes"),
                )
            except Exception as _se:
                print(f"[ROUTE] 최단 경로 카드 생성 실패 (무시): {_se}")
        _t_shortest_card = time.perf_counter()

        # ── 교차로 기반 네비게이션 구간 + 음성안내 + 소요시간 ───────────────────
        # nav_segs(구간별 경사 zone)는 대중교통 탭 후보 경로들의 지도 미리보기
        # 색칠에도 쓰이므로 light 모드에서도 항상 계산한다. waypoints(교차로별
        # 회전 음성안내)는 실제 GPS 안내를 시작한 경로에서만 쓰이므로, light=True
        # (아직 선택 전인 후보 경로 조회)면 이 부분만 건너뛴다.
        nav_segs, waypoints, nav_time = [], [], {}
        measurement_units = []
        _node_to_path_idx: dict = {}
        _t_nav_segs = time.perf_counter()  # try 초반 실패 시에도 폴백값 보장
        try:
            nav_segs = build_navigation_segments(
                G, result["path_nodes"], body.user_type, waypoints_set=_waypoints_set
            )
            nav_time = estimate_nav_time(nav_segs, body.user_type)
            _t_nav_segs = time.perf_counter()

            # path_nodes → coordinates 배열 인덱스 매핑 (첫 등장 우선). 아래
            # navigation_segments의 coord_start_idx/coord_end_idx(지도 색칠 구간
            # 슬라이싱용)가 여기 의존하므로 light 모드에서도 항상 채운다 — 예전엔
            # not body.light 안에 있어서 light 모드(대중교통 탭 승차 전/하차 후
            # 도보 조회)의 모든 구간이 0/0으로 나와 coords.slice(0,1)=점 1개→FE
            # 필터("좌표 2개 이상")에 전부 걸러짐→지도에서 직선 폴백으로 보이던 버그.
            for _i, _n in enumerate(result["path_nodes"]):
                if _n not in _node_to_path_idx:
                    _node_to_path_idx[_n] = _i

            if not body.light:
                # 측정 파이프라인 v2 — GPS 실측(navigation_measurements) 제출 단위.
                # nav_segs(교차로 기준, 지도색/안내용)와 목적이 다른 완전히 별개의
                # 분할이라 독립적으로 계산한다(하나가 실패해도 다른 하나는 살아있게
                # try를 나눈다). light 모드(후보 대량 조회)에선 waypoints와 마찬가지로
                # 건너뛴다 — 실제로 GPS 안내를 시작하는 경로에서만 의미가 있다.
                try:
                    units = build_measurement_units(G, result["path_nodes"])
                    measurement_units = [
                        {
                            "unit_index":      u.unit_index,
                            "distance_m":      u.distance_m,
                            "slope_pct":       u.slope_pct,
                            "is_stairs":       u.is_stairs,
                            "coord_start_idx": _node_to_path_idx.get(u.start_node, 0),
                            "coord_end_idx":   _node_to_path_idx.get(u.end_node, 0),
                            "start_coords":    [round(G.nodes[u.start_node]["lon"], 7),
                                                round(G.nodes[u.start_node]["lat"], 7)],
                            "end_coords":      [round(G.nodes[u.end_node]["lon"], 7),
                                                round(G.nodes[u.end_node]["lat"], 7)],
                        }
                        for u in units
                    ]
                except Exception as _mu_err:
                    print(f"[NAV] measurement_units 생성 실패 (무시): {_mu_err}")
                _t_measurement_units = time.perf_counter()

                for i, seg in enumerate(nav_segs[:-1]):
                    wp = G.nodes[seg.end_node]

                    # 현재 구간 끝 방향 (마지막 인터미디어트 → end_node)
                    prev_nd_key = (seg.intermediate_nodes[-1] if seg.intermediate_nodes
                                   else seg.start_node)
                    prev_nd = G.nodes[prev_nd_key]
                    cur_bearing = calculate_bearing(
                        prev_nd["lon"], prev_nd["lat"], wp["lon"], wp["lat"]
                    )

                    # 다음 구간 첫 방향 (end_node → 첫 인터미디어트 or end_node)
                    next_seg = nav_segs[i + 1]
                    next_nd_key = (next_seg.intermediate_nodes[0] if next_seg.intermediate_nodes
                                   else next_seg.end_node)
                    next_nd = G.nodes[next_nd_key]
                    next_bearing = calculate_bearing(
                        wp["lon"], wp["lat"], next_nd["lon"], next_nd["lat"]
                    )

                    turn = get_turn_direction(cur_bearing, next_bearing)
                    waypoints.append({
                        "lat":              wp["lat"],
                        "lon":              wp["lon"],
                        "turn_direction":   turn,
                        "guidance_text":    generate_guidance_text(turn, next_seg),
                        "distance_to_next": round(next_seg.length_m, 1),
                    })
        except Exception as _nav_err:
            print(f"[NAV] 네비게이션 구간 생성 실패 (무시): {_nav_err}")
        _t_waypoints = time.perf_counter()
        # light 모드는 measurement_units/waypoints 블록 자체를 안 타서 위 두
        # 타임스탬프가 없을 수 있음 — 그 구간 소요는 0으로 본다(실제로 안 돎).
        _t_measurement_units = locals().get("_t_measurement_units", _t_nav_segs)
        print(
            f"[TIMING] /route  pre(exit_snap 등)={_t_route_start - _t_handler_start:.3f}s  "
            f"find_route={_t_find_route - _t_route_start:.3f}s  "
            f"shortest_card={_t_shortest_card - _t_find_route:.3f}s  "
            f"nav_segs={_t_nav_segs - _t_shortest_card:.3f}s  "
            f"measurement_units={_t_measurement_units - _t_nav_segs:.3f}s  "
            f"waypoints={_t_waypoints - _t_measurement_units:.3f}s  "
            f"total={_t_waypoints - _t_handler_start:.3f}s"
        )

        response = {
            # FE WalkContent 호환 필드 — 유형별 + (다르면) 최단 거리
            "routes":           [route_obj] if shortest_obj is None else [route_obj, shortest_obj],
            "coordinates":      coords,
            "routeSegments":    segs,
            # 원본 필드 유지 (하위 호환)
            "algorithm":        result["algorithm"],
            "total_length_m":   total_length_m,
            "total_cost":       total_cost,
            "avg_slope_pct":    avg_slope_pct,
            "user_label":       user_label,
            "segments":         segs,
            "estimatedTimeS":   estimated_time_s,
            # Task 4: 교차로 기반 네비게이션 (새 필드, 하위 호환 추가)
            "estimated_time_min": nav_time.get("total_minutes", 0.0),
            "navigation_segments": [
                {
                    "segment_id":        s.segment_id,
                    "length_m":          round(s.length_m, 1),
                    "slope_mean":        s.slope_mean,
                    "slope_max":         s.slope_max,
                    "slope_stddev":      s.slope_stddev,
                    "zone":              s.zone,
                    "is_stairs":         s.is_stairs,
                    "estimated_seconds": (nav_time["segments"][i]["estimated_seconds"]
                                          if nav_time.get("segments") and i < len(nav_time["segments"])
                                          else 0.0),
                    "coord_start_idx":   _node_to_path_idx.get(s.start_node, 0),
                    "coord_end_idx":     _node_to_path_idx.get(s.end_node, 0),
                    "start_coords":      [round(G.nodes[s.start_node]["lon"], 7),
                                          round(G.nodes[s.start_node]["lat"], 7)],
                    "end_coords":        [round(G.nodes[s.end_node]["lon"], 7),
                                          round(G.nodes[s.end_node]["lat"], 7)],
                }
                for i, s in enumerate(nav_segs)
            ],
            "waypoints": waypoints,
            # 측정 파이프라인 v2 — POST /navigation/{route_id}/segment 제출용
            # (unit_index, distance_m, slope_pct는 그대로, start_coords/end_coords는
            # FE의 PROXIMITY_THRESHOLD 도착판정·D신호 지도 하이라이트용).
            "measurement_units": measurement_units,
        }

        if body.candidates == "compare":
            # "personal" 후보는 로그인한 사용자의 캐시에 θ 기반 metric이 이미 있을
            # 때만 채워진다 (⑧ PersonalMetricCache). 배치 스크립트(⑨)가 아직 없어서
            # 지금은 캐시가 항상 비어있고, 그래서 아직은 사실상 "type"+"distance" 2개
            # 뿐이다 — 배치가 채워지기 시작하면 코드 변경 없이 자동으로 3개가 된다.
            # FE는 candidateRoutes 배열을 그대로 순회하면 되고, 길이를 2/3으로
            # 가정하면 안 된다. 라벨은 반드시 중립(예: "경로 A/B/C")으로 표시하고,
            # shown_pos는 매 응답마다 무작위로 섞어서 내려줘야 한다 (6.4절).
            candidate_routes = [
                {
                    "kind":          "type",
                    "coordinates":   coords,
                    "totalDistance": total_length_m,
                    "avgSlope":      avg_slope_pct,
                    "estimatedTimeS": estimated_time_s,
                    "routeSegments": segs,
                    # "type" 은 메인 경로라 이미 위에서 계산해 둔 nav_segs/waypoints 를
                    # 그대로 붙인다(재계산 안 함) — light 모드였으면(드묾: compare 는
                    # 보통 light 없이 호출) waypoints 가 비어 있을 수 있음.
                    "navigation_segments": response["navigation_segments"],
                    "waypoints":     response["waypoints"],
                    "measurement_units": response["measurement_units"],
                },
            ]

            dist_result = None
            if _cch is not None:
                try:
                    dist_result = _cch.find_distance_route(origin, dest)
                    dist_coords = [
                        [G.nodes[n]["lon"], G.nodes[n]["lat"]]
                        for n in dist_result["path_nodes"]
                    ]
                    # 같은 경로면(노드열 동일) 중복 후보로 넣지 않는다 (6.3절 —
                    # 가짜 선택이 쌓이면 β·γ 추정이 오염됨).
                    if dist_result["path_nodes"] != result["path_nodes"]:
                        dist_speed_profile: dict = {}
                        if decoded:
                            try:
                                dist_speed_profile = get_user_speed_profile(db, decoded["uid"])
                            except Exception:
                                pass
                        dist_segs_for_time = [
                            {"zone": classify_zone(s["slope_pct"], s["direction"], body.user_type),
                             "direction": s["direction"], "length_m": s["length_m"]}
                            for s in dist_result["segments"]
                        ]
                        dist_nav_segs, dist_waypoints = _nav_segs_and_waypoints(
                            dist_result["path_nodes"], body.user_type
                        )
                        try:
                            dist_measurement_units = _measurement_units_payload(dist_result["path_nodes"])
                        except Exception as _dmu_err:
                            print(f"[NAV] distance 후보 measurement_units 생성 실패 (무시): {_dmu_err}")
                            dist_measurement_units = []
                        candidate_routes.append({
                            "kind":          "distance",
                            "coordinates":   dist_coords,
                            "totalDistance": round(dist_result["total_length_m"], 1),
                            "avgSlope":      round(dist_result["avg_slope_pct"], 2),
                            "estimatedTimeS": estimate_route_time(
                                dist_segs_for_time, body.user_type, dist_speed_profile
                            ),
                            "routeSegments": _candidate_segs(dist_result["segments"], body.user_type),
                            "navigation_segments": dist_nav_segs,
                            "waypoints":     dist_waypoints,
                            "measurement_units": dist_measurement_units,
                        })
                except Exception as e:
                    print(f"[route2] 거리경로 조회 실패 (무시): {e}")

            if _personal_cache is not None and decoded is not None:
                personal_metric = _personal_cache.get(decoded["uid"])
                if personal_metric is not None:
                    try:
                        personal_result = _cch.find_route_with_metric(
                            origin, dest, personal_metric,
                            label="맞춤 경로", kind="personal",
                        )
                        # 이미 나온 경로(①type, ②distance)와 노드열이 같으면 중복
                        # 후보로 넣지 않는다 (6.3절 — 가짜 선택 데이터가 β·γ 추정을 오염시킴).
                        already_shown = any(
                            r is not None and personal_result["path_nodes"] == r["path_nodes"]
                            for r in (result, dist_result)
                        )
                        if not already_shown:
                            personal_coords = [
                                [G.nodes[n]["lon"], G.nodes[n]["lat"]]
                                for n in personal_result["path_nodes"]
                            ]
                            personal_speed_profile: dict = {}
                            try:
                                personal_speed_profile = get_user_speed_profile(db, decoded["uid"])
                            except Exception:
                                pass
                            personal_segs_for_time = [
                                {"zone": classify_zone(s["slope_pct"], s["direction"], body.user_type),
                                 "direction": s["direction"], "length_m": s["length_m"]}
                                for s in personal_result["segments"]
                            ]
                            personal_nav_segs, personal_waypoints = _nav_segs_and_waypoints(
                                personal_result["path_nodes"], body.user_type
                            )
                            try:
                                personal_measurement_units = _measurement_units_payload(personal_result["path_nodes"])
                            except Exception as _pmu_err:
                                print(f"[NAV] personal 후보 measurement_units 생성 실패 (무시): {_pmu_err}")
                                personal_measurement_units = []
                            candidate_routes.append({
                                "kind":          "personal",
                                "coordinates":   personal_coords,
                                "totalDistance": round(personal_result["total_length_m"], 1),
                                "avgSlope":      round(personal_result["avg_slope_pct"], 2),
                                "estimatedTimeS": estimate_route_time(
                                    personal_segs_for_time, body.user_type, personal_speed_profile
                                ),
                                "routeSegments": _candidate_segs(personal_result["segments"], body.user_type),
                                "navigation_segments": personal_nav_segs,
                                "waypoints":     personal_waypoints,
                                "measurement_units": personal_measurement_units,
                            })
                    except Exception as e:
                        print(f"[route3] 맞춤경로 조회 실패 (무시): {e}")

            response["candidateRoutes"] = candidate_routes

        # 도착지가 역이라 출구로 스냅했으면 FE 표시용 출구 정보(역·출구번호·시설·문구)
        if exit_info:
            response["stationExit"] = {
                "station":    exit_info.get("station"),
                "exitNo":     exit_info.get("exit_no"),
                "facilities": exit_info.get("facilities") or [exit_info.get("type")],
                "message":    exit_info.get("message"),
                "lat":        exit_info.get("lat"),
                "lon":        exit_info.get("lon"),
            }

        return response

    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"서버 오류: {e}")


# ── 안전 경로 탐색 (/route 별칭 — 외부 API 제거 후 내부 그래프 전용) ──────────
@app.post("/route/safe")
def api_route_safe(
    body: RouteRequest,
    db: Session = Depends(get_db),
    decoded: dict | None = Depends(_optional_verified),
):
    """내부 그래프 기반 경로 탐색 (/route 동일 로직, FE 호환을 위해 엔드포인트 유지)"""
    return api_route(body, db, decoded)


# ── 지하철 입구 스냅 (카카오 대중교통 응답의 stops[].name과 매칭) ─────────────

@app.get("/subway/best-exit")
def api_subway_best_exit(
    station: str = Query(..., description="역명 (카카오 stops[].name 그대로, 예: 이태원, 용산)"),
    user_type: str = Query("elderly", description="이동 유형"),
    lat: float = Query(..., description="현재 위치 위도"),
    lon: float = Query(..., description="현재 위치 경도"),
):
    """
    지하철 역 입구 스냅 — user_type·위치 기준 최적 출구 반환

    - 수동/전동 휠체어, 워커 → 가장 가까운 운행 중 엘리베이터 출구
    - 지팡이·다리부상·고령자 → 에스컬레이터 우선, 없으면 엘리베이터 출구

    FE(대중교통 탭)에서 카카오 응답의 하차역 이름으로 조회해
    승강장→출구 안내에 붙여 쓴다. 데이터/서비스 미가용 시 404 → FE는
    답사 기반 하드코딩 정보로 폴백.

    S7 — direction="exiting"(플랫폼→지상, 상행 에스컬레이터만 후보) 명시.
    이 구간은 그래프에 없는 지하 구간이라 경로비용 비교가 불가능해 최근접
    방식을 그대로 쓴다(진입 방향 비용비교는 /route 내부의
    _pick_best_exit_by_route_cost 참고).
    """
    if _subway_db is None:
        raise HTTPException(503, "지하철 편의시설 DB 미초기화 (subway_data 디렉토리 확인 필요)")
    if user_type not in USER_TYPES:
        raise HTTPException(400, f"유효하지 않은 user_type: {user_type}")

    result = _subway_db.get_best_exit(station, user_type, lat, lon, direction="exiting")
    if result is None:
        raise HTTPException(404, f"'{station}' 역에서 {user_type} 유형이 이용 가능한 출구를 찾을 수 없습니다")
    return result


@app.get("/subway/station-summary")
def api_subway_station_summary(
    station: str = Query(..., description="역명"),
):
    """역 내 편의시설 수 요약 (엘리베이터·에스컬레이터·휠체어리프트)"""
    if _subway_db is None:
        raise HTTPException(503, "지하철 편의시설 DB 미초기화")
    return _subway_db.station_summary(station)


@app.get("/subway/chargers")
def api_subway_chargers(
    station: str | None = Query(None, description="역명 (생략 시 전체 119건 반환)"),
):
    """
    지하철역 내 전동휠체어 충전설비 위치 (서울 열린데이터광장 OA-22745, 1~8호선 전역)

    거리 급속충전소(마이그레이션된 charging_stations 테이블, 현재 용산구만 적재)와
    별개의 데이터 — 지하철 이용 중 배터리 부족 시 "이 역 안에 충전기가 있는지"를
    바로 알려주는 보완 용도.
    """
    return get_station_chargers(station)


@app.get("/bus/lowfloor")
def api_bus_lowfloor(
    route_no: str = Query(..., description="버스 번호 (카카오 vehicles[].name과 동일 표기, 예: 402)"),
):
    """
    노선별 저상버스 보유율 (서울 열린데이터광장 OA-22229, 정적 데이터·실시간 아님)

    카카오 대중교통 API는 저상버스 여부를 전혀 제공하지 않아, 노선번호로
    매칭 가능한 이 정적 데이터로 보완한다. 데이터 파일 미다운로드 시 404.
    """
    info = get_lowfloor_info(route_no)
    if info is None:
        raise HTTPException(404, f"'{route_no}' 노선의 저상버스 정보를 찾을 수 없습니다")
    return info


@app.get("/bus/arrival")
def api_bus_arrival(
    route:            str        = Query(..., description="버스 번호 (카카오 vehicles[].name, 예: 402)"),
    stop:             str | None = Query(None, description="승차 정류소명 (카카오 stops[].name)"),
    ars_id:           str | None = Query(None, description="정류소 고유번호(5자리). 있으면 이름보다 우선"),
    bus_route_id:     str | None = Query(None, description="busRouteId 를 이미 알면 직접 전달(노선명 조회 생략)"),
    walk_remaining_s: float | None = Query(None, description="승차 정류소까지 남은 도보 시간(초) — 놓칠 위험 계산용"),
):
    """
    서울시 버스도착정보 실시간 (공공데이터포털 서비스, 키는 서버에만 보관).

    항상 200 + dict 를 돌려준다. 키 미설정·노선ID 미해결·정류소 미매칭·운행중 버스
    없음 등은 `available:false` + `reason` 으로 표현 — FE 는 그 경우 실시간 배지를
    숨기고 정적(카카오) 시간을 유지한다(graceful degradation).
    """
    return bus_arrival.arrival_for_boarding(
        route_name=route,
        stop_name=stop,
        ars_id=ars_id,
        bus_route_id=bus_route_id,
        walk_remaining_s=walk_remaining_s,
    )


@app.get("/subway/arrival")
def api_subway_arrival(
    station:  str        = Query(..., description="승차역명 (카카오 stops[].name, 예: 서울역)"),
    line_no:  str | None = Query(None, description="노선번호 (카카오 vehicle.name에서 '호선' 뗀 값, 예: 4)"),
):
    """
    서울시 지하철 실시간 도착정보 (서울 열린데이터광장, 키는 서버에만 보관).

    항상 200 + dict 를 돌려준다. 키 미설정·역명 미매칭·운행중 열차 없음 등은
    `available:false` + `reason` 으로 표현 — FE 는 그 경우 실시간 배지를 숨긴다.
    방향(상행/하행)은 확정할 수 없어 추측하지 않고, 각 열차의 종착지 방면
    텍스트(direction)를 그대로 같이 돌려준다 — FE가 그 텍스트를 보여줘서
    사용자가 맞는 방향인지 스스로 확인할 수 있게 한다.
    """
    return subway_arrival.arrival_for_boarding(station_name=station, line_no=line_no)


# ── 유틸 ──────────────────────────────────────────────────────────────────────
@app.get("/user_types")
def api_user_types():
    return [{"key": k, "label": v["label"]} for k, v in USER_TYPES.items()]


@app.get("/health")
def health():
    return {"status": "ok", "nodes": G.number_of_nodes()}
