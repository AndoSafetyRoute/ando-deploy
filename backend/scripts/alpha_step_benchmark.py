"""
ALPHA_SEARCH_MAX_STEPS(현재 5) 줄였을 때 정확도 손실 실측 — 단거리/중거리/장거리
3개 경로에 대해, 이진탐색을 5스텝 다 돌리면서 3스텝째/5스텝째 시점의 "그때 채택된
후보"를 각각 스냅샷으로 남겨 steps=3 vs steps=5를 직접 비교한다.

라이브 백엔드 프로세스와 별개로 그래프/CCH를 독립적으로 새로 빌드해서 실행 —
지금 떠 있는 서버나 에뮬레이터 테스트에 영향 없음.

실행: cd backend && python scripts/alpha_step_benchmark.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import GEOJSON_PATH, MAX_DETOUR_RATIO
from routing.graph import build_graph
from routing.cost import precompute_edge_costs
from routing.cch_engine import build_cch_engine
from routingkit_cch import CCHMetric

USER_TYPE = "manual_wheelchair"

# 단거리/중거리/장거리 — 이번 세션 실제 테스트에서 쓴 좌표 재사용.
# (lon, lat) 순서로 CCHEngine 인터페이스에 맞춤.
ROUTES = [
    ("단거리", (126.973646, 37.558425), (126.975313, 37.560003)),  # 숙대입구역~서울역 인근, ~250m대
    ("중거리", (126.964726, 37.546438), (126.970703, 37.554069)),  # 숙명여대~서울역, ~1.4km
    ("장거리", (127.000905, 37.558086), (126.970703, 37.554069)),  # 동국대~서울역 인근 장거리 변형 ~4-9km대
]


def trace_route(engine, origin, dest, user_type, max_detour_ratio=MAX_DETOUR_RATIO):
    """CCHEngine.find_route()의 이진탐색 루프를 그대로 재현하면서, 매 스텝 후
    '그 시점까지의 채택 후보'를 스냅샷으로 남긴다. steps=N으로 잘랐을 때의
    결과 = snapshots[N-1] (그 스텝까지 아무 것도 채택 안 됐으면 이전 스냅샷 유지)."""
    from routing.cch_engine import ALPHA_SEARCH_MAX_STEPS

    src_id = engine._nearest_id(*origin)
    dst_id = engine._nearest_id(*dest)

    t0 = time.perf_counter()
    path_d = engine._query(engine.metric_dist, src_id, dst_id)
    shortest_dist = engine._path_dist_m(path_d)

    path_s = engine._query(engine.metrics_a1[user_type], src_id, dst_id)
    if path_s is None:
        return None
    slope_dist = engine._path_dist_m(path_s)
    detour = slope_dist / shortest_dist if shortest_dist > 0 else 1.0

    if detour <= max_detour_ratio:
        # 이진탐색 자체가 트리거 안 됨 — steps 값과 무관, 항상 동일 결과.
        t_total = time.perf_counter() - t0
        segs = _segments_summary(engine, path_s)
        return {
            "triggered": False, "shortest_dist": shortest_dist, "detour": detour,
            "snapshots": {n: dict(segs, alpha=1.0, time_s=t_total) for n in (3, 4, 5)},
        }

    alpha0 = ((max_detour_ratio - 1.0) / (detour - 1.0)) if detour > 1.0 else 0.5
    alpha0 = min(max(alpha0, 0.0), 1.0)

    lo, hi = 0.0, 1.0
    path_nodes, used_alpha = path_d, 0.0
    metric_bs = None
    snapshots = {}

    for step in range(ALPHA_SEARCH_MAX_STEPS):
        mid = alpha0 if step == 0 else (lo + hi) / 2
        w_list = engine._interp_weights_list(user_type, mid)
        if metric_bs is None:
            metric_bs = CCHMetric(engine.cch, w_list)
        else:
            metric_bs.reset(w_list)

        cand = engine._query(metric_bs, src_id, dst_id)
        if cand is not None:
            cand_dist = engine._path_dist_m(cand)
            if cand_dist / shortest_dist <= max_detour_ratio:
                lo, path_nodes, used_alpha = mid, cand, mid
            else:
                hi = mid
        else:
            hi = mid

        elapsed = time.perf_counter() - t0
        segs = _segments_summary(engine, path_nodes)
        snapshots[step + 1] = dict(segs, alpha=used_alpha, time_s=elapsed)

    return {
        "triggered": True, "shortest_dist": shortest_dist, "detour": detour,
        "snapshots": snapshots,
    }


def _segments_summary(engine, path_nodes):
    from routing.cch_engine import recalculate_path_slopes
    segs = recalculate_path_slopes(engine.G, path_nodes)
    total_len = sum(s["length_m"] for s in segs)
    if total_len <= 0:
        return {"dist_m": 0.0, "avg_slope_abs": 0.0}
    avg_slope = sum(abs(s["slope_pct"]) * s["length_m"] for s in segs) / total_len
    return {"dist_m": round(total_len, 1), "avg_slope_abs": round(avg_slope, 3)}


def main():
    print(f"[벤치마크] 그래프 로딩: {GEOJSON_PATH}")
    t0 = time.time()
    G = build_graph(GEOJSON_PATH)
    precompute_edge_costs(G)
    print(f"[벤치마크] 그래프 준비 완료 ({time.time()-t0:.0f}s, 노드 {G.number_of_nodes():,}개)")

    t0 = time.time()
    cache = os.path.splitext(GEOJSON_PATH)[0] + ".cchorder.pkl"
    engine = build_cch_engine(G, order_cache_path=cache)
    print(f"[벤치마크] CCH 준비 완료 ({time.time()-t0:.0f}s)")

    print("\n" + "=" * 70)
    for label, origin, dest in ROUTES:
        result = trace_route(engine, origin, dest, USER_TYPE)
        print(f"\n[{label}] {origin} -> {dest}")
        if result is None:
            print("  경사최적 경로 없음 (스킵)")
            continue
        print(f"  최단={result['shortest_dist']:.0f}m  우회율={result['detour']:.2f}x  "
              f"이진탐색 트리거={'예' if result['triggered'] else '아니오'}")
        if not result["triggered"]:
            print("  (트리거 안 됨 — steps 값과 무관하게 결과 동일)")
            continue
        for n in sorted(result["snapshots"]):
            s = result["snapshots"][n]
            print(f"    steps={n}: dist={s['dist_m']:>8.1f}m  "
                  f"avg|slope|={s['avg_slope_abs']:>5.2f}%  "
                  f"alpha={s['alpha']:.3f}  누적시간={s['time_s']:.2f}s")
    print("\n" + "=" * 70)


if __name__ == "__main__":
    main()
