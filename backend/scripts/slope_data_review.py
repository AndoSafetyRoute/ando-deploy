"""
경사도 데이터 검토 — 지도 색(zone) 완화 방법(A/B/C/D) 중 무엇이 타당한지 근거를 만든다.

읽기 전용 분석 스크립트. road_5m_slope.geojson(5m 밀집화, DEM 3m 픽셀, ±2 이동평균
평활 = 20m 등가, ±60% 클립)의 signed slope_pct 분포와 "노이즈로 보이는 값"의 비중을
살펴, 지도에 뜨는 warning/forbidden 비율이 실제보다 부풀려져 있는지 정량화한다.

실행:  python scripts/slope_data_review.py
"""
import json
import statistics
from collections import defaultdict

import numpy as np

from routing.cost import USER_TYPES, classify_zone
from config import GEOJSON_PATH, FLAT_THRESHOLD

PHYS_MAX_PLAUSIBLE = 25.0   # 보행로에서 "일반적인 최대" 체감 경사(%) — 그 이상은 계단/DEM오차 의심


def load(path):
    with open(path, encoding="utf-8") as f:
        gj = json.load(f)
    feats = gj["features"]
    slope = np.array([f["properties"]["slope_pct"] for f in feats], dtype=np.float64)
    length = np.array([f["properties"].get("length_m", 5.0) for f in feats], dtype=np.float64)
    name = [f["properties"].get("name") or "" for f in feats]
    return slope, length, name, feats


def pct_table(slope, length):
    print("\n[분포] signed slope_pct (엣지 단위, n={:,})".format(len(slope)))
    qs = [0, 0.1, 1, 5, 25, 50, 75, 95, 99, 99.9, 100]
    for q in qs:
        print(f"   p{q:<5} = {np.percentile(slope, q):+7.2f}%")
    print(f"   mean={slope.mean():+.2f}  std={slope.std():.2f}  |mean|(abs)={np.abs(slope).mean():.2f}")

    order = np.argsort(slope)
    cs = np.cumsum(length[order]) / length.sum()
    print("\n[분포] 길이가중 (실제 보행 노출 기준)")
    for q in [0.001, 0.01, 0.1, 0.5, 0.9, 0.99, 0.999]:
        idx = min(np.searchsorted(cs, q), len(order) - 1)
        print(f"   p{q*100:<6} = {slope[order][idx]:+7.2f}%")

    for thr in (10, 15, 20, 25, 30, 40, 50):
        frac_n = float((np.abs(slope) > thr).mean())
        frac_len = float(length[np.abs(slope) > thr].sum() / length.sum())
        print(f"   |g|>{thr:>2}% : 엣지 {frac_n*100:6.3f}%   길이 {frac_len*100:6.3f}%")


def noise_signature(slope, length, name):
    """
    같은 도로(name) 안에서 인접 엣지끼리 slope 변화가 얼마나 튀는지 본다.
    실제 경사(언덕)는 이웃 엣지와 값이 비슷하게 이어지고(스무스), DEM 노이즈는
    이웃과 무관하게 툭 튄다(짧은 baseline에서 수직오차가 증폭됨). "이웃과의 차이가
    자기 자신의 절댓값보다 큰" 엣지 비율로 이를 근사 측정한다.
    """
    by_road = defaultdict(list)
    for i, nm in enumerate(name):
        by_road[nm].append(i)

    spike_flags = np.zeros(len(slope), dtype=bool)
    neighbor_diff = []
    for nm, idxs in by_road.items():
        if len(idxs) < 3:
            continue
        s = slope[idxs]
        for k in range(1, len(idxs) - 1):
            neigh_mean = (s[k - 1] + s[k + 1]) / 2.0
            diff = abs(s[k] - neigh_mean)
            neighbor_diff.append(diff)
            # "스파이크" 근사 정의: 이웃 평균과 15%p 이상 벌어지고, 자기 절댓값이
            # 이웃 절댓값 평균의 2배 이상 — 언덕의 완만한 변화가 아니라 국소 튐.
            neigh_abs = (abs(s[k - 1]) + abs(s[k + 1])) / 2.0
            if diff > 15.0 and abs(s[k]) > 2 * max(neigh_abs, 1e-6):
                spike_flags[idxs[k]] = True

    nd = np.array(neighbor_diff)
    print(f"\n[노이즈 근사] 도로명 내 인접-이웃 slope 차이 (n={len(nd):,})")
    print(f"   median={np.median(nd):.2f}%p  p90={np.percentile(nd,90):.2f}%p  p99={np.percentile(nd,99):.2f}%p")
    print(f"   국소 스파이크로 분류된 엣지: {spike_flags.sum():,} / {len(slope):,} "
          f"({100*spike_flags.mean():.3f}%)")

    # |g| > PHYS_MAX_PLAUSIBLE 인 엣지 중 스파이크 비율
    steep = np.abs(slope) > PHYS_MAX_PLAUSIBLE
    if steep.sum() > 0:
        print(f"   |g|>{PHYS_MAX_PLAUSIBLE}% 엣지 {steep.sum():,}개 중 스파이크 판정 "
              f"{spike_flags[steep].sum():,}개 ({100*spike_flags[steep].mean():.1f}%)")
    return spike_flags


def zone_breakdown(slope, length, label, scale=1.0, margin=1.0):
    """
    scale: A안 근사 — slope_pct 자체를 scale배(<1이면 완화)한 뒤 분류.
    margin: B안 근사 — g_opt/g_warn 임계값을 margin배(>1이면 완화)해서 분류.
    """
    g = slope * scale
    for ut in ("elderly", "manual_wheelchair"):
        counts = defaultdict(float)
        len_counts = defaultdict(float)
        for gi, li in zip(g, length):
            if abs(gi) < FLAT_THRESHOLD:
                direction = "flat"
            else:
                direction = "up" if gi > 0 else "down"

            if direction == "flat":
                zone = "flat"
            else:
                th = USER_TYPES[ut][direction]
                g_abs = abs(gi)
                if g_abs <= th["g_opt"] * margin:
                    zone = "optimal"
                elif g_abs <= th["g_warn"] * margin:
                    zone = "warning"
                else:
                    zone = "forbidden"
            counts[zone] += 1
            len_counts[zone] += li

        total_n = sum(counts.values())
        total_l = sum(len_counts.values())
        print(f"   [{label}] user_type={ut}")
        for z in ("flat", "optimal", "warning", "forbidden"):
            print(f"      {z:<10} 엣지 {100*counts[z]/total_n:6.2f}%   길이 {100*len_counts[z]/total_l:6.2f}%")


def main():
    print(f"[review] GEOJSON_PATH = {GEOJSON_PATH}")
    slope, length, name, feats = load(GEOJSON_PATH)

    pct_table(slope, length)
    spike_flags = noise_signature(slope, length, name)

    print("\n" + "=" * 70)
    print("현재(보정 없음) zone 분포")
    print("=" * 70)
    zone_breakdown(slope, length, "현재(scale=1.0, margin=1.0)")

    print("\n" + "=" * 70)
    print("A안 근사 — slope 자체를 scale배")
    print("=" * 70)
    for scale in (0.9, 0.8, 0.7):
        zone_breakdown(slope, length, f"scale={scale}", scale=scale)

    print("\n" + "=" * 70)
    print("B안 근사 — 임계값(g_opt/g_warn)을 margin배")
    print("=" * 70)
    for margin in (1.15, 1.25, 1.4):
        zone_breakdown(slope, length, f"margin={margin}", margin=margin)

    print("\n" + "=" * 70)
    print("스파이크(국소 DEM노이즈 의심) 제외 시 zone 분포 (elderly만)")
    print("=" * 70)
    clean = ~spike_flags
    zone_breakdown(slope[clean], length[clean], "스파이크 제외")


if __name__ == "__main__":
    main()
