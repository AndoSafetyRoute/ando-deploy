"""
S8 — Colab 에서 만든 A+D 계층모델 파라미터(user_model_params_final.json)를
user_model_params 테이블에 적재한다. 자동 배치 학습이 생기기 전까지의 수동 경로.

JSON 형식(참가자 키별):
  {"<key>": {"model_A": {S0, a_u, b_u, c_u, *_sd},
             "model_D": {alpha_u, alpha_u_sd, beta_up, beta_down, cutpoints, slope_scale},
             "obs_slope_min", "obs_slope_max", "n_obs", "lambda", "extrapolation_penalty"}}

행 구성 (uid, arm, model 별 1행, PK=(uid, arm, model, version) → 같은 version 재실행은 덮어씀):
  model 'A': params_json = {S0, a_u, b_u, c_u},  posterior_sd_json = {a_u_sd, b_u_sd, c_u_sd}
  model 'D': params_json = {alpha_u, beta_up, beta_down, cutpoints, slope_scale,
                            lambda, extrapolation_penalty},  posterior_sd_json = {alpha_u_sd}
  n_rows  = JSON 의 n_obs (모델 적합에 쓴 A+D 유효 관측 행 수)
  n_trips = --csv-dir 의 <key>_data.csv 에서 실측 구간 행(seg_index 있음)이 있는 distinct route_id 수
            (JSON 에 트립 수가 없어서 원천 CSV 로 센다. CSV 가 없으면 --trips key=N 으로 지정)
  서버 fallback: n_trips < PERSONAL_MIN_TRIPS 또는 n_rows < PERSONAL_MIN_ROWS 면 personal 비활성.

⚠️ 이 스크립트는 .env 의 DATABASE_URL(=운영 Supabase)에 쓴다. 기본은 dry-run(출력만),
   실제 적재는 --apply. 적재 후 백엔드를 재시작해야 개인 metric 이 만들어진다.

사용법 (ando_route conda env, backend/ 에서):
  python scripts/load_user_model_params.py ~/Downloads/user_model_params_final.json \
      --csv-dir ~/Downloads [--version colab-final-20260926] [--apply]
"""
import argparse
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
from sqlalchemy import text  # noqa: E402
import database as db_mod    # noqa: E402
from config import PERSONAL_ARM, PERSONAL_MIN_TRIPS, PERSONAL_MIN_ROWS  # noqa: E402

# 참가자 키 → Firebase uid
UID_MAP = {
    "ekdud": "aroLTygVqaWg1D9u7x2MlBCFsyt1",
    "tnals": "jq9AIcdYrJbUBseLSf2c6QWKlhf1",
    "wndud": "UKZ8hFpZqWULnELI4mIEvQ0BW002",
}


def count_trips(csv_dir: str, key: str) -> int | None:
    path = os.path.join(csv_dir, f"{key}_data.csv")
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path)
    return int(df.loc[df["seg_index"].notna(), "route_id"].nunique())


def build_rows(params: dict, version: str, csv_dir: str | None, trips_override: dict) -> list[dict]:
    rows = []
    for key, p in params.items():
        if key not in UID_MAP:
            sys.exit(f"[중단] uid 매핑이 없는 키: {key!r}")
        n_trips = trips_override.get(key)
        if n_trips is None and csv_dir:
            n_trips = count_trips(csv_dir, key)
        if n_trips is None:
            sys.exit(f"[중단] {key} 트립 수를 알 수 없음 — --csv-dir 또는 --trips {key}=N 지정")

        a, d = p["model_A"], p["model_D"]
        common = dict(
            uid=UID_MAP[key], arm=PERSONAL_ARM, version=version,
            n_trips=n_trips, n_rows=int(p["n_obs"]),
            obs_slope_min=float(p["obs_slope_min"]), obs_slope_max=float(p["obs_slope_max"]),
        )
        rows.append({**common, "model": "A",
                     "params_json": {k: a[k] for k in ("S0", "a_u", "b_u", "c_u")},
                     "posterior_sd_json": {k: a[k] for k in ("a_u_sd", "b_u_sd", "c_u_sd") if k in a}})
        rows.append({**common, "model": "D",
                     "params_json": {**{k: d[k] for k in ("alpha_u", "beta_up", "beta_down",
                                                          "cutpoints", "slope_scale")},
                                     "lambda": p["lambda"],
                                     "extrapolation_penalty": p["extrapolation_penalty"]},
                     "posterior_sd_json": {k: d[k] for k in ("alpha_u_sd",) if k in d}})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json_path")
    ap.add_argument("--csv-dir")
    ap.add_argument("--trips", action="append", default=[], help="key=N (CSV 대신 트립 수 지정)")
    ap.add_argument("--version", default="colab-final-20260926")
    ap.add_argument("--apply", action="store_true", help="실제로 DB 에 쓴다(없으면 dry-run)")
    args = ap.parse_args()

    trips_override = {k: int(v) for k, v in (t.split("=", 1) for t in args.trips)}
    with open(args.json_path, encoding="utf-8") as f:
        params = json.load(f)
    rows = build_rows(params, args.version, args.csv_dir, trips_override)

    host = (os.environ.get("DATABASE_URL", "").split("@")[-1].split("/")[0]) or "(DATABASE_URL 없음)"
    print(f"대상 DB 호스트: {host}   arm={PERSONAL_ARM}   version={args.version}")
    for r in rows:
        ok = r["n_trips"] >= PERSONAL_MIN_TRIPS and r["n_rows"] >= PERSONAL_MIN_ROWS
        print(f"  {r['uid']}  model={r['model']}  trips={r['n_trips']} rows={r['n_rows']}  "
              f"obs=[{r['obs_slope_min']}, {r['obs_slope_max']}]  "
              f"{'personal 활성' if ok else 'fallback'}  params={json.dumps(r['params_json'])}")

    if not args.apply:
        print("dry-run — 쓰지 않음 (--apply 로 적재)")
        return
    if db_mod.engine is None:
        sys.exit("[중단] DATABASE_URL 이 없어 DB 엔진이 없습니다.")

    with db_mod.engine.begin() as conn:
        conn.execute(text(db_mod.USER_MODEL_PARAMS_DDL))
        for r in rows:
            conn.execute(text("""
                INSERT INTO user_model_params
                    (uid, arm, model, version, params_json, posterior_sd_json,
                     n_trips, n_rows, obs_slope_min, obs_slope_max)
                VALUES (:uid, :arm, :model, :version, CAST(:params_json AS JSONB),
                        CAST(:posterior_sd_json AS JSONB), :n_trips, :n_rows,
                        :obs_slope_min, :obs_slope_max)
                ON CONFLICT (uid, arm, model, version) DO UPDATE SET
                    params_json       = EXCLUDED.params_json,
                    posterior_sd_json = EXCLUDED.posterior_sd_json,
                    n_trips           = EXCLUDED.n_trips,
                    n_rows            = EXCLUDED.n_rows,
                    obs_slope_min     = EXCLUDED.obs_slope_min,
                    obs_slope_max     = EXCLUDED.obs_slope_max,
                    fitted_at         = NOW()
            """), {**r, "params_json": json.dumps(r["params_json"]),
                   "posterior_sd_json": json.dumps(r["posterior_sd_json"])})
    print(f"적재 완료: {len(rows)}행 — 백엔드 재시작 시 personal metric 생성")


if __name__ == "__main__":
    main()
