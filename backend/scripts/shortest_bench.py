"""
최단경로 2종(CCH vs NetworkX Dijkstra) 라우팅 효율 비교.

실행 중인 서버(/route candidates=compare)를 여러 OD 쌍으로 호출하고
routingComparison 계측값(query_ms / nodes_settled / edges_relaxed / peak_heap)을
모아 표로 출력한다.

서버는 SHORTEST_NX_MAX_KM 를 크게(예: 50) 설정해 띄워야 장거리 NX 도 측정된다.

  python scripts/shortest_bench.py [BASE_URL] [--reps N]
"""
import json
import statistics
import sys
import time
import urllib.request

BASE_URL = "http://localhost:5000"
REPS = 5

# 서울 실좌표 OD 쌍 — 직선거리 오름차순
OD_PAIRS = [
    ("서울역→숙대입구",     (126.9723, 37.5547), (126.9668, 37.5450)),
    ("서울역→이태원",       (126.9646, 37.5298), (126.9944, 37.5345)),
    ("시청→광화문",         (126.9784, 37.5665), (126.9769, 37.5759)),
    ("여의도→노량진",       (126.9245, 37.5215), (126.9425, 37.5138)),
    ("강남역→역삼역",       (127.0276, 37.4979), (127.0364, 37.5006)),
    ("서울역→강남역",       (126.9707, 37.5547), (127.0276, 37.4979)),
    ("홍대입구→왕십리",     (126.9236, 37.5570), (127.0378, 37.5613)),
    ("잠실→구로디지털",     (127.1000, 37.5133), (126.9015, 37.4853)),
]


def call(origin, dest, user_type="manual_wheelchair"):
    body = json.dumps({
        "origin_lon": origin[0], "origin_lat": origin[1],
        "dest_lon": dest[0], "dest_lat": dest[1],
        "user_type": user_type, "candidates": "compare",
    }).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/route", data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    wall_ms = (time.perf_counter() - t0) * 1000
    return data, wall_ms


def main():
    global BASE_URL, REPS
    args = sys.argv[1:]
    if args and not args[0].startswith("--"):
        BASE_URL = args[0]
        args = args[1:]
    if "--reps" in args:
        REPS = int(args[args.index("--reps") + 1])

    print(f"BASE_URL={BASE_URL}  reps={REPS}\n")
    hdr = (f"{'OD':<18}{'straight':>9}{'cch_ms':>9}{'nx_ms':>10}{'speedup':>9}"
           f"{'nx_settled':>12}{'nx_relax':>11}{'nx_peakheap':>13}"
           f"{'cch_len':>9}{'nx_len':>9}{'same':>6}")
    print(hdr)
    print("-" * len(hdr))

    for name, o, d in OD_PAIRS:
        cch_ms, nx_ms = [], []
        rc_last = None
        try:
            for _ in range(REPS):
                data, _ = call(o, d)
                rc = data.get("routingComparison") or {}
                rc_last = rc
                sc, sn = rc.get("shortest_cch", {}), rc.get("shortest_nx", {})
                if "query_ms" in sc:
                    cch_ms.append(sc["query_ms"])
                if "query_ms" in sn:
                    nx_ms.append(sn["query_ms"])
        except Exception as e:
            print(f"{name:<18} ERROR {e}")
            continue

        rc = rc_last or {}
        sc, sn = rc.get("shortest_cch", {}), rc.get("shortest_nx", {})
        ec = rc.get("engine_compare", {})
        straight = rc.get("od_straight_m", 0) / 1000
        cch_med = statistics.median(cch_ms) if cch_ms else float("nan")
        nx_med = statistics.median(nx_ms) if nx_ms else float("nan")
        speed = (nx_med / cch_med) if (cch_ms and nx_ms and cch_med) else float("nan")
        nx_settled = sn.get("nodes_settled", "-")
        nx_relax = sn.get("edges_relaxed", "-")
        nx_peak = sn.get("peak_heap", "-")
        cch_len = sc.get("length_m", "-")
        nx_len = sn.get("length_m", sn.get("skipped", "-"))
        same = ec.get("paths_identical", "-")

        def _f(x):
            return f"{x:.1f}" if isinstance(x, float) else str(x)

        print(f"{name:<18}{straight:>8.1f}k{_f(cch_med):>9}{_f(nx_med):>10}"
              f"{_f(speed):>9}{str(nx_settled):>12}{str(nx_relax):>11}"
              f"{str(nx_peak):>13}{str(cch_len):>9}{str(nx_len):>9}{str(same):>6}")

    print("\n* cch_ms / nx_ms = 서버측 perf_counter 로 잰 순수 쿼리 시간의 중앙값(reps)")
    print("* nx_settled = NX Dijkstra 가 확정(pop)한 노드 수  /  nx_relax = 엣지 완화 시도 수")
    print("* CCH 는 방문 노드 수를 C 확장에서 안 주므로 path_nodes 로만 관측 (engine_compare)")


if __name__ == "__main__":
    main()
