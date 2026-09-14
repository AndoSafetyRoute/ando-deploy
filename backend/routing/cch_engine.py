"""
CCH (Customizable Contraction Hierarchies) 라우팅 엔진
routingkit-cch v0.1.4 실제 API 기반

실제 API (routingkit_cch/__init__.pyi 기준):
  CCH(order, tail, head, filter_always_inf_arcs)
  CCHMetric(cch, weights)       # 초기 생성
  CCHMetric.reset(weights)      # 재커스터마이제이션 (기존 버퍼 재사용, 빠름)
  CCHQuery(metric).run(src, dst) -> CCHQueryResult
  CCHQueryResult.distance       # int | None
  CCHQueryResult.node_path      # list[int] (프로퍼티)
  compute_order_inertial(n, tail, head, latitude, longitude) -> list[int]

build_cch_engine(G) → CCHEngine
engine.find_route(origin_lonlat, dest_lonlat, user_type) → find_route()와 동일 형식
"""
import hashlib
import math
import os
import pickle
import time

import numpy as np
from scipy.spatial import KDTree

from config import MAX_DETOUR_RATIO, FORBIDDEN_PENALTY, BASE_DIR
from routing.cost import USER_TYPES, slope_cost
from routing.pathfinder import recalculate_path_slopes
from routing.basis import precompute_basis_weights, save_basis_weights, load_basis_weights


def is_forbidden_for_any_type(slope_pct: float) -> bool:
    """
    경사 g가 6개 유형 중 하나라도 '금지'(g_warn 초과) 구간으로 분류하면 True.
    ando_dev_final.md 6.2절 "거리 경로에 안전 필터가 필요하다" — 순수 거리
    metric은 FORBIDDEN_PENALTY가 없어 휠체어 사용자에게도 급경사를 추천할
    수 있다. 유형별로 필터를 따로 두지 않고, 가장 엄격한 기준(어느 유형이든
    금지면 금지)으로 단일 안전 필터를 만든다 — 8번째 metric은 유형 무관 1개뿐.
    """
    direction = "up" if slope_pct >= 0 else "down"
    g_abs = abs(slope_pct)
    for params in USER_TYPES.values():
        if g_abs > params[direction]["g_warn"]:
            return True
    return False

WEIGHT_SCALE = 1_000   # slope_cost(float) → list[int] 변환 배율

# ── alpha 이진탐색 튜닝 상수 (#D) ────────────────────────────────────────────
# 회당 비용(_interp_weights_list + CCHMetric.reset())이 쿼리 자체보다 훨씬
# 커서(실측 ~630ms/회), 정확도-속도 트레이드오프가 필요해지면 이 값부터
# 낮춘다. 해상도는 1/2**ALPHA_SEARCH_MAX_STEPS.
ALPHA_SEARCH_MAX_STEPS      = 5
# #C(조기 종료) 기본 OFF — 실측 재검증에서 "같은 경로가 2회 연속(채택 후보끼리만
# 비교) 나오면 멈춘다"는 조건도 안전하지 않음을 확인했다: 남산도서관→명동
# (cane, 최단 2,465m)에서 step 3에 채택 후보 경로가 2회 연속 완전히 동일
# (same_path=True)해 조기 종료했는데도, 남은 2스텝을 마저 돌리면 avgSlope
# 9.31→9.11, totalDistance 2,516.5m→2,564.8m로 더 나은(경사 더 낮은) 경로를
# 찾아냈다 — CCH 정수 가중치 양자화 때문에 "경로가 2회 연속 같다"가 진짜
# 수렴을 보장하지 않는다. #B(초기 추정값)는 같은 검증에서 전 케이스 경로
# 완전 동일(회귀 없음)을 확인했으므로 그대로 켜 둔다. 이 값을 키워 다시
# 켜려면(정확도-속도 트레이드오프 감수) 위 실측을 먼저 재확인할 것.
ALPHA_SEARCH_EARLY_STOP_ENABLED = False
ALPHA_SEARCH_EARLY_STOP_REL     = 0.01

# 이진탐색 진입 빈도 실측용 프로세스 전역 카운터(#A) — 요청마다 리셋되지
# 않고 서버 수명 동안 누적해 트리거율을 로그로 확인한다.
_ALPHA_SEARCH_STATS = {"calls": 0, "triggered": 0}


def _topology_key(n: int, tail_np: np.ndarray, head_np: np.ndarray) -> str:
    """그래프 위상(노드수 + 방향엣지 tail/head)만으로 만든 해시.

    inertial order 는 위상+좌표에만 의존하는데, 위상이 같으면 좌표도 같다
    (같은 그래프). 가중치·비용은 무관하므로 프로파일이 바뀌어도 캐시 유효.
    """
    h = hashlib.sha1()
    h.update(n.to_bytes(8, "little"))
    h.update(np.ascontiguousarray(tail_np, dtype=np.uint32).tobytes())
    h.update(np.ascontiguousarray(head_np, dtype=np.uint32).tobytes())
    return h.hexdigest()


def _load_or_compute_order(cache_path, key, n, compute_fn):
    """order 캐시 로딩 시도 → 실패/불일치 시 compute_fn() 재계산 후 저장.

    order 는 CCH 전처리에서 가장 무거운 단계(서울 1.7M 노드 기준 ~146s).
    EC2 콜드 스타트를 줄이려면 디스크 캐시가 필수.
    """
    if cache_path and os.path.exists(cache_path):
        try:
            with open(cache_path, "rb") as f:
                c = pickle.load(f)
            if c.get("key") == key and len(c.get("order", ())) == n:
                print(f"[CCH] order 캐시 적중: {cache_path}")
                return list(c["order"])
            print(f"[CCH] order 캐시 불일치(위상 변경) → 재계산: {cache_path}")
        except Exception as e:
            print(f"[CCH] order 캐시 로딩 실패({e!r}) → 재계산")

    t = time.time()
    order = compute_fn()
    print(f"[CCH] inertial order 계산 완료 ({time.time() - t:.0f}s)")

    if cache_path:
        try:
            tmp = f"{cache_path}.tmp{os.getpid()}"
            with open(tmp, "wb") as f:
                pickle.dump({"key": key, "n": n, "order": list(order)},
                            f, protocol=pickle.HIGHEST_PROTOCOL)
            os.replace(tmp, cache_path)
            print(f"[CCH] order 캐시 저장: {cache_path}")
        except Exception as e:
            print(f"[CCH] order 캐시 저장 실패({e!r}) — 무시")
    return order


class CCHEngine:
    """
    빌드된 CCH 엔진. build_cch_engine()으로 생성.

    내부 보관:
      cch          : CCH 위상 구조 (공유, 읽기 전용)
      node_list    : [NetworkX 노드 키, ...]  (인덱스 == CCH 노드 ID)
      node_to_id   : {노드 키: CCH 노드 ID}
      tree         : KDTree (좌표 → 최근접 노드 ID)
      _dist_wf     : float64 배열, 거리 가중치 (alpha=0, 보간 연산용)
      _slope_wf    : {user_type: float64 배열}  (alpha=1)
      metric_dist  : CCHMetric (거리 기준, 안전 필터 없음 — 내부 alpha 보간용)
      metrics_a1   : {user_type: CCHMetric}  (경사 기준 alpha=1)
      metric_dist_safe : CCHMetric (거리 + 금지구간 배제, 6.2절 "경로②" 전용)
      basis_weights : sparse (m, 15) — 엣지별 L_e·B_k(g_e), θ와 무관한 정적값
                      (7.3절 ⑥). 개인 metric = θ·basis_weights 로 배치(⑨)에서 사용.
      edge_tail/edge_head : CCHMetric weight 배열과 동일 순서의 tail/head 노드 ID
                      리스트 — 캐시 관리자(⑧)가 새 CCHMetric을 지을 때 필요.
    """

    def __init__(self, G, cch, node_list, node_to_id,
                 tree, lon_to_m, lat_to_m,
                 dist_wf, slope_wf,
                 metric_dist, metrics_a1,
                 metric_dist_safe=None,
                 basis_weights=None,
                 edge_tail=None, edge_head=None):
        self.G           = G
        self.cch         = cch
        self.node_list   = node_list
        self.node_to_id  = node_to_id
        self.tree        = tree
        self._lon_to_m   = lon_to_m
        self._lat_to_m   = lat_to_m
        self._dist_wf    = dist_wf           # float64 ndarray
        self._slope_wf   = slope_wf          # {ut: float64 ndarray}
        # alpha 이진탐색(_interp_weights_list)이 매 호출마다 (slope_wf[ut] - dist_wf)
        # 를 다시 빼던 것을 빌드 시점에 1회만 계산해 둔다(#5, 엣지 수만큼의 배열
        # 연산 — 이 배열은 3.8M+ 원소라 반복 호출 시 무시 못 할 비용).
        self._slope_minus_dist = {ut: sw - dist_wf for ut, sw in slope_wf.items()}
        self.metric_dist = metric_dist       # CCHMetric
        self.metrics_a1  = metrics_a1        # {ut: CCHMetric}
        self.metric_dist_safe = metric_dist_safe   # CCHMetric | None
        self.basis_weights    = basis_weights      # scipy.sparse (m, 15) | None
        self.edge_tail        = edge_tail          # list[int] | None
        self.edge_head        = edge_head          # list[int] | None

    # ── 내부 헬퍼 ────────────────────────────────────────────────────────────

    def _nearest_id(self, lon: float, lat: float) -> int:
        """WGS84 좌표 → 최근접 CCH 노드 ID (KDTree)."""
        x = lon * self._lon_to_m
        y = lat * self._lat_to_m
        _, idx = self.tree.query([x, y])
        return int(idx)

    def _path_dist_m(self, path_nodes: list) -> float:
        G = self.G
        return sum(
            G[u][v]["length_m"]
            for u, v in zip(path_nodes, path_nodes[1:])
            if G.has_edge(u, v)
        )

    def _query(self, metric, src_id: int, dst_id: int):
        """CCH 단일 쿼리 → path_nodes list | None."""
        from routingkit_cch import CCHQuery
        result = CCHQuery(metric).run(src_id, dst_id)
        if result.distance is None:
            return None
        ids = result.node_path          # 프로퍼티 (메서드 호출 아님)
        if not ids:
            return None
        return [self.node_list[i] for i in ids]

    def _interp_weights_list(self, user_type: str, alpha: float) -> list:
        """alpha 보간 → Python list[int] (CCHMetric.reset용).

        (slope_wf[ut] - dist_wf)는 __init__에서 미리 계산해 둔
        self._slope_minus_dist[ut]를 쓴다 — 매 이진탐색 반복(최대 5회)마다
        3.8M+ 원소 배열 뺄셈을 다시 하지 않는다(#5a).
        """
        w = self._dist_wf + alpha * self._slope_minus_dist[user_type]
        return np.maximum(1, w).astype(np.int64).tolist()

    # ── 공개 API ─────────────────────────────────────────────────────────────

    def find_route(self, origin_lonlat: tuple, dest_lonlat: tuple,
                   user_type: str,
                   max_detour_ratio: float = MAX_DETOUR_RATIO) -> dict:
        """
        CCH 기반 경로 탐색.
        반환 형식은 routing.pathfinder.find_route()와 동일.
        """
        from routingkit_cch import CCHMetric
        t0 = time.time()

        src_id = self._nearest_id(*origin_lonlat)
        dst_id = self._nearest_id(*dest_lonlat)
        if src_id == dst_id:
            raise ValueError("출발지와 목적지가 동일한 노드입니다.")

        # ── 1. 최단 거리 기준 (alpha=0) ──────────────────────────────────────
        path_d = self._query(self.metric_dist, src_id, dst_id)
        if path_d is None:
            raise ValueError("경로를 찾을 수 없습니다.")
        shortest_dist = self._path_dist_m(path_d)

        # ── 2. 경사 최적 (alpha=1, pre-built metric) ─────────────────────────
        path_s = self._query(self.metrics_a1[user_type], src_id, dst_id)
        if path_s is None:
            path_nodes = path_d
            used_alpha = 0.0
        else:
            slope_dist = self._path_dist_m(path_s)
            detour     = slope_dist / shortest_dist if shortest_dist > 0 else 1.0
            print(f"[CCH] 최단={shortest_dist:.0f}m  경사최적={slope_dist:.0f}m  "
                  f"우회={detour:.2f}x")

            # #A: 이진탐색 진입 빈도 실측 — 트리거율이 낮으면(장거리에서만
            # 드물게) 회당 비용 최적화(#B~D)의 우선순위가 낮아지므로 먼저 잰다.
            _ALPHA_SEARCH_STATS["calls"] += 1

            if detour <= max_detour_ratio:
                path_nodes = path_s
                used_alpha = 1.0
            else:
                _ALPHA_SEARCH_STATS["triggered"] += 1
                stats = _ALPHA_SEARCH_STATS
                trigger_rate = stats["triggered"] / stats["calls"] * 100
                print(f"[CCH] 우회 초과 → alpha 이진탐색 시작  "
                      f"(누적 트리거율 {stats['triggered']}/{stats['calls']} "
                      f"= {trigger_rate:.0f}%, shortest_dist={shortest_dist:.0f}m)")

                # #B: lo=0/hi=1 맹목적 이분 대신, detour(alpha=0)=1.0과
                # detour(alpha=1)=detour(위에서 이미 계산됨)를 잇는 직선에서
                # 목표 우회율에 해당하는 alpha를 역산해 첫 쿼리 지점으로 쓴다.
                # detour가 alpha에 단조증가한다는 전제(이분법 정당성의 전제와
                # 동일)에서, 실제 곡선이 완전한 직선이 아니어도 0.5보다는
                # 목표에 가까운 시작점이 된다. [0, 1]로 clamp해 안전판을 둔다.
                alpha0 = ((max_detour_ratio - 1.0) / (detour - 1.0)
                          if detour > 1.0 else 0.5)
                alpha0 = min(max(alpha0, 0.0), 1.0)
                print(f"[CCH] 초기 추정 alpha0={alpha0:.3f} "
                      f"(선형보간, blind 0.5 대신)")

                # 첫 iteration용 CCHMetric 1개 생성, 이후 reset()으로 재활용
                lo, hi     = 0.0, 1.0
                path_nodes = path_d
                used_alpha = 0.0
                metric_bs  = None  # lazy init
                prev_accepted_dist  = None   # "채택된"(=lo 갱신) 후보끼리만 비교
                prev_accepted_nodes = None
                steps_used = 0

                for step in range(ALPHA_SEARCH_MAX_STEPS):
                    mid = alpha0 if step == 0 else (lo + hi) / 2
                    steps_used = step + 1
                    w_list = self._interp_weights_list(user_type, mid)
                    if metric_bs is None:
                        metric_bs = CCHMetric(self.cch, w_list)
                    else:
                        metric_bs.reset(w_list)   # 기존 버퍼 재사용 (빠름)

                    cand = self._query(metric_bs, src_id, dst_id)
                    if cand is None:
                        hi = mid
                        continue
                    cand_dist = self._path_dist_m(cand)
                    accepted  = cand_dist / shortest_dist <= max_detour_ratio
                    if not accepted:
                        hi = mid
                        continue
                    lo, path_nodes, used_alpha = mid, cand, mid

                    # #C: 직전 "채택된"(lo 갱신) 후보와만 비교한다 — reject된
                    # 후보(hi 쪽, 다른 브래킷)와 섞어 비교하면 우연히 거리가
                    # 비슷해도 서로 다른 경로일 수 있어 조기 종료가 더 나은
                    # 후보를 놓칠 수 있다(실측: 남산→명동 cane 케이스에서 이
                    # 버그로 avgSlope 9.11→9.31, totalDistance 2564.8→2516.5m
                    # 로 실제 경로가 나빠짐 — 채택 후보끼리만 비교하도록 고친
                    # 뒤 재검증 완료).
                    if ALPHA_SEARCH_EARLY_STOP_ENABLED and prev_accepted_nodes is not None:
                        same_path = (cand == prev_accepted_nodes)
                        rel_change = (
                            abs(cand_dist - prev_accepted_dist) / prev_accepted_dist
                            if prev_accepted_dist > 0 else 0.0
                        )
                        if same_path or rel_change < ALPHA_SEARCH_EARLY_STOP_REL:
                            print(f"[CCH] 조기 종료 (step={step+1}, "
                                  f"same_path={same_path}  "
                                  f"Δ={rel_change*100:.2f}% < "
                                  f"{ALPHA_SEARCH_EARLY_STOP_REL*100:.0f}%)")
                            break
                    prev_accepted_nodes, prev_accepted_dist = cand, cand_dist

                print(f"[CCH] 이진탐색 완료 alpha={used_alpha:.3f}  "
                      f"steps={steps_used}/{ALPHA_SEARCH_MAX_STEPS}")

        # ── 4. 구간 정보 복원 ────────────────────────────────────────────────
        G        = self.G
        segments = recalculate_path_slopes(G, path_nodes)
        total_len = sum(s["length_m"] for s in segments)
        avg_slope = (
            sum(abs(s["slope_pct"]) * s["length_m"] for s in segments) / total_len
            if total_len > 0 else 0.0
        )
        total_cost = sum(
            slope_cost(
                G[u][v].get("slope_pct", 0.0),
                user_type,
                G[u][v].get("length_m", 1.0),
            )
            for u, v in zip(path_nodes, path_nodes[1:])
            if G.has_edge(u, v)
        )

        print(f"[CCH] 완료 {time.time() - t0:.2f}s  "
              f"노드={len(path_nodes)}  alpha={used_alpha:.3f}")

        return {
            "algorithm":      "cch",
            "origin_node":    self.node_list[src_id],
            "dest_node":      self.node_list[dst_id],
            "path_nodes":     path_nodes,
            "segments":       segments,
            "total_length_m": total_len,
            "total_cost":     total_cost,
            "avg_slope_pct":  avg_slope,
            "user_label":     USER_TYPES[user_type]["label"],
            "used_alpha":     used_alpha,
            # ── 성능: "최단 거리" 카드(find_distance_route(safe=False))가 바로 위에서
            # 이미 구해둔 이 alpha=0 쿼리 결과를 재사용할 수 있게 그대로 실어 보낸다.
            # find_distance_route(safe=True)는 다른 metric(금지구간 회피)이라 이걸
            # 못 쓴다 — 호출부가 safe 여부를 보고 재사용 여부를 판단해야 한다.
            "shortest_path_nodes": path_d,
            "shortest_dist_m":     shortest_dist,
        }

    def find_distance_route(self, origin_lonlat: tuple, dest_lonlat: tuple,
                            safe: bool = False) -> dict:
        """
        경로② "최단 경로" — 말 그대로 그래프상 길이가 가장 짧은 경로(다익스트라,
        alpha=0, 거리 외 제약 없음). 유형별 경로가 우회 배율을 재는 기준선과 동일하므로
        항상 유형별 경로 거리 ≤ 최단 경로 거리 × MAX_DETOUR_RATIO 관계가 성립한다.

        safe=True 를 주면 예전 동작(6개 유형 중 하나라도 금지인 급경사 엣지를
        FORBIDDEN_PENALTY 로 회피한 '안전 최단')으로 조회한다 — "거리 우선" 카드가
        아니라 별도의 안전 baseline 이 필요할 때만 쓴다.
        """
        t0 = time.time()

        src_id = self._nearest_id(*origin_lonlat)
        dst_id = self._nearest_id(*dest_lonlat)
        if src_id == dst_id:
            raise ValueError("출발지와 목적지가 동일한 노드입니다.")

        metric = (self.metric_dist_safe
                  if safe and self.metric_dist_safe is not None
                  else self.metric_dist)
        path_nodes = self._query(metric, src_id, dst_id)
        if path_nodes is None:
            raise ValueError("경로를 찾을 수 없습니다.")

        result = self._build_distance_result(path_nodes, safe, src_id, dst_id)
        print(f"[CCH] 최단경로({'safe' if safe else 'pure'}) 완료 "
              f"{time.time() - t0:.2f}s  길이={result['total_length_m']:.0f}m  노드={len(path_nodes)}")
        return result

    def _build_distance_result(self, path_nodes: list, safe: bool,
                                src_id: int, dst_id: int) -> dict:
        """path_nodes(alpha=0 최단경로 노드열) → find_distance_route()와 동일한
        반환 dict. CCH 쿼리(self._query) 없이 세그먼트 복원만 한다 — find_route()가
        내부적으로 이미 구해둔 path_d를 재사용할 때(성능, _shortest_route_card
        참고) 쓴다."""
        G = self.G
        segments = recalculate_path_slopes(G, path_nodes)
        total_len = sum(s["length_m"] for s in segments)
        avg_slope = (
            sum(abs(s["slope_pct"]) * s["length_m"] for s in segments) / total_len
            if total_len > 0 else 0.0
        )
        return {
            "algorithm":      "cch-distance-safe" if safe else "cch-distance",
            "origin_node":    self.node_list[src_id],
            "dest_node":      self.node_list[dst_id],
            "path_nodes":     path_nodes,
            "segments":       segments,
            "total_length_m": total_len,
            "total_cost":     total_len,
            "avg_slope_pct":  avg_slope,
            "user_label":     "최단 경로",
            "used_alpha":     0.0,
        }

    def distance_route_from_path(self, origin_lonlat: tuple, dest_lonlat: tuple,
                                  path_nodes: list) -> dict:
        """find_route()가 반환한 shortest_path_nodes를 그대로 카드로 만든다 —
        find_distance_route(safe=False)와 결과가 동일하지만 CCH 쿼리를 다시
        돌리지 않는다(성능, #3). safe=True(안전 최단, 다른 metric)가 필요하면
        이 메서드를 쓰면 안 되고 find_distance_route(safe=True)를 그대로 호출할 것.
        _nearest_id는 KDTree 조회라 비용이 무시할 만하다 — origin_node/dest_node
        라벨을 채우려고 다시 부른다."""
        src_id = self._nearest_id(*origin_lonlat)
        dst_id = self._nearest_id(*dest_lonlat)
        return self._build_distance_result(path_nodes, False, src_id, dst_id)

    def find_route_with_metric(self, origin_lonlat: tuple, dest_lonlat: tuple,
                                metric, label: str, kind: str) -> dict:
        """
        임의의(이미 만들어진) CCHMetric으로 경로 조회 — 경로③ "맞춤 경로" 전용
        (⑧ PersonalMetricCache가 준 개인 metric을 그대로 받는다).
        find_distance_route()와 로직은 같고 metric/label/kind만 외부에서 받는
        범용 버전 — 개인화 metric이 늘어나도(예: 세션별 실험 metric 등) 이거
        하나로 재사용 가능하도록 분리했다.
        """
        t0 = time.time()

        src_id = self._nearest_id(*origin_lonlat)
        dst_id = self._nearest_id(*dest_lonlat)
        if src_id == dst_id:
            raise ValueError("출발지와 목적지가 동일한 노드입니다.")

        path_nodes = self._query(metric, src_id, dst_id)
        if path_nodes is None:
            raise ValueError("경로를 찾을 수 없습니다.")

        G = self.G
        segments = recalculate_path_slopes(G, path_nodes)
        total_len = sum(s["length_m"] for s in segments)
        avg_slope = (
            sum(abs(s["slope_pct"]) * s["length_m"] for s in segments) / total_len
            if total_len > 0 else 0.0
        )

        print(f"[CCH] {label} 완료 {time.time() - t0:.2f}s  노드={len(path_nodes)}")

        return {
            "algorithm":      f"cch-{kind}",
            "origin_node":    self.node_list[src_id],
            "dest_node":      self.node_list[dst_id],
            "path_nodes":     path_nodes,
            "segments":       segments,
            "total_length_m": total_len,
            "total_cost":     total_len,
            "avg_slope_pct":  avg_slope,
            "user_label":     label,
            "used_alpha":     None,
        }


def build_cch_engine(G, order_cache_path: str | None = None) -> CCHEngine:
    """
    NetworkX DiGraph → CCHEngine.
    서버 시작 시 1회 호출.

    단계:
      1. 노드·엣지 배열 구성
      2. compute_order_inertial + CCH() 전처리
      3. CCHMetric × 8  (거리 1개 + 사용자 유형 6개 + 안전거리 1개, 6.2절)
      4. 개인화 기저 가중치(15열 sparse) 사전계산 + 디스크 캐시 (⑥, 7.3절)

    order_cache_path: inertial order 를 저장/재사용할 파일 경로. 위상(노드수+
      tail/head)이 같으면 재계산을 건너뛴다(콜드 스타트 ~146s 단축). None 이면 캐시 미사용.
    """
    try:
        from routingkit_cch import CCH, CCHMetric, compute_order_inertial
    except ImportError:
        raise RuntimeError(
            "routingkit-cch 패키지가 없습니다.\n"
            "  pip install routingkit-cch"
        )

    t0 = time.time()

    # ── 1. 노드 배열 ─────────────────────────────────────────────────────────
    node_list  = list(G.nodes)
    n          = len(node_list)
    node_to_id = {nd: i for i, nd in enumerate(node_list)}
    print(f"[CCH] 노드 배열 구성 ({n:,}개)...")

    lat_arr = np.array([G.nodes[nd]["lat"] for nd in node_list], dtype=np.float64)
    lon_arr = np.array([G.nodes[nd]["lon"] for nd in node_list], dtype=np.float64)

    # KDTree용 미터 변환 (서울 위도 기준)
    mean_lat_r = math.radians(float(lat_arr.mean()))
    lat_to_m   = 111_320.0
    lon_to_m   = 111_320.0 * math.cos(mean_lat_r)
    coords_m   = np.column_stack([lon_arr * lon_to_m, lat_arr * lat_to_m])

    print(f"[CCH] KDTree 구축 중...")
    tree = KDTree(coords_m)
    print(f"[CCH] KDTree 완료 ({time.time() - t0:.1f}s)")

    # ── 2. 엣지 배열 ─────────────────────────────────────────────────────────
    edges = list(G.edges(data=True))
    m     = len(edges)
    print(f"[CCH] 엣지 배열 구성 ({m:,}개)...")

    tail_np = np.empty(m, dtype=np.uint32)
    head_np = np.empty(m, dtype=np.uint32)
    dist_wf = np.empty(m, dtype=np.float64)           # 거리 가중치 (alpha=0)
    dist_safe_wf = np.empty(m, dtype=np.float64)      # 거리 + 금지구간 배제 (경로②)
    slope_arr = np.empty(m, dtype=np.float64)         # 부호 있는 경사(%) — 기저함수용
    length_arr = np.empty(m, dtype=np.float64)        # 엣지 길이(m) — 기저함수용
    slope_wf = {ut: np.empty(m, dtype=np.float64)     # 경사 가중치 (alpha=1)
                for ut in USER_TYPES}

    for i, (u, v, data) in enumerate(edges):
        tail_np[i] = node_to_id[u]
        head_np[i] = node_to_id[v]
        length      = data.get("length_m", 1.0)
        sp          = data.get("slope_pct", 0.0)
        dist_wf[i]  = length * WEIGHT_SCALE
        dist_safe_wf[i] = (
            length * FORBIDDEN_PENALTY * WEIGHT_SCALE
            if is_forbidden_for_any_type(sp)
            else length * WEIGHT_SCALE
        )
        slope_arr[i]  = sp
        length_arr[i] = length
        for ut in USER_TYPES:
            slope_wf[ut][i] = slope_cost(sp, ut, length) * WEIGHT_SCALE

    # Python list[int] 변환 (routingkit_cch API 요구)
    print(f"[CCH] list 변환 중...")
    tail_list = tail_np.tolist()
    head_list = head_np.tolist()
    lat_list  = lat_arr.tolist()
    lon_list  = lon_arr.tolist()

    dist_w_list = np.maximum(1, dist_wf).astype(np.int64).tolist()
    dist_safe_w_list = np.maximum(1, dist_safe_wf).astype(np.int64).tolist()

    print(f"[CCH] 엣지 배열 완료 ({time.time() - t0:.1f}s)")

    # ── 3. CCH 위상 전처리 ───────────────────────────────────────────────────
    key = _topology_key(n, tail_np, head_np)
    order = _load_or_compute_order(
        order_cache_path, key, n,
        lambda: compute_order_inertial(n, tail_list, head_list, lat_list, lon_list),
    )
    print(f"[CCH] CCH() 전처리 시작...")
    cch = CCH(order, tail_list, head_list, filter_always_inf_arcs=True)
    print(f"[CCH] 전처리 완료 ({time.time() - t0:.1f}s)")

    # ── 4. CCHMetric 커스터마이제이션 (거리 + 6개 유형 + 안전거리) ────────────
    print(f"[CCH] 거리 metric 생성...")
    metric_dist = CCHMetric(cch, dist_w_list)

    print(f"[CCH] 안전거리(경로②) metric 생성...")
    metric_dist_safe = CCHMetric(cch, dist_safe_w_list)

    metrics_a1 = {}
    for ut in USER_TYPES:
        print(f"[CCH] {ut} metric 생성...")
        w_list = np.maximum(1, slope_wf[ut]).astype(np.int64).tolist()
        metrics_a1[ut] = CCHMetric(cch, w_list)

    # ── 5. 개인화 기저 가중치 사전계산 (⑥, 7.3절) ─────────────────────────────
    # θ와 무관 — 그래프(경사·길이)만으로 결정되는 정적값이라 디스크 캐시 재사용.
    # 캐시 키는 엣지 수(m)만 사용하는 단순한 방식이라, 같은 노드 수라도 그래프
    # 데이터(geojson)가 바뀌면 캐시가 stale할 수 있다 — 데이터 교체 시 캐시
    # 파일을 수동으로 지워야 한다 (추후 해시 기반 키로 개선 필요).
    basis_cache_path = os.path.join(BASE_DIR, "data", f"basis_weights_{m}.npz")
    try:
        basis_weights = load_basis_weights(basis_cache_path)
        print(f"[CCH] 기저 가중치 캐시 로드 ({basis_cache_path})")
    except Exception:
        print(f"[CCH] 기저 가중치 사전계산 중 (15개 매듭 x {m:,}개 엣지)...")
        basis_weights = precompute_basis_weights(slope_arr, length_arr)
        try:
            os.makedirs(os.path.dirname(basis_cache_path), exist_ok=True)
            save_basis_weights(basis_weights, basis_cache_path)
            print(f"[CCH] 기저 가중치 캐시 저장 ({basis_cache_path})")
        except Exception as e:
            print(f"[CCH] 기저 가중치 캐시 저장 실패 (무시하고 계속): {e}")

    elapsed = time.time() - t0
    print(f"[CCH] 전체 초기화 완료 ({elapsed:.1f}s)  노드={n:,}  엣지={m:,}")

    return CCHEngine(
        G=G,
        cch=cch,
        node_list=node_list,
        node_to_id=node_to_id,
        tree=tree,
        lon_to_m=lon_to_m,
        lat_to_m=lat_to_m,
        dist_wf=dist_wf,
        slope_wf=slope_wf,
        metric_dist=metric_dist,
        metrics_a1=metrics_a1,
        metric_dist_safe=metric_dist_safe,
        basis_weights=basis_weights,
        edge_tail=tail_list,
        edge_head=head_list,
    )
