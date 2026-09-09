"""
CCH 실동작 확인 + 9.2절 실측(1,2,3,5) + Q&A #3 경사 분포.
용산 5m 그래프로 FastAPI 없이 routing/ 모듈만 import 해서 측정한다.

사용:  GEOJSON_PATH=<...>/data/road_5m_slope.geojson python scripts/pers_cch_probe.py
"""
import os
import sys
import time
import tracemalloc

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import GEOJSON_PATH, BASIS_G_MIN, BASIS_G_MAX
from routing.graph import build_graph
from routing.cch_engine import build_cch_engine


def main():
    print(f"[probe] GEOJSON_PATH = {GEOJSON_PATH}")
    t0 = time.time()
    G = build_graph(GEOJSON_PATH)
    print(f"[probe] graph: nodes={G.number_of_nodes():,} edges={G.number_of_edges():,} "
          f"({time.time()-t0:.1f}s)")

    # ── Q&A #3: 그래프에 존재하는 signed slope_pct 분포 ──────────────────────
    slopes = np.array([d.get("slope_pct", 0.0) for _, _, d in G.edges(data=True)],
                      dtype=np.float64)
    lengths = np.array([d.get("length_m", 1.0) for _, _, d in G.edges(data=True)],
                       dtype=np.float64)
    pct = [0, 0.01, 0.1, 1, 5, 50, 95, 99, 99.9, 99.99, 100]
    qs = np.percentile(slopes, pct)
    print("\n[Q&A#3] signed slope_pct 분포 (엣지 단위)")
    for p, q in zip(pct, qs):
        print(f"   p{p:<6} = {q:+.2f}%")
    print(f"   min={slopes.min():+.2f}  max={slopes.max():+.2f}  "
          f"|g|>{BASIS_G_MAX}% 엣지수={int((np.abs(slopes) > BASIS_G_MAX).sum()):,} "
          f"({100*(np.abs(slopes) > BASIS_G_MAX).mean():.4f}%)")
    # 길이 가중 분포도 (실제 보행 노출 기준)
    order = np.argsort(slopes)
    cs = np.cumsum(lengths[order]) / lengths.sum()
    for target in (0.001, 0.01, 0.5, 0.99, 0.999):
        idx = np.searchsorted(cs, target)
        idx = min(idx, len(order) - 1)
        print(f"   길이가중 p{target*100:<5} = {slopes[order][idx]:+.2f}%")

    # ── CCH 실동작 ────────────────────────────────────────────────────────────
    print("\n[probe] build_cch_engine ...")
    tc = time.time()
    try:
        eng = build_cch_engine(G)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"\n[probe] !!! CCH 빌드 실패: {e}")
        return
    print(f"[probe] CCH 엔진 OK ({time.time()-tc:.1f}s)")

    # 노드 2개 뽑아 라우팅
    nodes = list(G.nodes())
    src = G.nodes[nodes[0]]
    dst = G.nodes[nodes[len(nodes)//2]]
    o = (src["lon"], src["lat"])
    d = (dst["lon"], dst["lat"])
    for name, fn in [
        ("find_route(elderly)", lambda: eng.find_route(o, d, "elderly")),
        ("find_distance_route", lambda: eng.find_distance_route(o, d)),
    ]:
        try:
            r = fn()
            print(f"[probe] {name}: nodes={len(r['path_nodes'])} "
                  f"len={r['total_length_m']:.0f}m avg|g|={r['avg_slope_pct']:.2f}%")
        except Exception as e:
            print(f"[probe] {name} 실패: {e}")

    # ── 9.2절 #1 CCHMetric 메모리 / #5 축약 아크 수 / #2 reset 시간 / #3 numpy ─
    from routingkit_cch import CCHMetric
    import gc
    import psutil
    proc = psutil.Process()
    m = G.number_of_edges()
    w = np.maximum(1, (np.random.rand(m) * 5000)).astype(np.int64).tolist()

    gc.collect()
    rss0 = proc.memory_info().rss
    metrics_hold = [CCHMetric(eng.cch, w) for _ in range(5)]   # 5개 만들어 1개당 추정
    gc.collect()
    rss1 = proc.memory_info().rss
    per_metric_mb = (rss1 - rss0) / 5 / 1e6
    print(f"\n[9.2#1] CCHMetric 1개당 RSS 증가분 ~= {per_metric_mb:.1f} MB "
          f"(용산 5m, m={m:,}). 서울 10m 는 엣지 비례로 추정 "
          f"(>200MB 면 문서 7.5 재순위 검토)")
    metric = metrics_hold[0]   # reset 테스트용 1개는 살려둔다

    # #5 축약 그래프 아크 수 (기저 배열 크기 산정)
    for attr in ("num_arcs", "arc_count", "num_edges", "m"):
        if hasattr(eng.cch, attr):
            print(f"[9.2#5] cch.{attr} = {getattr(eng.cch, attr)}")
    print(f"[9.2#5] 원본 아크 수 m = {m:,}  →  기저배열(sparse csr) nnz "
          f"= {eng.basis_weights.nnz:,}  ({eng.basis_weights.nnz*12/1e6:.1f} MB 근사)")

    # #2 reset() 순수 시간
    try:
        w2 = np.maximum(1, (np.random.rand(m) * 5000)).astype(np.int64).tolist()
        tr = time.time()
        metric.reset(w2)
        dt = time.time() - tr
        print(f"[9.2#2] CCHMetric.reset(list) 1회 = {dt*1000:.1f} ms")
    except Exception as e:
        print(f"[9.2#2] reset(list) 실패: {e}")

    # #3 numpy 배열 직접 전달 가능 여부
    for kind, arr in [
        ("np.int64", np.maximum(1, np.random.rand(m) * 5000).astype(np.int64)),
        ("np.uint32", np.maximum(1, np.random.rand(m) * 5000).astype(np.uint32)),
        ("np.int32", np.maximum(1, np.random.rand(m) * 5000).astype(np.int32)),
    ]:
        try:
            tr = time.time()
            metric.reset(arr)
            print(f"[9.2#3] reset({kind} ndarray) OK  {1000*(time.time()-tr):.1f} ms "
                  f"→ .tolist() 제거 가능")
        except Exception as e:
            print(f"[9.2#3] reset({kind} ndarray) 거부: {type(e).__name__}: {e}")

    print("\n[probe] 완료")


if __name__ == "__main__":
    main()
