"""
road_5m_slope.geojson 평활 검증 스크립트

실행:
  conda activate ando_route
  python scripts/verify_smoothing.py
  python scripts/verify_smoothing.py --compare data/road_5m_slope_raw.geojson

검증 항목:
  1. 한강변 평지 도로 (바운딩 박스) — 필터 오염 주의: stdev 수치 참고용
  2. 소월로 급경사 도로 (바운딩 박스) — 필터 오염 주의: 중앙값 참고용
  3. 전체 zone 분류 분포
  4. 도로명 기반 정밀 검증 (소월로/이촌로/반포로)
  5. [--compare 옵션] 평활 전후 stdev 비교

바운딩 박스 필터 한계:
  - 한강변 박스(HANGANG_BOX): 출입로·램프 포함으로 stdev가 높게 나올 수 있음
  - 소월로 박스(SOWOL_BOX): 소월로2길·소월로28길 등 지선 포함으로 중앙값 낮게 나올 수 있음
  → 도로명 기반 필터(검증 4)가 더 신뢰도 높은 결과를 제공함
"""
import argparse
import json
import statistics
from collections import Counter
from pathlib import Path

BASE_DIR  = Path(__file__).parent.parent
DATA_PATH = BASE_DIR / "data" / "road_5m_slope.geojson"
RAW_PATH  = BASE_DIR / "data" / "road_5m_slope_raw.geojson"

# ── 검증 구역 바운딩 박스 ─────────────────────────────────────────────────────
# 한강변 평지 (반포한강공원 ~ 이촌한강공원)
# 주의: 제방 경사로·출입로 포함 가능 → 참고용
HANGANG_BOX = dict(lon_min=126.960, lon_max=127.010, lat_min=37.510, lat_max=37.530)

# 소월로 (이태원 ~ 남산 방향 급경사 구간)
# 주의: 소월로 지선·이태원로 포함 가능 → 참고용
SOWOL_BOX   = dict(lon_min=126.982, lon_max=126.996, lat_min=37.535, lat_max=37.555)


def in_box(lon, lat, box) -> bool:
    return (box["lon_min"] <= lon <= box["lon_max"] and
            box["lat_min"] <= lat <= box["lat_max"])


def midpoint(feat) -> tuple:
    coords = feat["geometry"]["coordinates"]
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return sum(lons) / len(lons), sum(lats) / len(lats)


def classify(slope_pct: float) -> str:
    g = abs(slope_pct)
    if g < 1.0:   return "flat"
    if g < 5.0:   return "low"
    if g < 8.33:  return "mid"
    return "high"


def print_stats(label: str, slopes: list):
    if not slopes:
        print(f"  {label}: 데이터 없음")
        return
    abs_slopes = [abs(s) for s in slopes]
    stdev = statistics.stdev(slopes) if len(slopes) > 1 else 0.0
    print(f"  {label} ({len(slopes)}개 구간)")
    print(f"    mean={statistics.mean(slopes):+.2f}%  "
          f"median={statistics.median(slopes):+.2f}%  "
          f"stdev={stdev:.2f}%")
    print(f"    |slope| 중앙값={statistics.median(abs_slopes):.2f}%  "
          f"최대={max(abs_slopes):.2f}%")
    within_2 = sum(1 for s in abs_slopes if s <= 2.0)
    print(f"    |slope|≤2% 비율: {100*within_2/len(slopes):.1f}%")


def road_name_check(features: list):
    """도로명 기반 정밀 검증 — 바운딩 박스 오염 없음."""
    print("\n[검증 4] 도로명 기반 필터")

    # 소월로 (급경사 기준)
    sowol = [f["properties"]["slope_pct"]
             for f in features
             if "소월로" in (f["properties"].get("name") or "")
             and "소월로" == (f["properties"].get("name") or "").split()[0].rstrip("0123456789길")]
    if not sowol:
        # 정확 매칭 실패 시 포함 매칭으로 fallback
        sowol = [f["properties"]["slope_pct"]
                 for f in features
                 if (f["properties"].get("name") or "") == "소월로"]
    # name이 정확히 "소월로"인 것만
    sowol_exact = [f["properties"]["slope_pct"]
                   for f in features
                   if (f["properties"].get("name") or "") == "소월로"]
    sowol_all   = [f["properties"]["slope_pct"]
                   for f in features
                   if "소월로" in (f["properties"].get("name") or "")]

    for label, data in [("소월로(정확)", sowol_exact), ("소월로(포함)", sowol_all)]:
        if data:
            abs_s = [abs(s) for s in data]
            pct_steep = sum(1 for s in abs_s if s >= 8.0) / len(abs_s)
            ok = "✓" if pct_steep >= 0.20 else "✗"
            print(f"  {label} ({len(data)}개): "
                  f"|slope| 중앙값={statistics.median(abs_s):.2f}%  "
                  f"stdev={statistics.stdev(data) if len(data)>1 else 0:.2f}%  "
                  f"|slope|≥8% {100*pct_steep:.1f}% {ok}")

    # 한강변 도로 (평지 기준)
    for road in ["이촌로", "한강대로", "반포로", "강변북로"]:
        segs = [f["properties"]["slope_pct"]
                for f in features
                if (f["properties"].get("name") or "") == road]
        if segs:
            abs_s = [abs(s) for s in segs]
            pct_flat = sum(1 for s in abs_s if s <= 2.0) / len(segs)
            ok = "✓" if pct_flat >= 0.70 else "△"
            print(f"  {road} ({len(segs)}개): "
                  f"|slope| 중앙값={statistics.median(abs_s):.2f}%  "
                  f"stdev={statistics.stdev(segs) if len(segs)>1 else 0:.2f}%  "
                  f"|slope|≤2% {100*pct_flat:.1f}% {ok}")

    # 도로명 유무 및 상위 목록
    named = sum(1 for f in features if f["properties"].get("name"))
    print(f"\n  도로명 있는 구간: {named:,}/{len(features):,} ({100*named/len(features):.1f}%)")
    name_counts = Counter(f["properties"]["name"]
                          for f in features if f["properties"].get("name"))
    print("  도로명 상위 10개:")
    for name, cnt in name_counts.most_common(10):
        print(f"    {name}: {cnt}개")


def compare_smoothing(smoothed_path: Path, raw_path: Path):
    """평활 전후 stdev 비교 — SNR 개선 효과 정량화."""
    print(f"\n[검증 5] 평활 전후 비교")
    print(f"  평활: {smoothed_path.name}")
    print(f"  원본: {raw_path.name}")

    with open(smoothed_path, encoding="utf-8") as f:
        sm_data = json.load(f)
    with open(raw_path, encoding="utf-8") as f:
        raw_data = json.load(f)

    sm_meta  = sm_data.get("metadata", {})
    raw_meta = raw_data.get("metadata", {})
    print(f"  smooth_window: {raw_meta.get('smooth_window', '?')} → {sm_meta.get('smooth_window', '?')}")

    sm_feats  = sm_data["features"]
    raw_feats = raw_data["features"]

    if len(sm_feats) != len(raw_feats):
        print(f"  ⚠ feature 수 불일치: 평활={len(sm_feats)}, 원본={len(raw_feats)}")

    # 전체 stdev 비교
    sm_all  = [f["properties"]["slope_pct"] for f in sm_feats]
    raw_all = [f["properties"]["slope_pct"] for f in raw_feats]
    sm_stdev  = statistics.stdev(sm_all)
    raw_stdev = statistics.stdev(raw_all)
    reduction = (raw_stdev - sm_stdev) / raw_stdev * 100
    ok = "✓" if reduction > 0 else "✗"
    print(f"\n  전체 stdev:  원본={raw_stdev:.3f}%  평활={sm_stdev:.3f}%  "
          f"감소={reduction:.1f}% {ok}")

    # 도로명별 stdev 비교
    roads_to_check = ["소월로", "이촌로", "한강대로", "반포로", "이태원로", "녹사평대로"]
    print(f"\n  {'도로명':<12} {'원본 stdev':>10} {'평활 stdev':>10} {'감소율':>8} {'판정':>4}")
    print("  " + "-" * 50)

    def get_slopes_by_name(feats, name):
        return [f["properties"]["slope_pct"]
                for f in feats
                if (f["properties"].get("name") or "") == name]

    for road in roads_to_check:
        sm_s  = get_slopes_by_name(sm_feats, road)
        raw_s = get_slopes_by_name(raw_feats, road)
        if len(sm_s) < 2 or len(raw_s) < 2:
            continue
        r_std = statistics.stdev(raw_s)
        s_std = statistics.stdev(sm_s)
        red   = (r_std - s_std) / r_std * 100 if r_std > 0 else 0.0
        ok    = "✓" if red > 5 else ("△" if red > 0 else "✗")
        print(f"  {road:<12} {r_std:>10.3f}% {s_std:>10.3f}% {red:>7.1f}% {ok:>4}")

    # SNR 이론값 비교 (3% 기준 구간 추출)
    def snr_stats(feats, label):
        mid_slopes = [abs(f["properties"]["slope_pct"])
                      for f in feats
                      if 2.0 <= abs(f["properties"]["slope_pct"]) <= 4.0]
        if not mid_slopes:
            return
        length_avg = statistics.mean(
            f["properties"].get("length_m", 5.0) for f in feats
            if 2.0 <= abs(f["properties"]["slope_pct"]) <= 4.0
        )
        # DEM error median ≈ 0.243m (from task spec)
        dem_err = 0.243
        signal = statistics.median(mid_slopes) / 100 * length_avg
        snr = signal / dem_err
        print(f"  {label}: 3%±1% 구간 {len(mid_slopes)}개, "
              f"신호={signal:.3f}m, SNR≈{snr:.2f}")

    print()
    snr_stats(raw_feats, "원본(window=0)")
    snr_stats(sm_feats,  "평활(window=2)")


def main():
    parser = argparse.ArgumentParser(description="road_5m_slope.geojson 평활 검증")
    parser.add_argument("--compare", type=str, default=None,
                        help="비교할 원본 파일 경로 (예: data/road_5m_slope_raw.geojson)")
    args = parser.parse_args()

    print(f"[검증] 로드: {DATA_PATH}")
    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)

    meta = data.get("metadata", {})
    print(f"  step_m={meta.get('step_m')}  "
          f"smooth_window={meta.get('smooth_window', '미기록(이전 버전)')}  "
          f"total_features={meta.get('total_features')}")

    features  = data["features"]
    all_slopes = [f["properties"]["slope_pct"] for f in features]

    # ── 검증 1: 한강변 평지 (바운딩 박스 참고용) ────────────────────────────
    print("\n[검증 1] 한강변 평지 도로 (바운딩 박스 — 참고용, 출입로 오염 가능)")
    hangang_slopes = [f["properties"]["slope_pct"]
                      for f in features
                      if in_box(*midpoint(f), HANGANG_BOX)]
    print_stats("한강변", hangang_slopes)
    if hangang_slopes:
        pct_flat = sum(1 for s in hangang_slopes if abs(s) <= 2.0) / len(hangang_slopes)
        ok = "✓" if pct_flat >= 0.70 else "△(필터 오염)"
        print(f"    {ok} |slope|≤2% 비율 {100*pct_flat:.1f}% (기준: ≥70%, 오염 시 낮게 나옴)")

    # ── 검증 2: 소월로 급경사 (바운딩 박스 참고용) ──────────────────────────
    print("\n[검증 2] 소월로 급경사 도로 (바운딩 박스 — 참고용, 지선 오염 가능)")
    sowol_slopes = [f["properties"]["slope_pct"]
                    for f in features
                    if in_box(*midpoint(f), SOWOL_BOX)]
    print_stats("소월로 박스", sowol_slopes)
    if sowol_slopes:
        abs_sowol = [abs(s) for s in sowol_slopes]
        median_steep = statistics.median(abs_sowol)
        ok = "✓" if median_steep >= 8.0 else "△(지선 혼재)"
        print(f"    {ok} 급경사 중앙값 {median_steep:.1f}% (기준: ≥8%, 지선 포함 시 낮게 나옴)")

    # ── 검증 3: 전체 zone 분류 분포 ─────────────────────────────────────────
    print("\n[검증 3] 전체 zone 분류 분포")
    zone_counts = {"flat": 0, "low": 0, "mid": 0, "high": 0}
    for s in all_slopes:
        zone_counts[classify(s)] += 1
    total = len(all_slopes)
    for zone, cnt in zone_counts.items():
        bar = "█" * int(50 * cnt / total)
        print(f"  {zone:8s} {cnt:6d} ({100*cnt/total:5.1f}%)  {bar}")
    pct_high       = zone_counts["high"] / total
    pct_low_or_flat = (zone_counts["flat"] + zone_counts["low"]) / total
    print(f"\n  flat+low={100*pct_low_or_flat:.1f}%  high(forbidden)={100*pct_high:.1f}%")
    ok3 = "✓" if 0.05 <= pct_high <= 0.25 else "✗"
    print(f"  {ok3} high 비율 {100*pct_high:.1f}% (기준: 5~25%, 용산구 지형 특성상)")

    # ── 검증 4: 도로명 기반 정밀 검증 ──────────────────────────────────────
    road_name_check(features)

    # ── 검증 5: 평활 전후 비교 (--compare 옵션) ──────────────────────────────
    if args.compare:
        raw_path = Path(args.compare)
        if raw_path.exists():
            compare_smoothing(DATA_PATH, raw_path)
        else:
            print(f"\n[검증 5] 비교 파일 없음: {raw_path}")
            print("  python scripts/densify_slope.py --window 0 --out data/road_5m_slope_raw.geojson")
    else:
        raw_default = BASE_DIR / "data" / "road_5m_slope_raw.geojson"
        if raw_default.exists():
            print(f"\n  💡 비교 파일 발견: {raw_default.name}")
            print("     --compare data/road_5m_slope_raw.geojson 옵션으로 전후 비교 가능")

    # ── 요약 ────────────────────────────────────────────────────────────────
    print("\n[요약]")
    print(f"  전체 {total:,}개 구간  "
          f"|slope| 중앙값={statistics.median([abs(s) for s in all_slopes]):.2f}%  "
          f"stdev={statistics.stdev(all_slopes):.2f}%")
    sw = meta.get("smooth_window")
    if sw is None:
        print("  ⚠ metadata에 smooth_window 없음 → 이전 버전(평활 미적용) 파일일 수 있음")
    else:
        print(f"  ✓ smooth_window={sw} 확인됨")


if __name__ == "__main__":
    main()
