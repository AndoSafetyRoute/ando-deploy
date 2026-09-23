"""
ALPHA_SEARCH_LOCAL_ENABLED(타원 부분그래프 + scipy dijkstra) 검증.

c08e73e 의 60콜 하네스(OD 6쌍 × 6유형, 당시 15건 트리거)와 같은 OD/유형으로
같은 프로세스에서 스위치 OFF(기존 CCH 루프) / ON(부분그래프)을 번갈아 돌려 비교한다.

합격 조건(트리거된 케이스 전부):
  1) ON 결과의 최종 우회율 ≤ MAX_DETOUR_RATIO (하나라도 깨지면 FAIL)
  2) 경로가 달라진 케이스는 avgSlope 같거나 감소 (증가가 하나라도 있으면 FAIL)
추가로 서울역→강남역의 부분그래프 스텝당 시간을 따로 잰다.

실행: cd backend && python -u scripts/alpha_local_validate.py
(라이브 서버와 별개로 그래프/CCH를 새로 로딩 — 메모리 ~8GB)
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import routing.cch_engine as ce
from config import GEOJSON_PATH, MAX_DETOUR_RATIO
from routing.graph import build_graph
from routing.cost import precompute_edge_costs
from routing.cch_engine import build_cch_engine

USER_TYPES = ["manual_wheelchair", "electric_wheelchair", "walker",
              "cane", "leg_injury", "elderly"]

# c08e73e alpha_probe.py 와 동일 (lon, lat)
OD_PAIRS = [
    ("서울역→이태원",     (126.9646, 37.5298), (126.9944, 37.5345)),
    ("시청→광화문",       (126.9784, 37.5665), (126.9769, 37.5759)),
    ("여의도→노량진",     (126.9245, 37.5215), (126.9425, 37.5138)),
    ("서울역→강남역",     (126.9707, 37.5547), (127.0276, 37.4979)),
    ("남산도서관→명동",   (126.9884, 37.5511), (126.9850, 37.5636)),
    ("용산→이태원(언덕)", (126.9660, 37.5300), (126.9942, 37.5340)),
]

SLOPE_EPS = 1e-9


def run(engine, o, d, ut, local: bool):
    ce.ALPHA_SEARCH_LOCAL_ENABLED = local
    t0 = time.perf_counter()
    r = engine.find_route(o, d, ut)
    dt = time.perf_counter() - t0
    detour = r["total_length_m"] / r["shortest_dist_m"] if r["shortest_dist_m"] > 0 else 1.0
    return r, detour, dt


def main():
    t0 = time.time()
    G = build_graph(GEOJSON_PATH)
    precompute_edge_costs(G)
    engine = build_cch_engine(G, order_cache_path=os.path.splitext(GEOJSON_PATH)[0] + ".cchorder.pkl")
    print(f"\n[load] {time.time() - t0:.0f}s\n", flush=True)

    rows, fails = [], []
    for name, o, d in OD_PAIRS:
        for ut in USER_TYPES:
            r0, det0, dt0 = run(engine, o, d, ut, local=False)
            r1, det1, dt1 = run(engine, o, d, ut, local=True)
            same = r0["path_nodes"] == r1["path_nodes"]
            ds = r1["avg_slope_pct"] - r0["avg_slope_pct"]
            rows.append((name, ut, r0, r1, det0, det1, dt0, dt1, same, ds))
            if det1 > MAX_DETOUR_RATIO + 1e-9:
                fails.append(f"우회율 초과 {name}/{ut}: {det1:.3f}")
            if not same and ds > SLOPE_EPS:
                fails.append(f"avgSlope 증가 {name}/{ut}: {r0['avg_slope_pct']:.3f}→{r1['avg_slope_pct']:.3f}")
            print(f"{name:<14} {ut:<20} a {r0['used_alpha']:.3f}→{r1['used_alpha']:.3f}  "
                  f"dist {r0['total_length_m']:7.1f}→{r1['total_length_m']:7.1f}  "
                  f"slope {r0['avg_slope_pct']:5.2f}→{r1['avg_slope_pct']:5.2f}  "
                  f"detour {det0:.3f}→{det1:.3f}  {'SAME' if same else 'DIFF'}  "
                  f"time {dt0:5.2f}s→{dt1:5.2f}s", flush=True)

    trig = [x for x in rows if x[2]["used_alpha"] not in (0.0, 1.0) or x[3]["used_alpha"] not in (0.0, 1.0)]
    print("\n" + "=" * 90)
    print(f"전체 {len(rows)}콜, 이진탐색 트리거(OFF 또는 ON에서 0<alpha<1) {len(trig)}건")
    diff = [x for x in trig if not x[8]]
    print(f"  경로 동일 {len(trig) - len(diff)}건 / 달라짐 {len(diff)}건")
    for name, ut, r0, r1, det0, det1, dt0, dt1, same, ds in diff:
        print(f"   - {name}/{ut}: slope {r0['avg_slope_pct']:.3f}→{r1['avg_slope_pct']:.3f} "
              f"({ds:+.3f})  dist {r0['total_length_m']:.1f}→{r1['total_length_m']:.1f}  "
              f"alpha {r0['used_alpha']:.3f}→{r1['used_alpha']:.3f}")
    if trig:
        t_off = sum(x[6] for x in trig) / len(trig)
        t_on = sum(x[7] for x in trig) / len(trig)
        print(f"  트리거 케이스 평균 find_route: OFF {t_off:.2f}s → ON {t_on:.2f}s")
    print("판정:", "PASS" if not fails else "FAIL")
    for f in fails:
        print("  ✗", f)

    # 장거리 스텝당 시간 (서울역→강남역, manual_wheelchair)
    print("\n== 장거리 스텝당 시간: 서울역→강남역 ==")
    _, o, d = OD_PAIRS[3]
    src, dst = engine._nearest_id(*o), engine._nearest_id(*d)
    S = engine._path_dist_m(engine._query(engine.metric_dist, src, dst))
    t = time.perf_counter()
    sub = engine._local_alpha_subgraph(src, dst, "manual_wheelchair",
                                       MAX_DETOUR_RATIO * S * ce.ALPHA_SEARCH_LOCAL_MARGIN)
    print(f"  부분그래프 구성 {(time.perf_counter() - t) * 1000:.0f}ms  "
          f"노드 {len(sub['nodes']):,} 엣지 {sub['n_edges']:,}")
    for a in (0.8, 0.4, 0.6, 0.5, 0.55):
        t = time.perf_counter()
        engine._local_alpha_query(sub, a)
        print(f"  step alpha={a:.2f}: {(time.perf_counter() - t) * 1000:.0f}ms")


if __name__ == "__main__":
    main()
