"""
그래프 노드 탐색 — 좌표 기반 최근접 노드 및 출발 노드 선택
"""
import networkx as nx
import numpy as np

from routing.graph import haversine

# ── KD-tree 공간 인덱스 ────────────────────────────────────────────────────────
# build_spatial_index(G) 호출 시 생성, enrich_segments_with_slope에서 사용

class SpatialIndex:
    """그래프 노드를 KD-tree로 색인 — nearest node 조회를 O(N) → O(log N)으로 단축"""
    def __init__(self, G: nx.DiGraph):
        from scipy.spatial import KDTree
        self.nodes  = list(G.nodes())
        coords      = [(G.nodes[n]["lon"], G.nodes[n]["lat"]) for n in self.nodes]
        self._tree  = KDTree(np.array(coords))

    def nearest(self, lon: float, lat: float) -> tuple:
        """(node, dist_m) 반환"""
        dist_deg, idx = self._tree.query([lon, lat])
        node = self.nodes[idx]
        # 각도 거리 → 미터 근사 변환 (위도 1도 ≈ 111_000m)
        dist_m = dist_deg * 111_000
        return node, dist_m


def build_spatial_index(G: nx.DiGraph) -> SpatialIndex:
    return SpatialIndex(G)


def nearest_node(G: nx.DiGraph, lon: float, lat: float) -> tuple:
    best_node, best_dist = None, float("inf")
    for node, data in G.nodes(data=True):
        d = haversine(lon, lat, data["lon"], data["lat"])
        if d < best_dist:
            best_dist, best_node = d, node
    return best_node, best_dist


def nearest_nodes_k(G: nx.DiGraph, lon: float, lat: float, k: int = 10) -> list:
    nodes_with_dist = [
        (n, haversine(lon, lat, data["lon"], data["lat"]))
        for n, data in G.nodes(data=True)
    ]
    nodes_with_dist.sort(key=lambda x: x[1])
    return nodes_with_dist[:k]


def best_origin_node(
    G:                nx.DiGraph,
    origin_lonlat:    tuple,
    dest_node,
    k:                int   = 10,
    geo_limit_factor: float = 3.0,
    geo_limit_abs_m:  float = 200.0,
):
    """
    출발 위치 근처 상위 k개 후보 중, 목적지까지 직선거리가 가장 짧은 노드 반환.
    Dijkstra 대신 직선거리 추정으로 O(k) 처리 — 정밀도 차이 미미, 속도 대폭 향상.
    """
    origin_cands = nearest_nodes_k(G, *origin_lonlat, k)
    nearest_geo  = origin_cands[0][1]
    geo_limit    = max(nearest_geo * geo_limit_factor, geo_limit_abs_m)
    valid_cands  = [(n, d) for n, d in origin_cands if d <= geo_limit]

    dest_data = G.nodes[dest_node]
    best_node = min(
        valid_cands,
        key=lambda x: haversine(
            G.nodes[x[0]]["lon"], G.nodes[x[0]]["lat"],
            dest_data["lon"],     dest_data["lat"],
        ),
    )[0]
    return best_node
