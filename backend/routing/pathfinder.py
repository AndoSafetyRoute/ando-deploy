"""
경로 탐색 — A* / Dijkstra + 우회 제한 이진탐색
"""
import heapq
import time

import networkx as nx

from config import MAX_DETOUR_RATIO, FLAT_THRESHOLD, COVERAGE_SNAP_MAX_M, CoverageError
from routing.cost import USER_TYPES, slope_cost, slope_score
from routing.graph import haversine
from routing.search import nearest_node, best_origin_node


def set_edge_weights(G: nx.DiGraph, user_type: str, alpha: float = 1.0):
    """
    유형별 slope_cost를 'weight'로 설정.
    precompute_edge_costs() 호출 후에는 선형 보간만 수행 (slope_cost 재계산 없음).
    alpha=1.0 → 경사 비용 전체 반영 / alpha=0.0 → 순수 거리
    """
    key = f"_w1_{user_type}"
    for u, v, data in G.edges(data=True):
        length = data["length_m"]
        w1 = data.get(key) or slope_cost(data.get("slope_pct", 0.0), user_type, length)
        data["weight"] = length + alpha * (w1 - length)


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
        }
        segments.append(seg)

    return segments


def shortest_route_nx(
    G:             nx.DiGraph,
    origin_lonlat: tuple,
    dest_lonlat:   tuple,
) -> dict:
    """
    순수 거리 최단경로 — 계측용 자체 Dijkstra.

    find_route(mode='shortest') 와 결과는 같지만 두 가지가 다르다:
      1. set_edge_weights() 로 그래프 전체(서울: 엣지 350만개)를 매번 다시 쓰지
         않는다 — length_m 를 가중치로 직접 읽는다. (그 3~8초짜리 그래프 mutation
         은 이 코드베이스 특성이지 최단경로 알고리즘 비용이 아니므로 비교에서 제외)
      2. 탐색 자원량을 센다: settled 노드 수, relax(엣지 완화) 횟수, heap push 수,
         peak heap 크기. CCH 쿼리(수백 노드 방문)와 대비하기 위한 값.

    반환 dict: path_nodes / segments / total_length_m / avg_slope_pct + 계측값.
    """
    dest_node, dd = nearest_node(G, *dest_lonlat)
    origin_node   = best_origin_node(G, origin_lonlat, dest_node)
    od = haversine(origin_lonlat[0], origin_lonlat[1],
                   G.nodes[origin_node]["lon"], G.nodes[origin_node]["lat"])
    if od > COVERAGE_SNAP_MAX_M or dd > COVERAGE_SNAP_MAX_M:
        raise CoverageError(
            f"서비스 커버리지 밖입니다 (출발 스냅 {od:.0f}m / 도착 스냅 {dd:.0f}m, "
            f"허용 {COVERAGE_SNAP_MAX_M:.0f}m)"
        )

    if origin_node == dest_node:
        raise ValueError("출발지와 목적지가 동일한 노드입니다.")

    t0 = time.perf_counter()
    dist  = {origin_node: 0.0}
    prev  = {}
    done  = set()
    pq    = [(0.0, origin_node)]
    n_settled = n_relax = n_push = 0
    peak_heap = 1

    while pq:
        d, u = heapq.heappop(pq)
        if u in done:
            continue
        done.add(u)
        n_settled += 1
        if u == dest_node:
            break
        for v, edata in G[u].items():
            n_relax += 1
            w  = edata.get("length_m", 1.0)
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
                n_push += 1
                if len(pq) > peak_heap:
                    peak_heap = len(pq)

    query_ms = (time.perf_counter() - t0) * 1000.0

    if dest_node not in prev:
        raise ValueError("경로를 찾을 수 없습니다.")

    path_nodes = [dest_node]
    while path_nodes[-1] != origin_node:
        path_nodes.append(prev[path_nodes[-1]])
    path_nodes.reverse()

    segments  = recalculate_path_slopes(G, path_nodes)
    total_len = sum(s["length_m"] for s in segments)
    avg_slope = (
        sum(abs(s["slope_pct"]) * s["length_m"] for s in segments) / total_len
        if total_len > 0 else 0.0
    )

    print(f"[NX] 순수최단 완료 {query_ms/1000:.3f}s  "
          f"settled={n_settled:,}  relax={n_relax:,}  노드={len(path_nodes)}")

    return {
        "algorithm":      "nx-dijkstra-shortest",
        "origin_node":    origin_node,
        "dest_node":      dest_node,
        "path_nodes":     path_nodes,
        "segments":       segments,
        "total_length_m": total_len,
        "total_cost":     total_len,
        "avg_slope_pct":  avg_slope,
        "user_label":     "최단거리(NetworkX)",
        "used_alpha":     0.0,
        # ── 계측 ──
        "query_ms":         round(query_ms, 3),
        "nodes_settled":    n_settled,
        "edges_relaxed":    n_relax,
        "heap_pushes":      n_push,
        "peak_heap":        peak_heap,
        "graph_nodes":      G.number_of_nodes(),
        "path_node_count":  len(path_nodes),
    }


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

    # 좌표가 현재 로드된 그래프 범위 밖이면(예: 용산구 전용 그래프에 강남역 좌표)
    # od/dd가 몇 km씩 튄다 — 검증 없이 그대로 진행하면 엉뚱한 두 지점 사이 경로가
    # 계산되고, 그 위에 경사 페널티까지 얹혀 소요시간이 "몇 시간"으로 부풀려진다.
    if od > COVERAGE_SNAP_MAX_M or dd > COVERAGE_SNAP_MAX_M:
        raise CoverageError(
            f"서비스 커버리지 밖입니다 (출발 스냅 {od:.0f}m / 도착 스냅 {dd:.0f}m, "
            f"허용 {COVERAGE_SNAP_MAX_M:.0f}m)"
        )

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
