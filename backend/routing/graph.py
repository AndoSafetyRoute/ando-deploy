"""
GeoJSON → NetworkX DiGraph 구성 및 연결 성분 처리
"""
import json
import math
import os
import pickle
import warnings
import networkx as nx

from config import FLAT_THRESHOLD, STDDEV_THRESHOLD, BRIDGE_GAP_M, SNAP_TOL_M


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
        # 구조물 태그 통과 — Phase 2-a(교량·터널 DEM 보정)에서 세그먼트 식별에 필요.
        # densify_slope.py 가 이미 전 feature 에 layer/bridge/tunnel 을 실어 보낸다.
        layer          = props.get("layer", 0)
        bridge         = props.get("bridge", "F")
        tunnel         = props.get("tunnel", "F")

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
            layer=layer, bridge=bridge, tunnel=tunnel,
        )
        rev = dict(fwd,
            slope_pct=-slope_pct,
            elevation_start=elevation_end,
            elevation_end=elevation_start,
        )
        G.add_edge(u, v, **fwd)
        G.add_edge(v, u, **rev)

    print(f"[그래프 구성·densified] 노드: {G.number_of_nodes():,}  엣지: {G.number_of_edges():,}")
    _snap_nearby_nodes(G, SNAP_TOL_M)
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

def _incident_layers(G: nx.DiGraph, nd) -> set:
    """nd 에 붙은 실제(원본 OSM) 엣지들의 layer 집합. 없으면 {0}(지상 가정).

    snap/bridge 로 나중에 추가된 인공 엣지(항상 layer=0)는 제외한다 — 안 그러면
    한 번 잘못 이어진 연결이 layer 집합을 오염시켜 다음 후보 판정에도 번진다.

    primary/secondary 도입 후 고가/지하(layer≠0) 구간이 늘면서, 평면좌표만 보는
    snap/bridge 가 고가차도와 그 아래 지상도로를 잘못 이어버리는 사례가 실측
    8,229건 확인됨(스캔 스크립트, SNAP_TOL_M=5m 기준) — 이 함수로 방지한다.
    """
    layers = {a.get("layer", 0) for _, _, a in G.out_edges(nd, data=True)
            if a.get("highway") not in ("snap", "bridge")}
    return layers or {0}


def _snap_nearby_nodes(G: nx.DiGraph, tol_m: float) -> int:
    """tol_m 이내인데 엣지로 이어지지 않은 노드쌍에 짧은 보행 링크를 추가한다.

    densify 이전 원본 OSM 의 노딩 틈(끝점이 미세하게 어긋나 노드를 공유하지 못하는
    경우)을 메운다. 서울역 광장처럼 실제로는 이어진 보행로가 그래프상 수 km 떨어지는
    문제(backend/README §104)를 해소. slope_pct 크기는 양 끝에 붙은 실제 엣지에서
    상속하고(5m 링크에 DEM 직접 계산 금지 — densify 의 <2m 처리와 같은 원칙), 부호만
    양 끝 노드 elevation 차이로 정한다.

    _connect_components(50m 브리지) 앞단에서 돌린다 — 5m 급 실제 틈을 먼저 없애면
    이후 브리지가 억지로 이을 대상이 크게 준다.

    링크에 `highway="snap"`, `snap=True` 표식 — 인공 브리지(`highway="bridge"`)와 달리
    실재 연결의 복원이므로 비용 페널티를 주지 않는다(cost.py 는 highway 를 안 봄).
    """
    if tol_m <= 0:
        return 0
    try:
        from scipy.spatial import KDTree
        import numpy as np
    except ImportError:
        print("[snap] scipy 없음 → snap 패스 건너뜀")
        return 0

    nodes = list(G.nodes)
    n = len(nodes)
    if n < 2:
        return 0

    mean_lat = sum(G.nodes[nd]["lat"] for nd in nodes) / n
    lat_to_m = 111_320.0
    lon_to_m = 111_320.0 * math.cos(math.radians(mean_lat))
    coords_m = np.empty((n, 2), dtype=np.float64)
    for i, nd in enumerate(nodes):
        coords_m[i, 0] = G.nodes[nd]["lon"] * lon_to_m
        coords_m[i, 1] = G.nodes[nd]["lat"] * lat_to_m

    def _incident_slope_mag(nd):
        """nd 에 붙은 실제(비-snap) 엣지들의 slope_abs 평균. 없으면 None."""
        vals = [a.get("slope_abs", abs(a.get("slope_pct", 0.0)))
                for _, _, a in G.out_edges(nd, data=True)
                if not a.get("snap")]
        return sum(vals) / len(vals) if vals else None

    tree = KDTree(coords_m)
    added = 0
    for i, j in tree.query_pairs(tol_m):
        u, v = nodes[i], nodes[j]
        if u == v or G.has_edge(u, v):
            continue
        ud, vd = G.nodes[u], G.nodes[v]
        d = haversine(ud["lon"], ud["lat"], vd["lon"], vd["lat"])
        if d < 0.2:               # 사실상 동일 노드 (round 6dp 잔차) — 스킵
            continue
        if not (_incident_layers(G, u) & _incident_layers(G, v)):
            continue               # 고가/지하 등 실제 layer 가 겹치지 않음 — 오연결 방지
        eu = ud.get("elevation", 0.0) or 0.0
        ev = vd.get("elevation", 0.0) or 0.0
        # slope 크기는 인접 실제 엣지에서 상속한다. 5m 링크에 DEM 을 직접 계산하면
        # 오차 0.24m/5m ≈ 5% 로 수동휠체어 금지 임계에 걸려, 방금 복원한 연결이
        # 다시 막힌다(densify 의 <2m 처리와 같은 원칙). 부호만 elevation 으로.
        mags = [m for m in (_incident_slope_mag(u), _incident_slope_mag(v))
                if m is not None]
        mag = round(sum(mags) / len(mags), 3) if mags else 0.0
        sp = mag if (ev - eu) >= 0 else -mag
        base = dict(length_m=round(d, 2), slope_abs=mag,
                    highway="snap", name="", snap=True,
                    layer=0, bridge="F", tunnel="F")
        G.add_edge(u, v, slope_pct=sp,
                   elevation_start=eu, elevation_end=ev, **base)
        G.add_edge(v, u, slope_pct=-sp,
                   elevation_start=ev, elevation_end=eu, **base)
        added += 1

    print(f"[snap] {tol_m:.0f}m 이내 미연결쌍 → 보행 링크 {added:,}개 추가 "
          f"(노드 {n:,})")
    return added


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
                u_layers = _incident_layers(G, u)
                for vidx in tree.query_ball_point(coords_m[u_idx], r=search_r):
                    v = node_list[vidx]
                    if v not in main_set or v == u:
                        continue
                    if not (u_layers & _incident_layers(G, v)):
                        continue   # 고가/지하 등 실제 layer 가 겹치지 않음 — 오연결 방지
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
                u_layers = _incident_layers(G, u)
                for v in main_list:
                    if not (u_layers & _incident_layers(G, v)):
                        continue   # 고가/지하 등 실제 layer 가 겹치지 않음 — 오연결 방지
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
                      highway="bridge", name="",
                      layer=0, bridge="F", tunnel="F")
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
