"""
CCH raw edge 기반 소요시간 측정 단위(Measurement Unit) 분할

build_navigation_segments(routing/segments.py)는 교차로(out_degree > 2) 기준으로
묶어 "지도 표시·음성안내"용 구간을 만든다. 이 모듈은 목적이 다르다 — GPS 실측
소요시간(navigation_measurements) 판정 단위를 만드는 것으로, 교차로 위치와는
무관하게 오직 누적 거리만 기준으로 묶는다.

설계 원칙:
  - CCH raw edge(5~10m)는 GPS 통과판정 반경(15m)보다 작아 그 자체로는 판정이
    불안정하다 — 엣지를 누적 거리 min_distance_m(기본 30m) 이상이 될 때까지
    순서대로 묶어야 "이 unit을 지났다"는 판정이 GPS 오차보다 확실히 커진다.
  - slope_pct는 묶인 raw edge들의 **거리가중평균** — 짧은 엣지 하나의 극단적인
    경사가 unit 전체를 왜곡하지 않게 한다.
  - 마지막 조각이 min_distance_m 미만으로 남으면 직전 unit에 흡수한다
    (build_navigation_segments의 "짧은 구간은 이전 구간에 흡수" 원칙과 동일).
"""
from dataclasses import dataclass, field


@dataclass
class MeasurementUnit:
    unit_index:         int
    start_node:          tuple
    end_node:            tuple
    intermediate_nodes:  list = field(default_factory=list)
    distance_m:          float = 0.0
    slope_pct:           float = 0.0

    def all_nodes(self) -> list:
        return [self.start_node] + self.intermediate_nodes + [self.end_node]


def build_measurement_units(
    G,
    path_nodes: list,
    min_distance_m: float = 30.0,
) -> list[MeasurementUnit]:
    """
    path_nodes (CCH/NetworkX 경로 노드 시퀀스) → MeasurementUnit 목록.

    알고리즘:
      1. raw edge를 순서대로 누적하다가 누적 거리가 min_distance_m 이상이 되는
         순간 그 자리에서 unit을 하나 끊는다.
      2. 경로 끝에 min_distance_m 미만으로 남은 마지막 조각은 단독 unit으로 두지
         않고 직전 unit에 흡수한다(직전 unit이 없으면 — 경로 전체가 30m 미만이면
         — 그 자체로 유일한 unit이 된다).

    build_navigation_segments와 달리 교차로 분할·zone 완충(hysteresis)이 없다 —
    이 unit은 오직 "GPS로 통과 여부를 안정적으로 판정할 수 있는 최소 거리 단위"만
    의미한다.
    """
    if len(path_nodes) < 2:
        return []

    # ── 1. 누적 거리 기준 분할 ────────────────────────────────────────────────
    # chunks[i] = (nodes, distance_m, weighted_slope_sum)
    chunks: list[tuple[list, float, float]] = []
    cur_nodes = [path_nodes[0]]
    cur_dist  = 0.0
    cur_wsum  = 0.0   # Σ(slope_pct * length_m) — 거리가중평균의 분자

    for u, v in zip(path_nodes, path_nodes[1:]):
        cur_nodes.append(v)
        if G.has_edge(u, v):
            d = G[u][v]
            length = d.get("length_m", 0.0)
            slope  = d.get("slope_pct", 0.0)
            cur_dist += length
            cur_wsum += slope * length

        if cur_dist >= min_distance_m:
            chunks.append((cur_nodes, cur_dist, cur_wsum))
            cur_nodes = [v]
            cur_dist  = 0.0
            cur_wsum  = 0.0

    if len(cur_nodes) >= 2:
        if chunks:
            # 마지막 조각(항상 min_distance_m 미만 — 위 루프가 그 이상이면 이미
            # chunk로 끊었으므로)을 직전 unit에 흡수
            last_nodes, last_dist, last_wsum = chunks[-1]
            chunks[-1] = (
                last_nodes + cur_nodes[1:],
                last_dist + cur_dist,
                last_wsum + cur_wsum,
            )
        else:
            # 경로 전체가 30m 미만 — 그 자체로 유일한 unit
            chunks.append((cur_nodes, cur_dist, cur_wsum))

    # ── 2. MeasurementUnit 객체 생성 ─────────────────────────────────────────
    units = []
    for i, (nodes, dist, wsum) in enumerate(chunks):
        slope_pct = (wsum / dist) if dist > 0 else 0.0
        units.append(MeasurementUnit(
            unit_index         = i,
            start_node          = nodes[0],
            end_node            = nodes[-1],
            intermediate_nodes  = nodes[1:-1],
            distance_m          = round(dist, 1),
            slope_pct           = round(slope_pct, 2),
        ))
    return units
