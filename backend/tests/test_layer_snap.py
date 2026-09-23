"""layer 무시 스냅/브리지 버그 수정에 대한 순수-로직 유닛 테스트.

무거운 실그래프(2M+ 엣지) 없이 합성 소규모 그래프로 돈다 — 메모리 사실상 0.
routing.graph._incident_layers / _snap_nearby_nodes / _connect_components 를
직접 호출해 "layer 가 다르면 안 이어진다" / "layer 가 같으면 여전히 이어진다"
두 축을 모두 확인한다.

실행:  python tests\test_layer_snap.py
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import networkx as nx

from routing.graph import _incident_layers, _snap_nearby_nodes, _connect_components

SEOUL_LAT = 37.55
LAT_TO_M = 111_320.0
LON_TO_M = 111_320.0 * math.cos(math.radians(SEOUL_LAT))


def _offset_node(lat0, lon0, dx_m, dy_m):
    return (lat0 + dy_m / LAT_TO_M, lon0 + dx_m / LON_TO_M)


def _add_node(G, nid, lat, lon, elevation=0.0):
    G.add_node(nid, lat=lat, lon=lon, elevation=elevation)


def _add_real_edge(G, u, v, layer=0, length_m=10.0):
    base = dict(length_m=length_m, slope_pct=0.0, slope_abs=0.0,
                elevation_start=0.0, elevation_end=0.0,
                highway="footway", name="", layer=layer,
                bridge="T" if layer else "F", tunnel="F")
    G.add_edge(u, v, **base)
    G.add_edge(v, u, **base)


failures = []


def check(name, cond):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}")
    if not cond:
        failures.append(name)


# ─────────────────────────────────────────────────────────────────────────
# 1. _incident_layers 단위 테스트
# ─────────────────────────────────────────────────────────────────────────
G1 = nx.DiGraph()
lat0, lon0 = 37.55, 127.0
_add_node(G1, "ground_a", *_offset_node(lat0, lon0, 0, 0))
_add_node(G1, "ground_b", *_offset_node(lat0, lon0, 10, 0))
_add_real_edge(G1, "ground_a", "ground_b", layer=0)

_add_node(G1, "elev_a", *_offset_node(lat0, lon0, 0, 20))
_add_node(G1, "elev_b", *_offset_node(lat0, lon0, 10, 20))
_add_real_edge(G1, "elev_a", "elev_b", layer=1)

_add_node(G1, "orphan", *_offset_node(lat0, lon0, 0, 40))  # 실제 엣지 없음

check("layer=0 실제 엣지만 있는 노드 → {0}",
      _incident_layers(G1, "ground_a") == {0})
check("layer=1 실제 엣지만 있는 노드 → {1}",
      _incident_layers(G1, "elev_a") == {1})
check("실제 엣지가 없는 노드 → 기본값 {0}",
      _incident_layers(G1, "orphan") == {0})

# snap/bridge 인공 엣지만 있는 경우 → 여전히 기본값 {0} (실제 엣지로 안 침)
G1.add_edge("orphan", "ground_a", length_m=5.0, slope_pct=0.0, slope_abs=0.0,
            highway="snap", name="", snap=True, layer=0, bridge="F", tunnel="F")
check("snap 엣지만 있는 노드는 실제 layer 로 안 침(기본값 {0} 유지)",
      _incident_layers(G1, "orphan") == {0})


# ─────────────────────────────────────────────────────────────────────────
# 2. _snap_nearby_nodes 통합 테스트
# ─────────────────────────────────────────────────────────────────────────
def build_snap_case():
    G = nx.DiGraph()
    lat0, lon0 = 37.55, 127.02

    # 지상(layer0) 경로: A0-A1
    _add_node(G, "A0", *_offset_node(lat0, lon0, 0, 0))
    _add_node(G, "A1", *_offset_node(lat0, lon0, 10, 0))
    _add_real_edge(G, "A0", "A1", layer=0)

    # 고가(layer1) 경로: B0-B1. B0 는 A0 에서 3m (tol_m=5 이내, densify 노딩 틈처럼)
    _add_node(G, "B0", *_offset_node(lat0, lon0, 3, 0))
    _add_node(G, "B1", *_offset_node(lat0, lon0, 13, 0))
    _add_real_edge(G, "B0", "B1", layer=1)

    # 대조군: 지상(layer0) 경로 C0-C1, D0-D1 도 지상, 3m 이내 → 이건 이어져야 정상
    _add_node(G, "C0", *_offset_node(lat0, lon0, 0, 50))
    _add_node(G, "C1", *_offset_node(lat0, lon0, 10, 50))
    _add_real_edge(G, "C0", "C1", layer=0)

    _add_node(G, "D0", *_offset_node(lat0, lon0, 3, 50))
    _add_node(G, "D1", *_offset_node(lat0, lon0, 13, 50))
    _add_real_edge(G, "D0", "D1", layer=0)

    # fallback: 실제 엣지 없는 고립 노드 E 가 지상(layer0) F0 근처 → 이어져야 정상
    _add_node(G, "F0", *_offset_node(lat0, lon0, 0, 100))
    _add_node(G, "F1", *_offset_node(lat0, lon0, 10, 100))
    _add_real_edge(G, "F0", "F1", layer=0)
    _add_node(G, "E", *_offset_node(lat0, lon0, 3, 100))

    return G


Gsnap = build_snap_case()
_snap_nearby_nodes(Gsnap, tol_m=5.0)

check("layer 다른 A0↔B0 (고가/지상, 3m) → snap 안 됨",
      not Gsnap.has_edge("A0", "B0"))
check("layer 같은 C0↔D0 (지상/지상, 3m) → snap 됨 (정상 케이스 회귀 없음)",
      Gsnap.has_edge("C0", "D0") and Gsnap["C0"]["D0"].get("snap"))
check("실제 엣지 없는 고립노드 E ↔ 지상 F0 (3m) → fallback 으로 snap 됨",
      Gsnap.has_edge("E", "F0") and Gsnap["E"]["F0"].get("snap"))


# ─────────────────────────────────────────────────────────────────────────
# 3. _connect_components 통합 테스트 (50m 브리지)
# ─────────────────────────────────────────────────────────────────────────
def build_bridge_case():
    G = nx.DiGraph()
    lat0, lon0 = 37.55, 127.05

    # 메인 성분(지상, layer0): M0-M1-M2 체인 (커야 comps[0] 이 됨)
    _add_node(G, "M0", *_offset_node(lat0, lon0, 0, 0))
    _add_node(G, "M1", *_offset_node(lat0, lon0, 10, 0))
    _add_node(G, "M2", *_offset_node(lat0, lon0, 20, 0))
    _add_real_edge(G, "M0", "M1", layer=0)
    _add_real_edge(G, "M1", "M2", layer=0)

    # 소성분 1: 고가(layer1) 파편, M0 에서 20m (bridge_gap_m=50 이내) → 이어지면 안 됨
    _add_node(G, "S0", *_offset_node(lat0, lon0, 20, 0))
    _add_node(G, "S1", *_offset_node(lat0, lon0, 30, 0))
    _add_real_edge(G, "S0", "S1", layer=1)

    # 소성분 2: 지상(layer0) 파편, M2 에서 20m 이내 → 정상적으로 이어져야 함
    _add_node(G, "T0", *_offset_node(lat0, lon0, 40, 0))
    _add_node(G, "T1", *_offset_node(lat0, lon0, 50, 0))
    _add_real_edge(G, "T0", "T1", layer=0)

    return G


Gbridge = build_bridge_case()
n_comps_before = nx.number_weakly_connected_components(Gbridge)
G_out = _connect_components(Gbridge, bridge_gap_m=50.0)

check("브리지 전 3개 성분(메인/고가파편/지상파편)",
      n_comps_before == 3)
check("layer 다른 고가 파편(S0,S1)은 안 이어지고 LCC 에서 제외됨",
      "S0" not in G_out.nodes and "S1" not in G_out.nodes)
check("layer 같은 지상 파편(T0,T1)은 정상적으로 브리지되어 포함됨",
      "T0" in G_out.nodes and "T1" in G_out.nodes)
check("메인 성분 노드는 그대로 유지",
      {"M0", "M1", "M2"} <= set(G_out.nodes))


# ─────────────────────────────────────────────────────────────────────────
print()
if failures:
    print(f"FAIL: {len(failures)}건 실패 → {failures}")
    sys.exit(1)
else:
    print("모든 테스트 통과")
    sys.exit(0)
