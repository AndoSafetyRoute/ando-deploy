"""
경로 탐색 — A* / Dijkstra + 우회 제한 이진탐색
"""
import networkx as nx

from config import MAX_DETOUR_RATIO, FLAT_THRESHOLD, FORBIDDEN_PENALTY
from routing.cost import USER_TYPES, slope_cost, slope_score, is_facility_blocked
from routing.graph import haversine
from routing.search import nearest_node, best_origin_node


def set_edge_weights(G: nx.DiGraph, user_type: str, alpha: float = 1.0):
    """
    유형별 slope_cost를 'weight'로 설정.
    precompute_edge_costs() 호출 후에는 선형 보간만 수행 (slope_cost 재계산 없음).
    alpha=1.0 → 경사 비용 전체 반영 / alpha=0.0 → 순수 거리

    S7 — 시설 정책(계단 차단)은 alpha와 무관하게 항상 적용한다("세 비용 함수
    (shortest/type/personal) 모두 시설 정책 적용" 요구). alpha=0(순수 거리)
    이어도 계단 통과 불가 유형에게는 큰 유한 비용을 준다 — 이 페널티는
    slope_cost 보간(w1)과 별개 축이라 보간 이후 덮어쓴다.
    """
    key = f"_w1_{user_type}"
    for u, v, data in G.edges(data=True):
        length = data["length_m"]
        w1 = data.get(key) or slope_cost(data.get("slope_pct", 0.0), user_type, length)
        weight = length + alpha * (w1 - length)
        if is_facility_blocked(user_type, data.get("highway") == "steps"):
            weight = max(weight, FORBIDDEN_PENALTY * length)
        data["weight"] = weight


def _heuristic(u, v, G: nx.DiGraph) -> float:
    n1, n2 = G.nodes[u], G.nodes[v]
    return haversine(n1["lon"], n1["lat"], n2["lon"], n2["lat"])


def _run_path(G: nx.DiGraph, origin_node, dest_node, algorithm: str):
    h = lambda u, v: _heuristic(u, v, G)
    if algorithm == "astar":
        nodes = nx.astar_path(G, origin_node, dest_node, heuristic=h, weight="weight")
    else:
        nodes = nx.dijkstra_path(G, origin_node, dest_node, weight="weight")
    cost = sum(G[u][v]["weight"] for u, v in zip(nodes, nodes[1:]))
    return nodes, cost


def recalculate_path_slopes(G: nx.DiGraph, path_nodes: list) -> list:
    """
    경로 노드 순서 기반으로 각 구간의 경사도·방향을 결정.

    엣지에 slope_pct가 이미 저장돼 있으면 그 값을 그대로 사용한다.
    (legacy: signed_slope()로 저장된 값 / densified: DEM 실측값)
    평지 판단은 % 기준(0.5%) — FLAT_THRESHOLD(미터 기준)를 5m 구간에 쓰면
    10% 미만이 전부 flat으로 분류되는 문제가 생겨서 별도 상수를 쓴다.
    """
    SLOPE_FLAT_PCT = 0.5   # % 미만이면 평지 (0.5m/100m)
    segments       = []

    for i in range(len(path_nodes) - 1):
        u, v = path_nodes[i], path_nodes[i + 1]
        if not G.has_edge(u, v):
            continue

        edge         = G[u][v]
        slope_signed = float(edge.get("slope_pct", 0.0))
        slope_abs    = abs(slope_signed)

        if slope_abs < SLOPE_FLAT_PCT:
            slope_signed, direction = 0.0, "flat"
        elif slope_signed > 0:
            direction = "up"
        else:
            direction = "down"

        g_eval = slope_abs
        d_eval = direction if direction != "flat" else "up"

        seg = {
            "u":             u,
            "v":             v,
            "length_m":      edge.get("length_m", 0.0),
            "slope_pct":     slope_signed,
            "direction":     direction,
            "name":          edge.get("name", ""),
            "score_by_type": {ut: slope_score(g_eval, d_eval, ut) for ut in USER_TYPES},
            # S3 — 신호 A 행(FE distanceRowTracker)의 facility 판정용. S6.5와
            # 동일 사실 필드(OSM 원본 highway=='steps').
            "is_stairs":     edge.get("highway") == "steps",
            # S6 — slope 0/NULL/교량 구분(graph.py 참고). 레거시 그래프 경로 등
            # 속성이 없는 엣지는 "missing"으로 보수적 처리(값을 신뢰 못 한다는
            # 뜻이지 실제로 결측이라 단정하는 건 아님 — 확인 불가 케이스).
            "slope_source":  edge.get("slope_source") or "missing",
        }
        segments.append(seg)

    return segments


def find_route(
    G:             nx.DiGraph,
    origin_lonlat: tuple,
    dest_lonlat:   tuple,
    user_type:     str,
    algorithm:     str = "auto",
    max_detour_ratio: float = MAX_DETOUR_RATIO,
    mode:          str = "accessibility",
) -> dict:
    """
    출발지 → 목적지 경로 탐색.
    mode='accessibility': 경사도 비용 + 우회 제한 이진탐색
    mode='shortest'     : 순수 거리 최단 경로
    """
    if user_type not in USER_TYPES:
        raise ValueError(f"유효하지 않은 user_type: {user_type}")

    straight_dist = haversine(*origin_lonlat, *dest_lonlat)
    if algorithm == "auto":
        algorithm = "astar" if straight_dist >= 1000 else "dijkstra"

    set_edge_weights(G, user_type, alpha=0.0)
    dest_node, dd   = nearest_node(G, *dest_lonlat)
    origin_node     = best_origin_node(G, origin_lonlat, dest_node)
    od = haversine(origin_lonlat[0], origin_lonlat[1],
                   G.nodes[origin_node]["lon"], G.nodes[origin_node]["lat"])

    print(f"[경로 탐색] 출발: {origin_node} ({od:.1f}m)  도착: {dest_node} ({dd:.1f}m)")

    try:
        shortest_nodes = nx.dijkstra_path(G, origin_node, dest_node, weight="weight")
    except nx.NetworkXNoPath:
        raise ValueError("경로를 찾을 수 없습니다.")

    shortest_dist = sum(
        G[u][v]["length_m"] for u, v in zip(shortest_nodes, shortest_nodes[1:])
    )

    if mode == "shortest":
        path_nodes = shortest_nodes
        used_alpha = 0.0
        total_cost = shortest_dist
        print(f"[최단 경로] {algorithm.upper()} 직선 {straight_dist:.0f}m / 그래프 {shortest_dist:.0f}m")

    else:
        set_edge_weights(G, user_type, alpha=1.0)
        try:
            slope_nodes, total_cost = _run_path(G, origin_node, dest_node, algorithm)
        except nx.NetworkXNoPath:
            raise ValueError("경로를 찾을 수 없습니다.")

        slope_dist = sum(
            G[u][v]["length_m"] for u, v in zip(slope_nodes, slope_nodes[1:])
        )
        detour     = slope_dist / shortest_dist if shortest_dist > 0 else 1.0
        print(f"[우회 검토] 최단 {shortest_dist:.0f}m / 경사최적 {slope_dist:.0f}m → {detour:.2f}x")

        path_nodes = slope_nodes
        used_alpha = 1.0

        if detour > max_detour_ratio:
            print(f"[우회 초과] {max_detour_ratio}x 초과 → alpha 이진탐색 시작")
            lo, hi = 0.0, 1.0
            for _ in range(8):
                mid = (lo + hi) / 2
                set_edge_weights(G, user_type, alpha=mid)
                try:
                    cand_nodes, _ = _run_path(G, origin_node, dest_node, algorithm)
                except nx.NetworkXNoPath:
                    hi = mid
                    continue
                cand_dist = sum(
                    G[u][v]["length_m"] for u, v in zip(cand_nodes, cand_nodes[1:])
                )
                if cand_dist / shortest_dist <= max_detour_ratio:
                    lo, path_nodes, used_alpha = mid, cand_nodes, mid
                else:
                    hi = mid

            actual_dist = sum(
                G[u][v]["length_m"] for u, v in zip(path_nodes, path_nodes[1:])
            )
            print(f"[이진탐색 완료] alpha={used_alpha:.3f}  실거리={actual_dist:.0f}m  ({actual_dist/shortest_dist:.2f}x)")
            set_edge_weights(G, user_type, alpha=used_alpha)
            total_cost = sum(G[u][v]["weight"] for u, v in zip(path_nodes, path_nodes[1:]))

    segments  = recalculate_path_slopes(G, path_nodes)
    total_len = sum(s["length_m"] for s in segments)
    avg_slope = (
        sum(abs(s["slope_pct"]) * s["length_m"] for s in segments) / total_len
        if total_len > 0 else 0.0
    )

    return {
        "algorithm":      algorithm,
        "origin_node":    origin_node,
        "dest_node":      dest_node,
        "path_nodes":     path_nodes,
        "segments":       segments,
        "total_length_m": total_len,
        "total_cost":     total_cost,
        "avg_slope_pct":  avg_slope,
        "user_label":     USER_TYPES[user_type]["label"],
        "used_alpha":     used_alpha,
    }
