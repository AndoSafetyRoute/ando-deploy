"""
동시 요청 시 장거리 find_route 가 느려지는 원인 측정(인수인계 3번).

1) 서울역→강남역 find_route 단계별 시간(순차)
2) 같은 요청 N개를 스레드로 동시에 → 벽시계/요청당 시간
3) 단계별로 스레드 동시 실행해 GIL 을 놓는지(병렬화되는지) 확인
   - CCH 쿼리(routingkit_cch) / 부분그래프 구성(numpy) / scipy dijkstra

실행: cd backend/scripts && python -u concurrency_probe.py  (메모리 ~8GB)
"""
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import routing.cch_engine as ce
from config import GEOJSON_PATH, MAX_DETOUR_RATIO
from routing.graph import build_graph
from routing.cost import precompute_edge_costs
from routing.cch_engine import build_cch_engine

O, D = (126.9707, 37.5547), (127.0276, 37.4979)   # 서울역→강남역
UT = "manual_wheelchair"
N = 5


def par(fn, n=N):
    """fn 을 n개 스레드로 동시에 → (벽시계, 평균 개별시간)."""
    def timed(_):
        t = time.perf_counter(); fn(); return time.perf_counter() - t
    t0 = time.perf_counter()
    with ThreadPoolExecutor(n) as ex:
        each = list(ex.map(timed, range(n)))
    return time.perf_counter() - t0, sum(each) / n


def seq(fn, reps=3):
    ts = []
    for _ in range(reps):
        t = time.perf_counter(); fn(); ts.append(time.perf_counter() - t)
    return min(ts)


def main():
    t0 = time.time()
    G = build_graph(GEOJSON_PATH)
    precompute_edge_costs(G)
    eng = build_cch_engine(G, order_cache_path=os.path.splitext(GEOJSON_PATH)[0] + ".cchorder.pkl")
    print(f"\n[load] {time.time() - t0:.0f}s\n", flush=True)

    src, dst = eng._nearest_id(*O), eng._nearest_id(*D)
    path_d = eng._query(eng.metric_dist, src, dst)
    sd = eng._path_dist_m(path_d)
    radius = MAX_DETOUR_RATIO * sd * ce.ALPHA_SEARCH_LOCAL_MARGIN
    sub = eng._local_alpha_subgraph(src, dst, UT, radius)
    print(f"최단 {sd:.0f}m  부분그래프 노드 {len(sub['nodes']):,} 엣지 {sub['n_edges']:,}")

    stages = {
        "find_route 전체":    lambda: eng.find_route(O, D, UT),
        "CCH 쿼리(dist)":     lambda: eng._query(eng.metric_dist, src, dst),
        "CCH 쿼리(a1)":       lambda: eng._query(eng.metrics_a1[UT], src, dst),
        "부분그래프 구성":    lambda: eng._local_alpha_subgraph(src, dst, UT, radius),
        "scipy dijkstra 1회": lambda: eng._local_alpha_query(sub, 0.5),
        "구간 복원(segments)": lambda: ce.recalculate_path_slopes(G, path_d),
    }
    print(f"\n{'단계':<22}{'순차 1회':>10}{'동시'+str(N)+' 벽시계':>14}{'요청당':>10}{'병렬도':>8}")
    for name, fn in stages.items():
        s = seq(fn)
        wall, each = par(fn)
        # 병렬도: 완전 직렬이면 ≈1.0, 완전 병렬이면 ≈N
        print(f"{name:<22}{s:>9.3f}s{wall:>13.3f}s{each:>9.3f}s{N * s / wall:>8.2f}", flush=True)


if __name__ == "__main__":
    main()
