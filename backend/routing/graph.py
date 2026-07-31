"""
GeoJSON → NetworkX DiGraph 구성 및 연결 성분 처리
"""
import json
import math
import os
import pickle
import warnings
import networkx as nx

from config import FLAT_THRESHOLD, STDDEV_THRESHOLD, BRIDGE_GAP_M


def haversine(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def get_representative_slope(props: dict) -> float:
    """slope1_stddev 기준으로 mean 또는 max 선택."""
    stddev = props.get("slope1_stddev") or 0.0
    mean   = props.get("slope1_mean")   or 0.0
    maxv   = props.get("slope1_max")    or 0.0
    return abs(mean) if stddev <= STDDEV_THRESHOLD else abs(maxv)


def signed_slope(slope_abs: float, elev_start: float, elev_end: float) -> float:
    """고도 차이로 오르막/내리막 판단 후 부호 적용."""
    diff = elev_end - elev_start
    if abs(diff) < FLAT_THRESHOLD:
        return 0.0
    return slope_abs if diff > 0 else -slope_abs


def interpolate_elevations(line_coords: list, e_min: float, e_max: float) -> list:
    """
    좌표 순서에 따라 e_min → e_max 누적 거리 비례 선형 보간.
    feature 내 모든 노드가 동일 elevation을 갖는 문제를 해결해
    signed_slope()가 항상 0을 반환하던 버그를 수정한다.
    """
    distances = [0.0]
    for i in range(1, len(line_coords)):
        lon1, lat1 = line_coords[i-1][0], line_coords[i-1][1]
        lon2, lat2 = line_coords[i][0],   line_coords[i][1]
        distances.append(distances[-1] + haversine(lon1, lat1, lon2, lat2))
    total = distances[-1]
    return [
        e_min + (e_max - e_min) * (d / total if total > 0 else 0.0)
        for d in distances
    ]


def _is_densified(data: dict) -> bool:
    """road_5m_slope.geojson(densify_slope.py 출력) 여부 판별."""
    feats = data.get("features", [])
    if not feats:
        return False
    return "slope_pct" in (feats[0].get("properties") or {})


def build_graph(geojson_path: str) -> nx.DiGraph:
    """
    GeoJSON → NetworkX DiGraph.
    같은 경로에 .pkl 캐시가 있고 GeoJSON보다 새 것이면 pickle에서 로딩
    (최초 빌드만 느리고, 이후 재시작은 수 초 내로 완료).
    """
    pkl_path = os.path.splitext(geojson_path)[0] + ".pkl"

    if os.path.exists(pkl_path):
        geojson_mtime = os.path.getmtime(geojson_path)
        pkl_mtime     = os.path.getmtime(pkl_path)
        if pkl_mtime > geojson_mtime:
            print(f"[그래프 구성] pickle 캐시 로딩: {pkl_path}")
            with open(pkl_path, "rb") as f:
                G = pickle.load(f)
            print(f"[그래프 구성] 노드: {G.number_of_nodes():,}  엣지: {G.number_of_edges():,}")
            return G

    with open(geojson_path, encoding="utf-8") as f:
        data = json.load(f)

    G = _build_graph_densified(data) if _is_densified(data) else _build_graph_legacy(data)

    with open(pkl_path, "wb") as f:
        pickle.dump(G, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"[그래프 구성] pickle 저장: {pkl_path}")
    return G


def _build_graph_densified(data: dict) -> nx.DiGraph:
    """
    densify_slope.py 출력 포맷 (5m 단위, slope_pct 직접 포함).
    slope_pct: 부호 있음 (+ 오르막 / - 내리막), DEM 실측값.
    """
    G = nx.DiGraph()

    def to_node(lon, lat):
        return (round(lon, 6), round(lat, 6))

    for feat in data["features"]:
        props   = feat["properties"]
        coords  = feat["geometry"]["coordinates"]   # [[lon1,lat1],[lon2,lat2]]
        if len(coords) < 2:
            continue

        lon1, lat1 = coords[0][0],  coords[0][1]
        lon2, lat2 = coords[-1][0], coords[-1][1]
        u, v = to_node(lon1, lat1), to_node(lon2, lat2)
        if u == v:
            continue

        length_m       = props.get("length_m") or haversine(lon1, lat1, lon2, lat2)
        slope_pct      = float(props.get("slope_pct", 0.0))
        elevation_start = float(props.get("elevation_start", 0.0))
        elevation_end   = float(props.get("elevation_end",   0.0))
        highway        = props.get("highway") or ""
        name           = props.get("name") or ""

        if u not in G:
            G.add_node(u, lon=lon1, lat=lat1, elevation=elevation_start)
        if v not in G:
            G.add_node(v, lon=lon2, lat=lat2, elevation=elevation_end)

        slope_abs = abs(slope_pct)
        fwd = dict(
            length_m=length_m,
            slope_abs=slope_abs,
            slope_pct=slope_pct,
            elevation_start=elevation_start,
            elevation_end=elevation_end,
            highway=highway, name=name,
        )
        rev = dict(fwd,
            slope_pct=-slope_pct,
            elevation_start=elevation_end,
            elevation_end=elevation_start,
        )
        G.add_edge(u, v, **fwd)
        G.add_edge(v, u, **rev)

    print(f"[그래프 구성·densified] 노드: {G.number_of_nodes():,}  엣지: {G.number_of_edges():,}")
    return _connect_components(G, BRIDGE_GAP_M)


def _build_graph_legacy(data: dict) -> nx.DiGraph:
    """기존 elevationcostroad.geojson 포맷 (OSM feature 단위, slope1_* 집계값).

    DEPRECATED: slope_pct 단위(도→% 혼용 버그) + 5m 미밀집화 구조.
    densify_slope.py 로 재생성한 road_5m_slope.geojson 사용 권장.
    """
    warnings.warn(
        "레거시 그래프 포맷(elevationcostroad.geojson) 사용 중.\n"
        "  slope1_* 값이 도(degree) 단위로 저장돼 percent 혼용 오류 있음.\n"
        "  data/road_5m_slope.geojson 으로 전환하세요.",
        DeprecationWarning,
        stacklevel=3,
    )
    G = nx.DiGraph()

    def to_node(lon, lat):
        return (round(lon, 6), round(lat, 6))

    for feat in data["features"]:
        props     = feat["properties"]
        e_min     = props.get("elevation1_min") or 0.0
        e_max     = props.get("elevation1_max") or 0.0
        slope_abs = get_representative_slope(props)
        highway   = props.get("highway") or ""
        name      = props.get("name") or props.get("name:ko") or ""

        geom      = feat["geometry"]
        all_lines = (
            geom["coordinates"] if geom["type"] == "MultiLineString"
            else [geom["coordinates"]]
        )

        for line_coords in all_lines:
            if len(line_coords) < 2:
                continue

            elevations = interpolate_elevations(line_coords, e_min, e_max)

            for i in range(len(line_coords) - 1):
                lon1, lat1 = line_coords[i][0],     line_coords[i][1]
                lon2, lat2 = line_coords[i + 1][0], line_coords[i + 1][1]
                u, v = to_node(lon1, lat1), to_node(lon2, lat2)
                if u == v:
                    continue

                length_m = haversine(lon1, lat1, lon2, lat2)

                if u not in G:
                    G.add_node(u, lon=lon1, lat=lat1, elevation=elevations[i])
                if v not in G:
                    G.add_node(v, lon=lon2, lat=lat2, elevation=elevations[i + 1])

                e_u = G.nodes[u]["elevation"]
                e_v = G.nodes[v]["elevation"]

                fwd = dict(
                    length_m=length_m,
                    slope_abs=slope_abs,
                    slope_pct=signed_slope(slope_abs, e_u, e_v),
                    elevation_start=e_u, elevation_end=e_v,
                    highway=highway, name=name,
                )
                rev = dict(fwd,
                    slope_pct=signed_slope(slope_abs, e_v, e_u),
                    elevation_start=e_v, elevation_end=e_u,
                )
                G.add_edge(u, v, **fwd)
                G.add_edge(v, u, **rev)

    print(f"[그래프 구성·legacy] 노드: {G.number_of_nodes():,}  엣지: {G.number_of_edges():,}")
    return _connect_components(G, BRIDGE_GAP_M)


def _connect_components(G: nx.DiGraph, bridge_gap_m: float) -> nx.DiGraph:
    import time

    comps = sorted(nx.weakly_connected_components(G), key=len, reverse=True)
    n_comps = len(comps)
    print(f"[연결 성분] 총 {n_comps}개  최대 성분 {len(comps[0]):,}노드")
    if n_comps == 1:
        return G

    # ── KDTree 기반 bridge 탐색 ───────────────────────────────────────────────
    try:
        from scipy.spatial import KDTree
        import numpy as np
        _use_kdtree = True
    except ImportError:
        _use_kdtree = False
        print("[Bridge] scipy 없음 → brute-force 모드 (성능 저하 가능)")

    node_list   = list(G.nodes)
    n_total     = len(node_list)
    node_to_idx = {n: i for i, n in enumerate(node_list)}

    if _use_kdtree:
        # 경도·위도 → 미터 근사 (서울 기준, 오차 < 0.1%)
        step = max(1, n_total // 2_000)
        mean_lat = sum(G.nodes[n]["lat"] for n in node_list[::step]) / max(1, n_total // step)
        lat_to_m = 111_320.0
        lon_to_m = 111_320.0 * math.cos(math.radians(mean_lat))

        coords_m = np.empty((n_total, 2), dtype=np.float64)
        for i, n in enumerate(node_list):
            coords_m[i, 0] = G.nodes[n]["lon"] * lon_to_m
            coords_m[i, 1] = G.nodes[n]["lat"] * lat_to_m

        print(f"[Bridge] KDTree 구축 중... ({n_total:,}노드)")
        t_build = time.time()
        tree = KDTree(coords_m)
        print(f"[Bridge] KDTree 완료 ({time.time() - t_build:.1f}s)")

        search_r = bridge_gap_m * 1.05  # 미터 근사 오차 5% 보정

    main_set      = set(comps[0])
    bridge_count  = 0
    isolated_count = 0
    t0 = time.time()

    for i, small in enumerate(comps[1:], 1):
        if i % 1_000 == 0:
            elapsed = time.time() - t0
            eta     = elapsed / i * (n_comps - 1 - i) if i > 0 else 0
            print(f"  [Bridge] {i:,}/{n_comps - 1:,}  "
                  f"연결={bridge_count}  미연결={isolated_count}  "
                  f"경과={elapsed:.0f}s  ETA={eta:.0f}s")

        small_list = list(small)
        # 성분이 크면 앞·뒤 일부만 샘플 (소규모 성분이 대부분이라 영향 미미)
        sample = small_list if len(small_list) <= 20 else small_list[:10] + small_list[-10:]

        best_dist, best_u, best_v = float("inf"), None, None

        if _use_kdtree:
            for u in sample:
                u_idx = node_to_idx[u]
                for vidx in tree.query_ball_point(coords_m[u_idx], r=search_r):
                    v = node_list[vidx]
                    if v not in main_set or v == u:
                        continue
                    ud, vd = G.nodes[u], G.nodes[v]
                    d = haversine(ud["lon"], ud["lat"], vd["lon"], vd["lat"])
                    if d < best_dist:
                        best_dist, best_u, best_v = d, u, v
                if best_dist <= bridge_gap_m:
                    break
        else:
            # brute-force fallback
            main_list = list(main_set)
            for u in small_list:
                ud = G.nodes[u]
                for v in main_list:
                    vd = G.nodes[v]
                    d  = haversine(ud["lon"], ud["lat"], vd["lon"], vd["lat"])
                    if d < best_dist:
                        best_dist, best_u, best_v = d, u, v
                if best_dist <= bridge_gap_m:
                    break

        if best_dist <= bridge_gap_m:
            eu = G.nodes[best_u].get("elevation", 0.0)
            ev = G.nodes[best_v].get("elevation", 0.0)
            bd = dict(length_m=best_dist, slope_pct=0.0, slope_abs=0.0,
                      elevation_start=eu, elevation_end=ev,
                      highway="bridge", name="")
            G.add_edge(best_u, best_v, **bd)
            G.add_edge(best_v, best_u, **dict(bd, elevation_start=ev, elevation_end=eu))
            main_set.update(small_list)
            bridge_count += 1
        else:
            isolated_count += 1

    elapsed_total = time.time() - t0
    print(f"[Bridge 연결] {bridge_count}개 성분 연결  "
          f"{isolated_count}개 고립({bridge_gap_m:.0f}m 초과)  {elapsed_total:.0f}s")

    lcc   = max(nx.weakly_connected_components(G), key=len)
    G_lcc = G.subgraph(lcc).copy()
    removed = G.number_of_nodes() - G_lcc.number_of_nodes()
    if removed:
        print(f"[LCC 추출] {removed}개 노드 제거 → 최종 {G_lcc.number_of_nodes():,}개 노드")
    return G_lcc
