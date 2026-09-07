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

from config import GEOJSON_PATH, CoverageError
from routing import build_graph, find_route, USER_TYPES, classify_zone, precompute_edge_costs, shortest_route_nx
from routing.search import build_spatial_index
from routing.cch_engine import build_cch_engine, CCHEngine
from routing.personal_cache import PersonalMetricCache
from places.kakao import search_places, debug_raw
from database import (
    init_db, get_db, get_or_create_user, update_user_type,
    get_user_profile, get_user_stats, save_user_route, get_user_routes,
    delete_user_route, save_or_update_feedback,
    get_user_bookmarks, save_user_bookmark, delete_user_bookmark,
    get_search_history, save_search_history,
    start_navigation, add_navigation_segment, complete_navigation,
    save_zone_observation, get_user_speed_profile, save_collect_batch,
    delete_user_account, get_personalization_status,
    get_slow_segments, save_segment_hardship_feedback,
)
from routing.speed import get_zone_key, estimate_route_time, get_default_speed
from routing.segments import build_navigation_segments, extract_waypoints
from routing.graph import haversine
from routing.voice_guidance import calculate_bearing, get_turn_direction, generate_guidance_text
from routing.travel_time import estimate_route_time as estimate_nav_time
from firebase import verify_token, delete_firebase_user
from subway import get_facility_db, SubwayFacilityDB
from subway.facility import get_station_chargers
from lowfloor_bus import get_lowfloor_info
import bus_arrival

G = None
_spatial_index = None
_cch: CCHEngine | None = None
_personal_cache: PersonalMetricCache | None = None
_subway_db: SubwayFacilityDB | None = None
# extract_waypoints(G)는 그래프 전체 노드를 순회해 교차로를 찾는다 — 서울 전역
# 그래프(수십만 노드)에서 이걸 매 /route 요청마다 다시 계산하면 요청당 유의미한
# 지연이 생긴다. 그래프는 서버 실행 중 바뀌지 않으므로 1회만 계산해 재사용한다.
_waypoints_set: set | None = None


class _Prof:
    """
    2-2 탐색시간 프로파일링 — /route 요청 1건의 구간별 소요시간(ms)을 모아
    마지막에 한 줄(`[PROFILE] …`)로 출력한다. 실배포 서버 로그에서
    `grep '\\[PROFILE\\]'` 로 구간별 병목을 수집하는 용도.

    항상 켜져 있지만 요청당 딱 한 줄이라 로그 부담이 거의 없다. 완전히 끄려면
    환경변수 ROUTE_PROFILE=0.
    """
    _ENABLED = os.environ.get("ROUTE_PROFILE", "1") not in ("0", "false", "False")

    def __init__(self, tag: str):
        self.tag = tag
        self.t0 = self.last = time.perf_counter()
        self.marks: list[tuple[str, float]] = []

    def mark(self, label: str) -> None:
        now = time.perf_counter()
        self.marks.append((label, (now - self.last) * 1000))
        self.last = now

    def done(self, **extra) -> None:
        if not self._ENABLED:
            return
        total = (time.perf_counter() - self.t0) * 1000
        parts = "  ".join(f"{k}={v:.0f}ms" for k, v in self.marks)
        tail = "  ".join(f"{k}={v}" for k, v in extra.items())
        print(f"[PROFILE] {self.tag}  total={total:.0f}ms  {parts}  {tail}".rstrip())


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
    """서울 안 두 점 사이 leg. seoul_mode: 'type'|'shortest'. → (coords, result) | None."""
    try:
        if _cch is not None:
            r = (_cch.find_distance_route(o, d) if seoul_mode == "shortest"
                 else _cch.find_route(o, d, user_type))
        else:
            r = find_route(G, o, d, user_type, "auto", mode="accessibility")
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

    # CCH 전처리 (서울 전역 그래프에서 유효, 용산구는 NetworkX로도 충분)
    if G.number_of_nodes() > 200_000:
        try:
            print(f"[CCH] 노드 {G.number_of_nodes():,}개 - CCH 전처리 시작 (1~5분 소요)")
            _cch = build_cch_engine(G)
            print("[CCH] 준비 완료 - 이후 /route 요청은 CCH로 처리됩니다")
            # 개인 맞춤 metric 캐시 (⑧) - 시작 시엔 비어있음, 배치 스크립트(⑨)가
            # /personal/refresh 등으로 채워야 우선 채워짐. 요청 경로에서는
            # 절대 여기서 학습하지 않고, 이미 채워진 걸 읽기만 한다.
            _personal_cache = PersonalMetricCache(_cch.cch, _cch.basis_weights)
        except Exception as e:
            print(f"[CCH] 초기화 실패 -> NetworkX fallback: {e}")
            _cch = None
            _personal_cache = None
    else:
        print(f"[CCH] 노드 {G.number_of_nodes():,}개 - NetworkX 모드 유지")

    try:
        init_db()
    except Exception as e:
        print(f"[DB] 초기화 실패 (DB 없이 계속 실행): {e}")
    try:
        _subway_db = get_facility_db()
        print("[Subway] 편의시설 DB 로딩 완료")
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


class FeedbackRequest(BaseModel):
    rating: int


@app.post("/routes/{route_id}/feedback")
def api_save_feedback(
    route_id: int,
    body: FeedbackRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """만족도 저장/수정 (안내 직후 팝업 + 마이페이지 상세에서 모두 호출)"""
    if not (1 <= body.rating <= 5):
        raise HTTPException(400, "rating은 1~5 사이여야 합니다")
    return save_or_update_feedback(db, route_id, decoded["uid"], body.rating)


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


@app.post("/navigation/start")
def api_navigation_start(
    body: NavigationStartRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """안내 시작 — routes에 in_progress 행 생성, route_id 반환"""
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
    return {"route_id": route_id}


class NavigationSegmentRequest(BaseModel):
    index:      int
    distance_m: float
    slope_pct:  float          # 부호 있는 값 (양수=오르막, 음수=내리막)
    elapsed_ms: int            # 이 구간 단독 이동 시간(ms), 정지 대기 제외
    measured:   bool  = False  # True=GPS 실측, False=거리비례 추정
    zone:       str | None = None
    direction:  str | None = None


@app.post("/navigation/{route_id}/segment")
def api_add_segment(
    route_id: int,
    body: NavigationSegmentRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """구간 완료 시 호출 — navigation_segments에 실측 데이터 저장"""
    ok = add_navigation_segment(
        db,
        route_id=route_id,
        uid=decoded["uid"],
        index=body.index,
        distance_m=body.distance_m,
        slope_pct=body.slope_pct,
        elapsed_ms=body.elapsed_ms,
        measured=body.measured,
        zone=body.zone,
        direction=body.direction,
    )
    if not ok:
        raise HTTPException(404, "진행 중인 경로를 찾을 수 없거나 권한이 없습니다")
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
    total_duration_ms: int


@app.patch("/navigation/{route_id}/complete")
def api_complete_navigation(
    route_id: int,
    body: NavigationCompleteRequest,
    db: Session = Depends(get_db),
    decoded: dict = Depends(_verified),
):
    """안내 종료 — 구간 집계 후 status=completed 확정"""
    result = complete_navigation(
        db,
        route_id=route_id,
        uid=decoded["uid"],
        total_duration_ms=body.total_duration_ms,
    )
    if result is None:
        raise HTTPException(404, "진행 중인 경로를 찾을 수 없거나 권한이 없습니다")
    return result


# ── 구간 체감 난이도 평가 (⑭' — pace = 1m당 소요시간 기준) ───────────────────
# 안내 종료 후: pace 상위 min(10, 유효구간수) 구간에 대해 구간마다
#   Q1 was_uncomfortable(불편했나요 예/아니오) → 예면 Q2 hardship_score(1~10점).
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


class SegmentHardshipAnswer(BaseModel):
    seg_index:         int
    seg_index_end:     int | None = None   # 묶은 구간의 끝 엣지 (GET 이 준 값 되싣기)
    rank:              int
    pace_s_per_m:      float
    elapsed_ms:        int
    distance_m:        float
    slope_pct:         float
    zone:              str | None = None
    was_uncomfortable: bool
    hardship_score:    int | None = None   # 예일 때만 1~10, 아니오면 null


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
        if a.was_uncomfortable and a.hardship_score is None:
            raise HTTPException(400, f"seg_index={a.seg_index}: 불편함=예 이면 hardship_score(1~10) 필요")
        if a.hardship_score is not None and not (1 <= a.hardship_score <= 10):
            raise HTTPException(400, f"seg_index={a.seg_index}: hardship_score 는 1~10")
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


# ── 개인 맞춤 경로 추천 — 데이터 수집 (ando_dev_final.md 3.9절) ───────────────
# 신호 A~D를 세션 종료 시 1회(또는 2분/200행마다 중간 플러시) 배치로 받는다.
# 개별 전환마다 개별 POST를 쏘면 요청 폭증 + 배터리 소모가 커서 4종 엔드포인트가
# 아니라 1종으로 통합했다.

class SlopeObservationPayload(BaseModel):
    route_id:     int | None = None
    slope_bin:    float
    distance_m:   float
    elapsed_ms:   int
    stop_ms:      int = 0
    gps_sample_n: int


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

    prof = _Prof(f"/route mode={body.mode} candidates={body.candidates}")
    try:
        origin = (body.origin_lon, body.origin_lat)
        dest   = (body.dest_lon,   body.dest_lat)

        # 목적지가 지하철역이면, 유형별 최적 출구 좌표로 도착지를 스냅한다.
        # 해당 역 데이터가 없거나 조회 실패 시 원래 좌표 그대로 사용(폴백).
        if body.end_station_name and _subway_db is not None:
            try:
                exit_info = _subway_db.get_best_exit(
                    body.end_station_name, body.user_type, body.dest_lat, body.dest_lon
                )
                if exit_info:
                    dest = (exit_info["lon"], exit_info["lat"])
            except Exception as e:
                print(f"[NAV] 역 출구 스냅 실패 → 원래 좌표 사용: {e}")
        prof.mark("station_snap")

        # ── 서울 경계 밖 처리 (Task 2) — 에러/CoverageError 대신 하이브리드 최단경로 ──
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
                # 하이브리드도 실패 → 아래 기존 흐름으로 떨어져 결국 CoverageError 처리

        # CCH 우선 (서울 전역 그래프), fallback → NetworkX
        if _cch is not None and body.mode == "accessibility":
            try:
                result = _cch.find_route(origin, dest, body.user_type)
            except ValueError:
                # 커버리지 밖(스냅거리 초과) 등 CCH가 이미 명확히 판정한 거부는
                # NetworkX로 다시 시도해도 같은 결론이다 — 다만 NetworkX는
                # 그래프 전체(수십만~백만 노드)를 순회하는 무차별 탐색이라
                # 이 경로에서 재시도하면 그 자체로 요청 하나가 몇 초씩 걸린다.
                # 재시도 없이 그대로 올려 위 except ValueError(400)로 보낸다.
                raise
            except Exception as e:
                print(f"[CCH] 쿼리 실패 → NetworkX fallback: {e}")
                result = find_route(G, origin, dest, body.user_type,
                                    body.algorithm, mode=body.mode)
        else:
            result = find_route(G, origin, dest, body.user_type,
                                body.algorithm, mode=body.mode)
        prof.mark("find_route")

        coords = [
            [G.nodes[n]["lon"], G.nodes[n]["lat"]]
            for n in result["path_nodes"]
        ]

        segs = []
        for s in result["segments"]:
            direction = s["direction"]
            slope_pct = s["slope_pct"]
            u_lon = G.nodes[s["u"]]["lon"]
            u_lat = G.nodes[s["u"]]["lat"]
            v_lon = G.nodes[s["v"]]["lon"]
            v_lat = G.nodes[s["v"]]["lat"]
            segs.append({
                "name":      s.get("name", ""),
                "direction": direction,
                "slope_pct": round(slope_pct, 2),
                "length_m":  round(s["length_m"], 1),
                "score":     round(s["score_by_type"].get(body.user_type, 0), 1),
                "zone":      classify_zone(slope_pct, direction, body.user_type),
                # coords: GeoJSON [lon, lat] 쌍 (기존 호환)
                "coords": [[u_lon, u_lat], [v_lon, v_lat]],
                # FE NavigationScreen normalizeSegments 호환 형식
                "start": {"latitude": u_lat, "longitude": u_lon},
                "end":   {"latitude": v_lat, "longitude": v_lon},
                # slope / length 별칭 (normalizeSegments fallback 대응)
                "slope":  round(slope_pct, 2),
                "length": round(s["length_m"], 1),
            })

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
        prof.mark("segs+speed_profile")

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

        # ── 교차로 기반 네비게이션 구간 + 음성안내 + 소요시간 ───────────────────
        # nav_segs(구간별 경사 zone)는 대중교통 탭 후보 경로들의 지도 미리보기
        # 색칠에도 쓰이므로 light 모드에서도 항상 계산한다. waypoints(교차로별
        # 회전 음성안내)는 실제 GPS 안내를 시작한 경로에서만 쓰이므로, light=True
        # (아직 선택 전인 후보 경로 조회)면 이 부분만 건너뛴다.
        nav_segs, waypoints, nav_time = [], [], {}
        _node_to_path_idx: dict = {}
        try:
            nav_segs = build_navigation_segments(
                G, result["path_nodes"], body.user_type, waypoints_set=_waypoints_set
            )
            nav_time = estimate_nav_time(nav_segs, body.user_type)

            if not body.light:
                # path_nodes → coordinates 배열 인덱스 매핑 (첫 등장 우선)
                for _i, _n in enumerate(result["path_nodes"]):
                    if _n not in _node_to_path_idx:
                        _node_to_path_idx[_n] = _i

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
        prof.mark("nav_build(type)")

        response = {
            # FE WalkContent 호환 필드
            "routes":           [route_obj],
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
                        })
                except Exception as e:
                    print(f"[route2] 거리경로 조회 실패 (무시): {e}")
            prof.mark("distance_cand")

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
                            })
                    except Exception as e:
                        print(f"[route3] 맞춤경로 조회 실패 (무시): {e}")
            prof.mark("personal_cand")

            response["candidateRoutes"] = candidate_routes

            # ── 최단경로 2종 비교 (CCH vs NetworkX) + 유형 우회율 계측 ──────────
            # candidateRoutes(선택 로그용)는 건드리지 않고, 별도 필드로만 싣는다.
            #   routingComparison : 시각화 안 되는 계측값(소요시간·탐색 자원·우회율)
            #   debugRoutes       : 지도에 겹쳐 그릴 최단경로 2종 좌표
            try:
                marks = dict(prof.marks)
                rc: dict = {
                    "od_straight_m": round(haversine(*origin, *dest), 1),
                    "type": {
                        "engine":    "cch",
                        "length_m":  total_length_m,
                        "avgSlope":  avg_slope_pct,
                        "query_ms":  round(marks.get("find_route", 0.0), 1),
                        "used_alpha": result.get("used_alpha"),
                        "path_nodes": len(result["path_nodes"]),
                    },
                }
                debug_routes: list = []

                # (c) CCH 순수 최단 (alpha=0, metric_dist)
                sc = None
                if _cch is not None:
                    try:
                        sc = _cch.find_shortest_route(origin, dest)
                        rc["shortest_cch"] = {
                            "engine":     "cch",
                            "length_m":   round(sc["total_length_m"], 1),
                            "avgSlope":   round(sc["avg_slope_pct"], 2),
                            "query_ms":   sc["query_ms"],
                            "total_ms":   sc["total_ms"],
                            "path_nodes": sc["path_node_count"],
                        }
                        debug_routes.append({
                            "kind":          "shortest_cch",
                            "label":         "최단거리(CCH)",
                            "color":         "#F4A100",
                            "coordinates":   [[G.nodes[n]["lon"], G.nodes[n]["lat"]]
                                              for n in sc["path_nodes"]],
                            "totalDistance": round(sc["total_length_m"], 1),
                            "avgSlope":      round(sc["avg_slope_pct"], 2),
                        })
                    except Exception as e:
                        rc["shortest_cch"] = {"error": str(e)}

                # (b) NetworkX 순수 최단 (Dijkstra, weight=length_m) — 평가 전용.
                #     배포 라우팅은 CCH 단독(위 shortest_cch)이고, NetworkX 는
                #     "CCH 대비 얼마나 느린가"를 재는 대조군일 뿐이다. 서울 전역
                #     그래프에서 장거리 Dijkstra 는 수 초~수십 초 걸려 응답을 막으므로
                #     기본값 SHORTEST_NX_MAX_KM=0 (완전 비활성). 벤치마크 시에만
                #     scripts/shortest_bench.py 안내대로 SHORTEST_NX_MAX_KM=50 등으로
                #     서버를 띄워 켠다.
                nx_cap_km = float(os.environ.get("SHORTEST_NX_MAX_KM", "0"))
                if nx_cap_km <= 0 or rc["od_straight_m"] > nx_cap_km * 1000:
                    rc["shortest_nx"] = {
                        "skipped": ("배포 기본 비활성 (SHORTEST_NX_MAX_KM=0)"
                                    if nx_cap_km <= 0 else
                                    f"직선거리 {rc['od_straight_m']/1000:.1f}km > "
                                    f"{nx_cap_km:.0f}km (NX Dijkstra 스킵)")
                    }
                else:
                    try:
                        sn = shortest_route_nx(G, origin, dest)
                        rc["shortest_nx"] = {
                            "engine":         "nx-dijkstra",
                            "length_m":       round(sn["total_length_m"], 1),
                            "avgSlope":       round(sn["avg_slope_pct"], 2),
                            "query_ms":       sn["query_ms"],
                            "nodes_settled":  sn["nodes_settled"],
                            "edges_relaxed":  sn["edges_relaxed"],
                            "heap_pushes":    sn["heap_pushes"],
                            "peak_heap":      sn["peak_heap"],
                            "graph_nodes":    sn["graph_nodes"],
                            "path_nodes":     sn["path_node_count"],
                        }
                        debug_routes.append({
                            "kind":          "shortest_nx",
                            "label":         "최단거리(NetworkX)",
                            "color":         "#8E44EC",
                            "coordinates":   [[G.nodes[n]["lon"], G.nodes[n]["lat"]]
                                              for n in sn["path_nodes"]],
                            "totalDistance": round(sn["total_length_m"], 1),
                            "avgSlope":      round(sn["avg_slope_pct"], 2),
                        })
                    except Exception as e:
                        rc["shortest_nx"] = {"error": str(e)}
                prof.mark("shortest_bench")

                # 우회율 — 순수 최단(CCH) 기준
                base_len = None
                if sc is not None:
                    base_len = sc["total_length_m"]
                if base_len and base_len > 0:
                    rc["detour"] = {
                        "base": "shortest_cch",
                        "base_length_m": round(base_len, 1),
                        # 유형 점수(경사비용)에 의한 우회율
                        "type_vs_shortest": round(total_length_m / base_len, 4),
                    }
                    # distance 후보(급경사 배제 최단)도 있으면 함께
                    dcand = next((c for c in candidate_routes if c["kind"] == "distance"), None)
                    if dcand:
                        rc["detour"]["safe_distance_vs_shortest"] = round(
                            dcand["totalDistance"] / base_len, 4
                        )

                # 엔진 효율 비교 (둘 다 성공했을 때만)
                if (isinstance(rc.get("shortest_cch"), dict) and "query_ms" in rc["shortest_cch"]
                        and isinstance(rc.get("shortest_nx"), dict) and "query_ms" in rc["shortest_nx"]):
                    cch_ms = rc["shortest_cch"]["query_ms"] or 0.001
                    nx_ms  = rc["shortest_nx"]["query_ms"]
                    cch_visits = rc["shortest_cch"]["path_nodes"]
                    nx_settled = rc["shortest_nx"]["nodes_settled"]
                    rc["engine_compare"] = {
                        "cch_query_ms":  rc["shortest_cch"]["query_ms"],
                        "nx_query_ms":   nx_ms,
                        "speedup_x":     round(nx_ms / cch_ms, 1),
                        "paths_identical": (sc is not None and sn is not None
                                            and sc["path_nodes"] == sn["path_nodes"]),
                        "length_delta_m": (round(rc["shortest_nx"]["length_m"]
                                                 - rc["shortest_cch"]["length_m"], 1)),
                        "cch_path_nodes": cch_visits,
                        "nx_nodes_settled": nx_settled,
                        "nx_edges_relaxed": rc["shortest_nx"]["edges_relaxed"],
                        "settled_vs_pathnodes_x": (round(nx_settled / cch_visits, 1)
                                                   if cch_visits else None),
                    }

                response["routingComparison"] = rc
                if debug_routes:
                    response["debugRoutes"] = debug_routes
                print(f"[ROUTECMP] {rc}")
            except Exception as e:
                print(f"[ROUTECMP] 최단경로 비교 실패 (무시): {e}")

        prof.done(
            nodes=len(result["path_nodes"]),
            n_cand=len(response.get("candidateRoutes", [1])),
        )
        return response

    except CoverageError as e:
        # 서울 전역 그래프 밖 좌표(지방 등) — 경사도가 이 그래프 하나에 함께
        # 구워져 있어 "거리 우선만" 같은 부분 응답도 불가능하다. FE 는 code 를 보고
        # 스크리한 "경로 탐색 실패" 팝업 대신 안내 문구를 띄운다.
        raise HTTPException(
            status_code=400,
            detail={
                "code": "out_of_service_area",
                "message": "현재 서울 지역만 경로 안내를 제공합니다. 서울 안의 출발지·도착지를 선택해 주세요.",
                "debug": str(e),
            },
        )
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
    """
    if _subway_db is None:
        raise HTTPException(503, "지하철 편의시설 DB 미초기화 (subway_data 디렉토리 확인 필요)")
    if user_type not in USER_TYPES:
        raise HTTPException(400, f"유효하지 않은 user_type: {user_type}")

    result = _subway_db.get_best_exit(station, user_type, lat, lon)
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


# ── 유틸 ──────────────────────────────────────────────────────────────────────
@app.get("/user_types")
def api_user_types():
    return [{"key": k, "label": v["label"]} for k, v in USER_TYPES.items()]


@app.get("/health")
def health():
    return {"status": "ok", "nodes": G.number_of_nodes()}
