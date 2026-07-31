"""
DEM(EPSG:5174) + 도로 GeoJSON → N m 단위 경사도 GeoJSON 생성

실행 예시:
  # 용산구 기본 (STEP_M=5, SMOOTH_WINDOW=2)
  python scripts/densify_slope.py

  # 서울 전체 (STEP_M=10)
  python scripts/densify_slope.py \\
    --dem data/dem-seoul.tif \\
    --roads data/roads_seoul.geojson \\
    --output data/road_10m_slope_seoul.geojson \\
    --step 10 --window 2

  # 평활 없이 비교용
  python scripts/densify_slope.py --window 0 --output data/road_5m_slope_raw.geojson

도로 GeoJSON 포맷:
  - 기존 OSM (elevationcostroad.geojson): highway 필드
  - Geofabrik (roads_seoul.geojson):       fclass 필드  ← 자동 감지
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer

BASE_DIR = Path(__file__).parent.parent          # ando-BE/
DEM_PATH  = BASE_DIR.parent / "dem_youngsan.tif" # gradpj/dem_youngsan.tif
ROAD_PATH = BASE_DIR / "data" / "legacy" / "elevationcostroad.geojson"
OUT_PATH  = BASE_DIR / "data" / "road_5m_slope.geojson"
STEP_M        = 5.0  # 밀집화 간격(m)
SMOOTH_WINDOW = 2    # 고도 이동평균 전후 포인트 수 (±2 → 총 5포인트 ≈ 20m 등가)


# ── 좌표 변환기 ───────────────────────────────────────────────────────────────
_to5174   = Transformer.from_crs("EPSG:4326", "EPSG:5174", always_xy=True)
_to_wgs84 = Transformer.from_crs("EPSG:5174", "EPSG:4326", always_xy=True)


def haversine(lon1, lat1, lon2, lat2) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ── DEM 로드 ──────────────────────────────────────────────────────────────────
def load_dem(path: Path):
    with rasterio.open(path) as ds:
        data      = ds.read(1).astype(np.float32)
        transform = ds.transform
        nodata    = ds.nodata
        print(f"[DEM] {ds.width}×{ds.height}픽셀  CRS={ds.crs}  NoData={nodata}")
        px_m = abs(transform.a)
        print(f"[DEM] 픽셀 크기 ≈ {px_m:.2f}m  표고 {data[data!=nodata].min():.1f}~{data[data!=nodata].max():.1f}m")
    return data, transform, nodata


def get_elevation(dem_data, transform, nodata, lon, lat):
    """
    WGS84 (lon, lat) → 표고(m), 쌍선형 보간.
    DEM 3m 픽셀 경계 아티팩트를 줄이기 위해 nearest 대신 bilinear 사용.
    범위 밖·NoData이면 None.
    """
    x, y = _to5174.transform(lon, lat)
    col_f = (x - transform.c) / transform.a
    row_f = (y - transform.f) / transform.e
    h, w = dem_data.shape

    col0, row0 = int(col_f), int(row_f)
    col1, row1 = col0 + 1, row0 + 1

    if not (0 <= row0 < h and 0 <= col0 < w):
        return None

    # 경계 클리핑
    col1 = min(col1, w - 1)
    row1 = min(row1, h - 1)

    dc = col_f - col0   # 0~1
    dr = row_f - row0   # 0~1

    vals = [
        dem_data[row0, col0], dem_data[row0, col1],
        dem_data[row1, col0], dem_data[row1, col1],
    ]
    if nodata is not None and any(v == nodata for v in vals):
        # NoData 포함 시 유효 픽셀 평균
        valid = [v for v in vals if v != nodata]
        return float(np.mean(valid)) if valid else None

    val = (vals[0] * (1-dc) * (1-dr) +
           vals[1] *    dc  * (1-dr) +
           vals[2] * (1-dc) *    dr  +
           vals[3] *    dc  *    dr)
    return float(val)


# ── 고도 평활 ────────────────────────────────────────────────────────────────
def smooth_elevations(elevs: list, window: int = SMOOTH_WINDOW) -> list:
    """
    이동평균 평활 (feature 경계 내에서만 호출할 것).
    window=2: 전후 2개씩 포함, 최대 5포인트 평균 ≈ 20m 등가.
    None은 평균에서 제외하고, 유효값이 없으면 None 유지.
    단부(시작/끝) 포인트는 가용한 포인트만으로 편향 윈도우 처리.
    """
    smoothed = []
    for i in range(len(elevs)):
        start = max(0, i - window)
        end   = min(len(elevs), i + window + 1)
        vals  = [e for e in elevs[start:end] if e is not None]
        smoothed.append(sum(vals) / len(vals) if vals else None)
    return smoothed


# ── 5m 밀집화 ────────────────────────────────────────────────────────────────
def densify_line(coords: list[list], step_m: float = STEP_M) -> list[tuple]:
    """
    WGS84 좌표 목록 → step_m 간격 포인트 목록.
    출력: [(lon, lat), ...] (시작~끝 포함)
    """
    result: list[tuple] = []
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i][0],     coords[i][1]
        lon2, lat2 = coords[i+1][0],   coords[i+1][1]
        seg_len = haversine(lon1, lat1, lon2, lat2)
        if seg_len < 0.1:
            continue
        n_steps = max(1, round(seg_len / step_m))
        for k in range(n_steps):
            t = k / n_steps
            result.append((lon1 + t*(lon2-lon1), lat1 + t*(lat2-lat1)))
    if coords:
        result.append((coords[-1][0], coords[-1][1]))
    return result


# ── feature 생성 ─────────────────────────────────────────────────────────────
def make_features(feat: dict, dem_data, transform, nodata, step_m: float,
                  smooth_window: int = SMOOTH_WINDOW) -> list[dict]:
    """
    OSM feature → 5m 단위 LineString feature 목록.
    고도는 feature 내 전체 포인트를 일괄 조회한 뒤 이동평균 평활 후 slope_pct 계산.
    평활은 feature 경계를 넘지 않으므로 다른 도로의 고도가 섞이지 않음.
    """
    props   = feat["properties"]
    # Geofabrik 형식은 "fclass", 기존 OSM은 "highway"
    highway = props.get("highway") or props.get("fclass") or "footway"
    name    = props.get("name") or props.get("name:ko") or ""

    geom = feat["geometry"]
    all_lines = (
        geom["coordinates"] if geom["type"] == "MultiLineString"
        else [geom["coordinates"]]
    )

    features: list[dict] = []
    for line_coords in all_lines:
        if len(line_coords) < 2:
            continue
        dense = densify_line(line_coords, step_m)
        if len(dense) < 2:
            continue

        # 전체 포인트 고도 일괄 조회 → 이동평균 평활 (feature 경계 내)
        raw_elevs = [
            get_elevation(dem_data, transform, nodata, lon, lat)
            for lon, lat in dense
        ]
        elevs = smooth_elevations(raw_elevs, smooth_window) if smooth_window > 0 else raw_elevs

        for i in range(len(dense) - 1):
            lon1, lat1 = dense[i]
            lon2, lat2 = dense[i + 1]
            seg_len = haversine(lon1, lat1, lon2, lat2)
            if seg_len < 2.0:   # 2m 미만 구간 제외 (DEM 해상도 3m에서 노이즈)
                continue

            e1 = elevs[i]
            e2 = elevs[i + 1]

            if e1 is not None and e2 is not None:
                raw = (e2 - e1) / seg_len * 100
                # 물리적 최대 경사도 클리핑: 보행로 최대 약 ±60%
                slope_pct = round(max(-60.0, min(60.0, raw)), 3)
            else:
                slope_pct = 0.0
                e1 = e1 or 0.0
                e2 = e2 or 0.0

            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[lon1, lat1], [lon2, lat2]],
                },
                "properties": {
                    "highway":         highway,
                    "name":            name,
                    "length_m":        round(seg_len, 2),
                    "slope_pct":       slope_pct,       # 부호 있음: + 오르막 / - 내리막
                    "elevation_start": round(e1, 2),
                    "elevation_end":   round(e2, 2),
                },
            })
    return features


# ── 메인 ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="N m 단위 경사도 GeoJSON 생성")
    parser.add_argument("--dem",    type=str, default=str(DEM_PATH),
                        help=f"DEM 파일 경로 (기본: {DEM_PATH.name})")
    parser.add_argument("--roads",  type=str, default=str(ROAD_PATH),
                        help=f"도로 GeoJSON 경로 (기본: {ROAD_PATH.name})")
    parser.add_argument("--output", "--out", dest="output", type=str, default=str(OUT_PATH),
                        help=f"출력 파일 경로 (기본: {OUT_PATH.name})")
    parser.add_argument("--step",   type=float, default=STEP_M,
                        help=f"밀집화 간격 m (기본: {STEP_M})")
    parser.add_argument("--window", type=int,   default=SMOOTH_WINDOW,
                        help=f"이동평균 윈도우 크기 (기본: {SMOOTH_WINDOW}, 0=평활 없음)")
    args = parser.parse_args()

    dem_path      = Path(args.dem)
    road_path     = Path(args.roads)
    out_path      = Path(args.output)
    step_m        = args.step
    smooth_window = args.window

    print(f"[densify_slope] DEM  : {dem_path}")
    print(f"[densify_slope] 도로 : {road_path}")
    print(f"[densify_slope] 출력 : {out_path}")
    print(f"[densify_slope] 간격 : {step_m}m  평활 윈도우: ±{smooth_window}포인트"
          + (f" (≈{step_m*(smooth_window*2+1):.0f}m 등가)" if smooth_window > 0 else " (평활 없음)"))

    # DEM 메모리 예상치 경고
    dem_size_mb = dem_path.stat().st_size / 1024 / 1024
    if dem_size_mb > 200:
        with rasterio.open(dem_path) as ds:
            est_ram_mb = ds.width * ds.height * 4 / 1024 / 1024
        print(f"[DEM] 파일 크기 {dem_size_mb:.0f}MB → RAM 예상 {est_ram_mb:.0f}MB "
              f"({ds.width}×{ds.height}px)")

    dem_data, transform, nodata = load_dem(dem_path)

    print(f"[도로] 로드 중: {road_path}")
    with open(road_path, encoding="utf-8") as f:
        roads = json.load(f)

    # Geofabrik 포맷 감지 로그
    sample_props = roads["features"][0]["properties"] if roads["features"] else {}
    fmt = "Geofabrik(fclass)" if "fclass" in sample_props else "OSM(highway)"
    print(f"[도로] 포맷: {fmt}  총 {len(roads['features']):,}개 feature")

    # 기존 pkl 캐시 안내
    expected_pkl = out_path.with_suffix(".pkl")
    if expected_pkl.exists():
        print(f"[캐시] 기존 pkl 발견: {expected_pkl}")
        print("  → 서버 재시작 전 삭제 권장: del data\\road_10m_slope_seoul.pkl")

    out_features: list[dict] = []
    total  = len(roads["features"])
    no_dem = 0
    log_interval = max(100, total // 50)  # 약 50회 진행률 출력

    import time
    t0 = time.time()
    for idx, feat in enumerate(roads["features"]):
        if idx % log_interval == 0:
            elapsed = time.time() - t0
            rate    = idx / elapsed if elapsed > 0 else 0
            eta     = (total - idx) / rate if rate > 0 else 0
            print(f"  [{idx:6d}/{total}] feature={len(out_features):,}  "
                  f"경과={elapsed:.0f}s  ETA={eta:.0f}s")
        new_feats = make_features(feat, dem_data, transform, nodata, step_m,
                                  smooth_window=smooth_window)
        no_dem += sum(1 for f in new_feats if f["properties"]["slope_pct"] == 0.0
                      and f["properties"]["elevation_start"] == 0.0)
        out_features.extend(new_feats)

    geojson = {
        "type": "FeatureCollection",
        "features": out_features,
        "metadata": {
            "source_dem":     dem_path.name,
            "source_road":    road_path.name,
            "step_m":         step_m,
            "smooth_window":  smooth_window,
            "total_features": len(out_features),
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)

    elapsed_total = time.time() - t0
    print(f"\n[완료] {len(out_features):,}개 feature 저장 → {out_path}  ({elapsed_total:.0f}s)")
    print(f"  DEM 범위 밖(slope=0, elev=0): {no_dem}개 ({100*no_dem/max(1,len(out_features)):.1f}%)")


if __name__ == "__main__":
    main()
