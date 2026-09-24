"""
SNAP_ACCESSIBLE_ENABLED(계단 없는 주 네트워크 스냅) + ALPHA_SEARCH_LOCAL_LIMIT(dijkstra 상한)
+ 부분그래프 bbox 사전필터 검증. 같은 프로세스에서 스위치를 바꿔 가며 비교한다.

  A) OD 6쌍 × 6유형(alpha_local_validate 와 동일) — OFF(기존) vs ON: 계단 m·거리·우회율·스냅거리
  B) LIMIT 단독 동등성 — SNAP ON 고정, LIMIT OFF/ON 경로 비교(동비용 타이브레이크 외엔 동일해야)
  C) 회귀 픽스처(ando-BE ebb6fa1 tests/routing_regression.json) 기대거리 ±tol
  D) 무작위 3000점 스냅 변화율·추가 스냅거리 분포
  E) 동시성: 서울역→강남역 find_route 순차/5동시, LIMIT OFF/ON

합격: A 우회율 ≤ MAX_DETOUR_RATIO, A 계단 합 ON ≤ OFF, B 비용 동일, C 전부 범위 안.
실행: cd backend/scripts && python -u snap_limit_validate.py [regression.json]   (메모리 ~8GB)
"""
import contextlib
import io
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import routing.cch_engine as ce
from config import GEOJSON_PATH, MAX_DETOUR_RATIO
from routing.graph import build_graph
from routing.cost import precompute_edge_costs
from routing.cch_engine import build_cch_engine

from alpha_local_validate import OD_PAIRS, USER_TYPES
from concurrency_probe import par, seq


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def set_flags(snap, limit):
    ce.SNAP_ACCESSIBLE_ENABLED = snap
    ce.ALPHA_SEARCH_LOCAL_LIMIT = limit


def stairs_m(G, path):
    return sum(G[u][v]["length_m"] for u, v in zip(path, path[1:])
               if G.has_edge(u, v) and G[u][v].get("highway") == "steps")


def snap_dist(eng, lonlat):
    i = eng._nearest_id(*lonlat)
    x, y = lonlat[0] * eng._lon_to_m, lonlat[1] * eng._lat_to_m
    return float(np.hypot(eng._coords_m[i, 0] - x, eng._coords_m[i, 1] - y))


def main():
    reg_path = sys.argv[1] if len(sys.argv) > 1 else None
    t0 = time.time()
    G = build_graph(GEOJSON_PATH)
    precompute_edge_costs(G)
    eng = build_cch_engine(G, order_cache_path=os.path.splitext(GEOJSON_PATH)[0] + ".cchorder.pkl")
    print(f"\n[load] {time.time() - t0:.0f}s\n", flush=True)
    fails = []

    # ── A ──
    print("=== A. OD 6×6  OFF(기존) → ON(스냅+limit) ===")
    tot0 = tot1 = 0.0
    for name, o, d in OD_PAIRS:
        set_flags(False, False); so0, sd0 = snap_dist(eng, o), snap_dist(eng, d)
        set_flags(True, True);   so1, sd1 = snap_dist(eng, o), snap_dist(eng, d)
        print(f"-- {name}: 스냅거리 출발 {so0:.1f}→{so1:.1f}m  도착 {sd0:.1f}→{sd1:.1f}m")
        for ut in USER_TYPES:
            set_flags(False, False)
            r0 = quiet(eng.find_route, o, d, ut)
            set_flags(True, True)
            r1 = quiet(eng.find_route, o, d, ut)
            s0, s1 = stairs_m(G, r0["path_nodes"]), stairs_m(G, r1["path_nodes"])
            tot0 += s0; tot1 += s1
            det1 = r1["total_length_m"] / r1["shortest_dist_m"]
            if det1 > MAX_DETOUR_RATIO + 1e-9:
                fails.append(f"A 우회율 초과 {name}/{ut} {det1:.3f}")
            print(f"   {ut:<20} dist {r0['total_length_m']:6.0f}→{r1['total_length_m']:6.0f}  "
                  f"최단 {r0['shortest_dist_m']:6.0f}→{r1['shortest_dist_m']:6.0f}  "
                  f"계단 {s0:4.0f}→{s1:4.0f}m  slope {r0['avg_slope_pct']:5.2f}→{r1['avg_slope_pct']:5.2f}  "
                  f"detour {r0['total_length_m']/r0['shortest_dist_m']:.3f}→{det1:.3f}  "
                  f"a {r0['used_alpha']:.3f}→{r1['used_alpha']:.3f}", flush=True)
    print(f"계단 합계 {tot0:.0f}m → {tot1:.0f}m")
    if tot1 > tot0 + 1e-6:
        fails.append(f"A 계단 합 증가 {tot0:.0f}→{tot1:.0f}")

    # ── B ──
    print("\n=== B. LIMIT 동등성 (SNAP ON) ===")
    same = diff_eq = 0
    for name, o, d in OD_PAIRS:
        for ut in USER_TYPES:
            set_flags(True, False); ra = quiet(eng.find_route, o, d, ut)
            set_flags(True, True);  rb = quiet(eng.find_route, o, d, ut)
            if ra["path_nodes"] == rb["path_nodes"]:
                same += 1
            elif abs(ra["total_length_m"] - rb["total_length_m"]) < 1e-6 or ra["used_alpha"] == rb["used_alpha"]:
                diff_eq += 1
                print(f"   경로 다름(같은 alpha) {name}/{ut}: {ra['total_length_m']:.1f} vs {rb['total_length_m']:.1f}")
            else:
                fails.append(f"B 결과 다름 {name}/{ut}")
    print(f"동일 {same}/36, 동alpha 다른경로 {diff_eq}")

    # ── C ──
    if reg_path:
        print("\n=== C. 회귀 픽스처 ===")
        cases = json.load(open(reg_path, encoding="utf-8"))["cases"]
        for c in cases:
            for prof, exp in (c.get("expected") or {}).items():
                if not exp or exp.get("m") is None:
                    continue
                out = []
                for flag in (False, True):
                    set_flags(flag, flag)
                    try:
                        r = (quiet(eng.find_distance_route, tuple(c["origin"]), tuple(c["dest"]))
                             if prof == "distance"
                             else quiet(eng.find_route, tuple(c["origin"]), tuple(c["dest"]), prof))
                        out.append(r["total_length_m"])
                    except Exception as e:
                        out.append(float("nan"))
                lo, hi = exp["m"] * (1 - exp["tol"]), exp["m"] * (1 + exp["tol"])
                ok = lo <= out[1] <= hi
                if not ok:
                    fails.append(f"C 범위밖 {c['id']}/{prof}: {out[1]:.0f} (기대 {exp['m']}±{exp['tol']})")
                print(f"   {c['id']:<28} {prof:<18} 기대 {exp['m']:6.0f}  OFF {out[0]:6.0f}  ON {out[1]:6.0f}  "
                      f"{'OK' if ok else 'FAIL'}")

    # ── D ──
    print("\n=== D. 무작위 3000점 스냅 변화 ===")
    rng = np.random.default_rng(0)
    xy = eng._coords_m
    pick = rng.choice(len(xy), 3000, replace=False)
    pts = xy[pick] + rng.normal(0, 15, size=(3000, 2))   # 노드 주변 ±15m 임의점
    d_all, i_all = eng.tree.query(pts)
    d_acc, k_acc = eng._acc_tree.query(pts)
    changed = eng._acc_ids[k_acc] != i_all
    capped = (d_acc - d_all) > ce.SNAP_ACCESSIBLE_MAX_EXTRA_M
    print(f"상한 {ce.SNAP_ACCESSIBLE_MAX_EXTRA_M:.0f}m 초과로 기존 스냅 유지: {int((changed & capped).sum())}건")
    extra = (d_acc - d_all)[changed]
    print(f"스냅 바뀐 점 {changed.sum()}/3000 ({changed.mean()*100:.1f}%)")
    if changed.any():
        print(f"추가 스냅거리 p50 {np.percentile(extra,50):.1f}m  p90 {np.percentile(extra,90):.1f}m  "
              f"p99 {np.percentile(extra,99):.1f}m  max {extra.max():.1f}m")
        print(f"추가 >30m {int((extra > 30).sum())}건, >100m {int((extra > 100).sum())}건")

    # ── E ──
    print("\n=== E. 동시성 (서울역→강남역 manual_wheelchair) ===")
    O, D, UT = (126.9707, 37.5547), (127.0276, 37.4979), "manual_wheelchair"
    # 주의: redirect_stdout 은 스레드 안전하지 않아(전역 sys.stdout 교체) 여기선 안 쓴다.
    for limit in (False, True):
        set_flags(True, limit)
        fn = lambda: eng.find_route(O, D, UT)
        s = seq(fn); wall, each = par(fn)
        print(f"[E] LIMIT={limit!s:<5}  순차 {s:.3f}s   5동시 벽시계 {wall:.3f}s  요청당 {each:.3f}s")

    set_flags(True, True)
    print("\nRESULT:", "PASS" if not fails else "FAIL")
    for f in fails:
        print("  -", f)


if __name__ == "__main__":
    main()
