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

from routing.cost import classify_zone, USER_TYPES

# 지도 색·음성안내(NavSegment.zone)에만 적용하는 완충(hysteresis) 폭(%p, 총 폭 —
# 경계 위아래로 절반씩 걸침). 경계값(g_opt/g_warn) 바로 근처에서 인접 구간끼리
# zone 이 오락가락(초록↔주황 깜빡임)하는 걸 줄인다 — 데이터 분석(slope_data_review.py)
# 결과 인접-이웃 slope 차이가 median 0.25%p·p90 2.38%p 라, 그 정도 흔들림은 흡수하되
# 진짜 여러 %p 단위로 바뀌는 실제 경사 변화엔 여전히 반응하도록 잡은 값.
# ⚠️ 라우팅 비용(slope_cost/slope_score)과 경로 자체의 안전 배제(forbidden)는 이
# 완충과 무관하게 원래 g_opt/g_warn 그대로 계산한다 — "화면에 뭐라고 보여줄지"만
# 완충하지 실제 위험도 판정은 안 건드린다.
HYSTERESIS_MARGIN_PCT = 1.5

# zone 전환은 이 값(연속 NavSegment 수) 이상 유지되는 후보만 실제로 반영한다
# ("디바운스"). 전체 도로 표본(529개, slope_data_review.py 방법론) 실측:
#   margin 만 키우면(1.5→4.0%p) 전환 빈도 감소가 7.5%→19.4%에서 정체되는데,
#   margin=1.5 에 이 디바운스(dwell=2)를 더하면 70.1% 감소 — 폭을 넓히는 것보다
#   "후보가 최소 몇 구간은 버텨야 인정" 쪽이 훨씬 효과적이었다. margin 을 더
#   키우는 대신 이 값을 조정하는 걸 우선 고려할 것.
ZONE_DWELL_SEGMENTS = 2


def _zone_with_hysteresis(g_abs: float, g_opt: float, g_warn: float, prev_zone: str | None) -> str:
    """prev_zone(직전 구간의 완충 적용 후 zone) 기준으로 경계를 밀어서 완충."""
    half = HYSTERESIS_MARGIN_PCT / 2.0

    # optimal ↔ warning 경계: 직전이 "차분한"(optimal/flat/없음) 상태면 넘어가기
    # 어렵게(+half), 이미 warning/forbidden 이면 돌아오기 어렵게(-half).
    was_calm = prev_zone in (None, "flat", "optimal")
    threshold = g_opt + half if was_calm else g_opt - half
    if g_abs <= threshold:
        return "optimal"

    # warning ↔ forbidden 경계도 동일한 방식.
    was_below_forbidden = prev_zone in (None, "flat", "optimal", "warning")
    threshold = g_warn + half if was_below_forbidden else g_warn - half
    return "forbidden" if g_abs > threshold else "warning"


def _debounce_zones(candidates: list[str]) -> list[str]:
    """
    후보 zone 시퀀스에서, 직전과 다른 값이 ZONE_DWELL_SEGMENTS 미만으로만 이어지다
    다시 바뀌는 "짧게 튀는" 구간을 직전 확정 zone으로 되돌린다. 순수하게 시퀀스만
    보는 별도 패스라 완충(경계값 기준)과 조합해도 서로 간섭하지 않는다.
    """
    if not candidates:
        return candidates
    out = list(candidates)
    cur = candidates[0]
    i = 1
    n = len(candidates)
    while i < n:
        if candidates[i] == cur:
            i += 1
            continue
        j = i
        while j < n and candidates[j] == candidates[i]:
            j += 1
        if j - i >= ZONE_DWELL_SEGMENTS:
            cur = candidates[i]
        else:
            for k in range(i, j):
                out[k] = cur
        i = j
    return out


def apply_zone_hysteresis(segs: list, user_type: str) -> list:
    """
    경로 순서대로 NavSegment.zone 을 완충(경계값 히스테리시스) + 디바운스(최소 지속
    구간 수) 두 단계로 다시 배정한다(제자리 수정). direction 이 바뀌거나(오르막↔
    내리막 등) 첫 구간이면 완충 없이 classify_zone 그대로 — 실제 방향 전환은
    노이즈가 아니라 즉시 반영해야 한다.
    """
    if not segs:
        return segs

    # 1) 경계값 히스테리시스로 후보 zone 계산
    candidates: list[str] = []
    prev_zone: str | None = None
    prev_direction: str | None = None
    for seg in segs:
        mean = seg.slope_mean
        if abs(mean) < 0.5:
            direction = "flat"
        elif mean > 0:
            direction = "up"
        else:
            direction = "down"

        if direction == "flat":
            zone = "flat"
        elif direction == prev_direction:
            th = USER_TYPES[user_type][direction]
            zone = _zone_with_hysteresis(abs(mean), th["g_opt"], th["g_warn"], prev_zone)
        else:
            zone = classify_zone(mean, direction, user_type)

        candidates.append(zone)
        prev_zone, prev_direction = zone, direction

    # 2) 디바운스 — 짧게 튀는 후보는 무시하고 직전 확정 zone 유지
    final_zones = _debounce_zones(candidates)

    for seg, z in zip(segs, final_zones):
        seg.zone = z
    return segs


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
    # S6.5 — 사실 필드만. 차단 여부는 이 값을 참조하는 cost.FACILITY_POLICY가
    # 결정한다(여기 인코딩하지 않음). OSM 원본 highway=='steps' 태그 기반
    # (graph.py가 이미 엣지 속성으로 보존 — 근사 아님). 구간 안의 엣지 중
    # 하나라도 계단이면 True(휠체어는 그 구간의 일부만 계단이어도 통과 불가).
    is_stairs:          bool  = False

    def all_nodes(self) -> list:
        return [self.start_node] + self.intermediate_nodes + [self.end_node]


def extract_waypoints(G) -> set:
    """그래프에서 교차로 노드 집합 반환 (out_degree > 2 = 3방향 이상)."""
    return {n for n in G.nodes if G.out_degree(n) > 2}


def _compute_stats(G, nodes: list, user_type: str) -> tuple:
    """
    노드 시퀀스의 엣지들에서 (length_m, slope_mean, slope_max, slope_stddev, zone,
    is_stairs) 계산. 엣지가 없으면 모두 0 / flat / False.
    """
    slopes, total_len = [], 0.0
    is_stairs = False
    for u, v in zip(nodes, nodes[1:]):
        if G.has_edge(u, v):
            d = G[u][v]
            slopes.append(d.get("slope_pct", 0.0))
            total_len += d.get("length_m", 0.0)
            if d.get("highway") == "steps":
                is_stairs = True

    if not slopes:
        return 0.0, 0.0, 0.0, 0.0, "flat", is_stairs

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

    return total_len, round(mean, 3), round(mx, 3), round(std, 3), zone, is_stairs


def _make_segment(seg_id: int, nodes: list, G, user_type: str) -> NavSegment:
    length, mean, mx, std, zone, is_stairs = _compute_stats(G, nodes, user_type)
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
        is_stairs          = is_stairs,
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
    segs = _merge_short(segs, G, user_type, min_length_m)

    # ── 4. zone 완충(hysteresis) — 지도 색·음성안내만 대상, 라우팅 비용은 무관 ──
    return apply_zone_hysteresis(segs, user_type)
