"""
교차로 기반 Navigation Segment 분할

10m 노드 시퀀스(CCH/NetworkX 경로)를 교차로(out_degree > 2) 기준으로 묶어
GPS 기반 음성안내 단위인 NavSegment를 생성한다.

설계 원칙:
  - out_degree > 2: 이 노드에서 2개 초과 방향으로 갈 수 있음 (실제 교차로)
    (양방향 DiGraph에서 직선 도로 노드는 out_degree = 2)
  - min_length_m = 30m: GPS 오차(5-15m) × 2 = 통과 판정 안정 하한
  - 짧은 구간은 다음 구간에 흡수 (마지막이면 이전 구간에 흡수)
"""
import statistics
from dataclasses import dataclass, field

from routing.cost import classify_zone


@dataclass
class NavSegment:
    segment_id:         int
    start_node:         tuple
    end_node:           tuple
    intermediate_nodes: list = field(default_factory=list)
    length_m:           float = 0.0
    slope_mean:         float = 0.0
    slope_max:          float = 0.0
    slope_stddev:       float = 0.0
    zone:               str   = "flat"

    def all_nodes(self) -> list:
        return [self.start_node] + self.intermediate_nodes + [self.end_node]


def extract_waypoints(G) -> set:
    """그래프에서 교차로 노드 집합 반환 (out_degree > 2 = 3방향 이상)."""
    return {n for n in G.nodes if G.out_degree(n) > 2}


def _compute_stats(G, nodes: list, user_type: str) -> tuple:
    """
    노드 시퀀스의 엣지들에서 (length_m, slope_mean, slope_max, slope_stddev, zone) 계산.
    엣지가 없으면 모두 0 / flat.
    """
    slopes, total_len = [], 0.0
    for u, v in zip(nodes, nodes[1:]):
        if G.has_edge(u, v):
            d = G[u][v]
            slopes.append(d.get("slope_pct", 0.0))
            total_len += d.get("length_m", 0.0)

    if not slopes:
        return 0.0, 0.0, 0.0, 0.0, "flat"

    mean = sum(slopes) / len(slopes)
    mx   = max(abs(s) for s in slopes)
    std  = statistics.stdev(slopes) if len(slopes) > 1 else 0.0

    if abs(mean) < 0.5:
        direction = "flat"
    elif mean > 0:
        direction = "up"
    else:
        direction = "down"
    zone = classify_zone(mean, direction, user_type)

    return total_len, round(mean, 3), round(mx, 3), round(std, 3), zone


def _make_segment(seg_id: int, nodes: list, G, user_type: str) -> NavSegment:
    length, mean, mx, std, zone = _compute_stats(G, nodes, user_type)
    return NavSegment(
        segment_id         = seg_id,
        start_node         = nodes[0],
        end_node           = nodes[-1],
        intermediate_nodes = nodes[1:-1],
        length_m           = length,
        slope_mean         = mean,
        slope_max          = mx,
        slope_stddev       = std,
        zone               = zone,
    )


def _merge_short(segs: list, G, user_type: str, min_length_m: float) -> list:
    """min_length_m 미만 구간을 인접 구간에 흡수 (pass가 없을 때까지 반복)."""
    changed = True
    while changed:
        changed = False
        result, i = [], 0
        while i < len(segs):
            s = segs[i]
            if s.length_m < min_length_m:
                if i + 1 < len(segs):
                    # 다음 구간에 흡수
                    merged_nodes = s.all_nodes() + segs[i + 1].all_nodes()[1:]
                    result.append(_make_segment(s.segment_id, merged_nodes, G, user_type))
                    i += 2
                    changed = True
                elif result:
                    # 마지막 구간이면 이전 구간에 흡수
                    prev = result.pop()
                    merged_nodes = prev.all_nodes() + s.all_nodes()[1:]
                    result.append(_make_segment(prev.segment_id, merged_nodes, G, user_type))
                    i += 1
                    changed = True
                else:
                    result.append(s)
                    i += 1
            else:
                result.append(s)
                i += 1
        segs = result

    # segment_id 재번호
    for idx, s in enumerate(segs):
        s.segment_id = idx
    return segs


def build_navigation_segments(
    G,
    path_nodes: list,
    user_type:   str   = "elderly",
    min_length_m: float = 30.0,
    waypoints_set: set | None = None,
) -> list:
    """
    path_nodes (CCH/NetworkX 경로 노드 시퀀스) → NavSegment 목록.

    알고리즘:
      1. 경로 내 교차로(out_degree > 2) 노드에서 분할
      2. min_length_m 미만 구간은 인접 구간과 합치기

    waypoints_set: extract_waypoints(G) 결과를 미리 계산해 재사용하기 위한 파라미터.
    서울 전역 그래프는 노드가 수십만 개라 extract_waypoints가 매 호출마다 전체
    노드를 순회하면(구 코드) 요청 하나당 유의미한 지연이 생긴다 — 그래프가 바뀌지
    않는 한 결과도 바뀌지 않으므로, 서버 시작 시 1회 계산해 넘겨 쓰는 것을 권장.
    넘기지 않으면(테스트 등) 기존처럼 그 자리에서 계산한다.
    """
    if len(path_nodes) < 2:
        return []

    if waypoints_set is None:
        waypoints_set = extract_waypoints(G)

    # ── 1. 교차로 기준 분할 ───────────────────────────────────────────────────
    raw: list[list] = []
    current = [path_nodes[0]]

    for node in path_nodes[1:]:
        current.append(node)
        # 경로 끝이 아니고 교차로이면 분할 (현재 노드가 다음 구간 시작점도 됨)
        if node is not path_nodes[-1] and node in waypoints_set:
            raw.append(current)
            current = [node]

    if len(current) >= 2:
        raw.append(current)
    elif raw:
        # 마지막 한 노드가 남은 경우 이전 구간에 합치기
        raw[-1].extend(current[1:])

    # ── 2. NavSegment 객체 생성 ───────────────────────────────────────────────
    segs = [_make_segment(i, nodes, G, user_type) for i, nodes in enumerate(raw)]

    # ── 3. 짧은 구간 병합 ─────────────────────────────────────────────────────
    return _merge_short(segs, G, user_type, min_length_m)
