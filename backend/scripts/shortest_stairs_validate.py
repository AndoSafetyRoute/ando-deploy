"""
SHORTEST_AVOID_STAIRS("최단 거리" 카드 계단 회피) 검증.
같은 프로세스에서 순수 거리 최단(avoid_stairs=False) vs 계단 회피(True) 비교.

  - OD 6쌍(alpha_local_validate) + 회귀 픽스처 + 서울 도심 무작위 300쌍
  - 합격: 계단 없던 경로는 동일 길이(불필요한 우회 0), 회피 결과 계단 m ≤ 순수,
          계단 회피로 늘어난 거리 분포 보고
실행: cd backend/scripts && python -u shortest_stairs_validate.py [regression.json]
"""
import contextlib
import io
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import GEOJSON_PATH
from routing.graph import build_graph
from routing.cost import precompute_edge_costs
from routing.cch_engine import build_cch_engine
from alpha_local_validate import OD_PAIRS


def stairs_m(G, path):
    return sum(G[u][v]["length_m"] for u, v in zip(path, path[1:])
               if G.has_edge(u, v) and G[u][v].get("highway") == "steps")


def main():
    t0 = time.time()
    G = build_graph(GEOJSON_PATH)
    precompute_edge_costs(G)
    eng = build_cch_engine(G, order_cache_path=os.path.splitext(GEOJSON_PATH)[0] + ".cchorder.pkl")
    print(f"\n[load] {time.time() - t0:.0f}s\n", flush=True)

    ods = [(n, o, d) for n, o, d in OD_PAIRS]
    if len(sys.argv) > 1:
        for c in json.load(open(sys.argv[1], encoding="utf-8"))["cases"]:
            ods.append((c["id"], tuple(c["origin"]), tuple(c["dest"])))
    rng = np.random.default_rng(1)
    for i in range(300):   # 도심 bbox 무작위 (0.5~5km)
        o = (rng.uniform(126.90, 127.08), rng.uniform(37.49, 37.60))
        d = (o[0] + rng.uniform(-0.04, 0.04), o[1] + rng.uniform(-0.03, 0.03))
        ods.append((f"rand{i}", o, d))

    fails, rows = [], []
    for name, o, d in ods:
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                a = eng.find_distance_route(o, d)
                b = eng.find_distance_route(o, d, avoid_stairs=True)
        except Exception:
            continue
        sa, sb = stairs_m(G, a["path_nodes"]), stairs_m(G, b["path_nodes"])
        la, lb = a["total_length_m"], b["total_length_m"]
        rows.append((name, la, lb, sa, sb))
        if sa == 0 and abs(lb - la) > 0.5:
            fails.append(f"계단 없던 경로 길이 변화 {name}: {la:.0f}→{lb:.0f}")
        if sb > sa + 1e-6:
            fails.append(f"계단 증가 {name}: {sa:.0f}→{sb:.0f}")
        if not name.startswith("rand") or sa > 0:
            print(f"{name:<32} 거리 {la:7.0f}→{lb:7.0f}m ({lb/la:5.3f}x)  계단 {sa:5.0f}→{sb:5.0f}m", flush=True)

    had = [r for r in rows if r[3] > 0]
    ratios = np.array([r[2] / r[1] for r in had]) if had else np.array([1.0])
    print("\n" + "=" * 80)
    print(f"유효 {len(rows)}쌍, 순수 최단에 계단 있던 쌍 {len(had)} ({len(had)/len(rows)*100:.1f}%)")
    print(f"계단 합 {sum(r[3] for r in rows):.0f}m → {sum(r[4] for r in rows):.0f}m, "
          f"회피 후에도 계단 남은 쌍 {sum(1 for r in rows if r[4] > 0)}")
    print(f"계단 있던 쌍의 거리 증가 배율: p50 {np.percentile(ratios,50):.3f}  p90 {np.percentile(ratios,90):.3f}  "
          f"max {ratios.max():.3f}  (>1.3x {int((ratios > 1.3).sum())}쌍)")
    print("RESULT:", "PASS" if not fails else "FAIL")
    for f in fails:
        print("  -", f)


if __name__ == "__main__":
    main()
