"""
유형별(find_route) 계단 회피 검증 — alpha 보간/기준선을 순수 거리 → 계단 회피 거리로
바꾼 수정(cch_engine.build_cch_engine interp_dist_wf / metric_base) 전후 비교.
같은 프로세스에서 엔진 1회 로드 후 기준 배열만 바꿔 끼워 OLD/NEW 를 같은 OD 로 돌린다.

계단 = OSM 원본 highway=='steps' 엣지(경사 기준 아님).

합격 기준:
  - NEW 계단 m ≤ OLD 계단 m (모든 쌍), NEW 에 계단이 남는 건 계단 없이는 못 가는 경우뿐
    (= 계단 회피 최단에도 계단이 있는 쌍)
  - NEW 우회율(유형별 / 계단 회피 최단) ≤ MAX_DETOUR_RATIO
  - OLD 에 계단이 없던 쌍의 길이 증가 분포 보고(불필요한 우회 여부)
실행: cd backend && python -u scripts/type_stairs_validate.py [regression.json]
"""
import contextlib
import io
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import GEOJSON_PATH, MAX_DETOUR_RATIO, STAIRS_PENALTY
from routing.graph import build_graph
from routing.cost import precompute_edge_costs
from routing.cch_engine import build_cch_engine
from alpha_local_validate import OD_PAIRS

USER_TYPES = ["elderly", "manual_wheelchair", "cane", "walker"]


def stairs_m(G, path):
    return sum(G[u][v]["length_m"] for u, v in zip(path, path[1:])
               if G.has_edge(u, v) and G[u][v].get("highway") == "steps")


def main():
    t0 = time.time()
    G = build_graph(GEOJSON_PATH)
    precompute_edge_costs(G)
    eng = build_cch_engine(G, order_cache_path=os.path.splitext(GEOJSON_PATH)[0] + ".cchorder.pkl")
    print(f"\n[load] {time.time() - t0:.0f}s\n", flush=True)

    # NEW = 빌드된 그대로. OLD = 순수 거리 배열/metric 으로 되돌린 상태.
    new_state = (eng._dist_wf, eng._slope_minus_dist, eng._metric_base)
    old_dist = np.where(eng._edge_stairs, eng._dist_wf / STAIRS_PENALTY, eng._dist_wf)
    old_state = (old_dist,
                 {ut: sw - old_dist for ut, sw in eng._slope_wf.items()},
                 eng.metric_dist)

    def set_state(st):
        eng._dist_wf, eng._slope_minus_dist, eng._metric_base = st

    ods = [(n, o, d) for n, o, d in OD_PAIRS]
    ods.append(("서울역→남산도서관(발견)", (126.9707, 37.5547), (126.9818, 37.5530)))
    if len(sys.argv) > 1:
        for c in json.load(open(sys.argv[1], encoding="utf-8"))["cases"]:
            ods.append((c["id"], tuple(c["origin"]), tuple(c["dest"])))
    rng = np.random.default_rng(1)
    for i in range(150):   # 도심 bbox 무작위 (0.5~5km)
        o = (rng.uniform(126.90, 127.08), rng.uniform(37.49, 37.60))
        d = (o[0] + rng.uniform(-0.04, 0.04), o[1] + rng.uniform(-0.03, 0.03))
        ods.append((f"rand{i}", o, d))

    rows, fails = [], []
    t1 = time.time()
    for name, o, d in ods:
        for ut in USER_TYPES:
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    set_state(old_state)
                    a = eng.find_route(o, d, ut)
                    set_state(new_state)
                    b = eng.find_route(o, d, ut)
                    ns = eng.find_distance_route(o, d, avoid_stairs=True)
            except Exception:
                set_state(new_state)
                continue
            sa, sb = stairs_m(G, a["path_nodes"]), stairs_m(G, b["path_nodes"])
            sns = stairs_m(G, ns["path_nodes"])
            la, lb, lns = a["total_length_m"], b["total_length_m"], ns["total_length_m"]
            det = lb / lns if lns > 0 else 1.0
            rows.append(dict(name=name, ut=ut, la=la, lb=lb, sa=sa, sb=sb, sns=sns,
                             det=det, same=a["path_nodes"] == b["path_nodes"],
                             slope_a=a["avg_slope_pct"], slope_b=b["avg_slope_pct"]))
            if sb > sa + 1e-6:
                fails.append(f"계단 증가 {name}/{ut}: {sa:.0f}→{sb:.0f}m")
            if sb > 0 and sns == 0:
                fails.append(f"계단 없는 길이 있는데 계단 남음 {name}/{ut}: {sb:.0f}m")
            if det > MAX_DETOUR_RATIO + 1e-6:
                fails.append(f"우회 한도 초과 {name}/{ut}: {det:.3f}x")
            if (sa > 0 or not name.startswith("rand")) and ut == "elderly":
                print(f"{name:<28} {ut:<18} 거리 {la:6.0f}→{lb:6.0f}m  계단 {sa:5.0f}→{sb:5.0f}m  "
                      f"우회 {det:4.2f}x  경사 {a['avg_slope_pct']:.2f}→{b['avg_slope_pct']:.2f}%", flush=True)
    set_state(new_state)

    R = rows
    had = [r for r in R if r["sa"] > 0]
    no_st = [r for r in R if r["sa"] == 0]
    changed_no_st = [r for r in no_st if not r["same"]]
    inc = np.array([r["lb"] / r["la"] for r in changed_no_st]) if changed_no_st else np.array([1.0])
    inc_had = np.array([r["lb"] / r["la"] for r in had]) if had else np.array([1.0])
    print("\n" + "=" * 90)
    print(f"유효 {len(R)}건 (OD {len(ods)} × 유형 {len(USER_TYPES)}), {time.time() - t1:.0f}s")
    print(f"OLD 유형별에 계단 있던 건 {len(had)} ({len(had) / max(len(R), 1) * 100:.1f}%)  "
          f"계단 합 {sum(r['sa'] for r in R):.0f}m → NEW {sum(r['sb'] for r in R):.0f}m")
    print(f"NEW 에 계단 남은 건 {sum(1 for r in R if r['sb'] > 0)} "
          f"(그중 계단 회피 최단에도 계단 있는 불가피 건 {sum(1 for r in R if r['sb'] > 0 and r['sns'] > 0)})")
    print(f"계단 있던 건 거리 배율 OLD→NEW: p50 {np.percentile(inc_had, 50):.3f}  "
          f"p90 {np.percentile(inc_had, 90):.3f}  max {inc_had.max():.3f}")
    print(f"계단 없던 건 {len(no_st)} 중 경로 바뀐 건 {len(changed_no_st)} "
          f"(거리 배율 p50 {np.percentile(inc, 50):.3f}  p90 {np.percentile(inc, 90):.3f}  "
          f"max {inc.max():.3f})")
    print(f"NEW 우회율(유형별/계단회피최단) max {max(r['det'] for r in R):.3f}  "
          f"(한도 {MAX_DETOUR_RATIO})")
    print("RESULT:", "PASS" if not fails else "FAIL")
    for f in fails[:40]:
        print("  -", f)


if __name__ == "__main__":
    main()
