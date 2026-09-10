# release_v8 배포 인수인계

`release_v8` = `release_v7` + **서울역 도보경로 15km 우회 버그 수정** (backend) + `eas.json` 복구 (frontend).

이 문서 순서대로 따라가면 됩니다. 코드 변경은 끝났고, 남은 건 **데이터 파일 교체 · eas.json 값 채우기 · 검증**입니다.

---

## 0. 무엇이 바뀌었나

| 영역 | 변경 |
|---|---|
| `backend/scripts/densify_slope.py` | `<2m` 도로 세그먼트를 버리지 않고 유지 (직전 경사 상속). 끊겨 있던 도보망 연결 복원 |
| `backend/routing/graph.py` | 그래프 빌드 시 5m 이내 미연결 노드쌍에 보행 링크 추가(`SNAP_TOL_M=5.0`) + 교량/터널/layer 태그 적재 |
| `backend/routing/cch_engine.py` | CCH inertial order 를 `<geojson>.cchorder.pkl` 로 디스크 캐시 → 2회차 부팅부터 ~120초 단축 |
| `backend/app.py` | `/route` 스냅 진단 로그 (`[ROUTE]` / `[SNAP/CCH]`) + **`@app.post("/route")` 데코레이터가 헬퍼 함수에 잘못 붙어 있던 것 수정** (`fc780ed`) |
| `backend/requirements.txt` | **`python-multipart==0.0.32` 추가** — 없으면 컨테이너 부팅이 즉시 크래시 (`fastapi` Form 엔드포인트 필수 의존성) |
| `frontend/eas.json` | v6 이후 누락됐던 것 복구. **값은 placeholder — 아래 2번에서 채워야 함** |

**효과**: 서울역 동/서 횡단 도보경로가 14,278m → 476m (검증 완료). 코드만으로는 안 되고 **아래 3번 데이터 파일 교체가 반드시 있어야** 완전히 고쳐집니다.

> ⚠️ **`/route` 데코레이터 버그**: `a380d97`(최단거리 카드) 에서 헬퍼 함수 2개가
> `@app.post("/route")` 와 `def api_route` 사이에 삽입돼 `/route` 가 잘못된 핸들러로
> 등록됨 → 모든 `/route` 호출이 HTTP 422. `release_v8` (`fc780ed`) 에서 수정됨.
> **같은 버그가 `ando-BE gdy/deploy-v2` (a380d97) 와 `release_v7` 에도 있음** — 거기서
> 분기하는 다른 작업은 `ando-BE gdy/deploy-v2-routing 7a60638` 의 1줄 수정을 가져갈 것.

---

## 1. 사전 준비 — 파일 2개 받기 (git 에 없음, 용량 때문)

작업자(gdy)에게서 직접 전달받을 것:

| 파일 | 크기 | 놓을 위치 (배포 호스트) |
|---|---|---|
| `road_10m_slope_seoul.geojson` | 619 MB | `ando-deploy/backend/data/` |
| `road_10m_slope_seoul.pkl` | 701 MB | `ando-deploy/backend/data/` |

- `pkl` 은 `geojson` 으로부터 미리 빌드해둔 그래프 캐시입니다. 둘 다 같은 폴더에 두면 backend 가 부팅 시 `pkl` 을 바로 로드합니다 (geojson 재파싱 안 함).
- `docker-compose.yml` 이 `./data:/app/data` 로 마운트하므로, 컨테이너를 새로 안 만들어도 이 폴더에 파일만 바꿔 넣고 재시작하면 됩니다.

---

## 2. eas.json placeholder 채우기 ⚠️ 빌드 전 필수

`frontend/eas.json` 의 `build.development` / `build.preview` / `build.production` **3개 프로필 전부**, `env` 블록에 아래 5개가 있어야 합니다. 지금 `EXPO_PUBLIC_ROUTE_API_URL` 만 placeholder 입니다.

```
EXPO_PUBLIC_ROUTE_API_URL       = http://REPLACE_WITH_TEAM_BACKEND:5000   ← 팀 백엔드 실제 주소:포트로 교체
EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY = (채워져 있음)
EXPO_PUBLIC_KAKAO_REST_API_KEY   = (채워져 있음)
EXPO_PUBLIC_SUPABASE_URL         = (채워져 있음)
EXPO_PUBLIC_SUPABASE_ANON_KEY    = (채워져 있음)
```

- **`REPLACE_WITH_TEAM_BACKEND` 을 배포된 backend 의 공개 호스트로 바꿀 것.** 포트는 5000 고정 (backend 가 `--port 5000` 로 뜸).
- 3개 프로필 다 바꿔야 함. 하나라도 놓치면 그 프로필로 빌드한 앱은 경로 요청이 전부 실패합니다 (`REPLACE_WITH_TEAM_BACKEND` DNS 조회 실패).
- `.env` 는 git 에 없어서 `eas build` (git 기반)에 안 실립니다. **env 주입은 오직 `eas.json` 의 `env` 블록으로만** 됩니다.
- 5개 중 하나라도 빠지면 런타임에 `undefined` 로 조용히 넘어가므로 앱에서 원인 찾기 어렵습니다. 빌드 전 3프로필 × 5키 = 15칸 다 찼는지 눈으로 확인.

---

## 3. backend 데이터 파일 교체

```bash
cd ando-deploy/backend/data

# 1) 구버전 백업 (롤백 대비)
mv road_10m_slope_seoul.geojson road_10m_slope_seoul.geojson.old   2>/dev/null || true
mv road_10m_slope_seoul.pkl     road_10m_slope_seoul.pkl.old       2>/dev/null || true
rm -f road_10m_slope_seoul.cchorder.pkl   # 있으면 삭제 (위상 바뀌므로 무효)

# 2) 1번에서 받은 새 파일 2개를 이 폴더에 복사
#    road_10m_slope_seoul.geojson  (619MB)
#    road_10m_slope_seoul.pkl      (701MB)
```

> ⚠️ **코드만 최신이고 데이터가 구버전이면**: snap(5m 링크)만 동작하고 densify(`<2m` 유지) 효과가 없어서 **서울역이 부분적으로만 고쳐집니다.** 반드시 새 geojson + 새 pkl 세트로 교체하세요.

---

## 4. 데이터 교체 검증

새 `geojson` 이 맞는지 (`<2m` 세그먼트 포함본인지) 확인:

```bash
cd ando-deploy/backend/data
python - <<'EOF'
import json
n_total = n_short = n_inherited = 0
has_struct = False
with open("road_10m_slope_seoul.geojson", encoding="utf-8") as f:
    dec = json.JSONDecoder()
    buf = f.read()
i = buf.find('"features"'); i = buf.find('[', i) + 1
while True:
    while i < len(buf) and buf[i] in ' \t\r\n,': i += 1
    if i >= len(buf) or buf[i] == ']': break
    obj, i = dec.raw_decode(buf, i)
    p = obj.get("properties", {})
    n_total += 1
    if p.get("length_m", 9) < 2: n_short += 1
    if p.get("slope_inherited"): n_inherited += 1
    if "bridge" in p or "tunnel" in p or "layer" in p: has_struct = True
print(f"features        = {n_total:,}")
print(f"length_m < 2    = {n_short:,}   (구버전이면 0)")
print(f"slope_inherited = {n_inherited:,}   (구버전이면 0)")
print(f"구조물 태그 존재 = {has_struct}   (구버전이면 False)")
EOF
```

**합격 기준** (새 버전):
- `features` ≈ 1,909,416
- `length_m < 2` > 0  (약 29,700)
- `slope_inherited` > 0  (약 29,866)
- `구조물 태그 존재 = True`

`length_m < 2` 가 **0 이면 구버전 파일** — 교체 안 된 것.

---

## 5. 서버 메모리 요구사항

- **이 문서 작성 중 실측** (pkl 로드 + CCH 부팅, 이 배포본 그대로): 프로세스 RSS 피크 **약 8.2 GB**, 부팅 완료 후 정착 **약 6.4 ~ 7.8 GB**.
- 현재 `docker-compose.yml` `deploy.resources.limits.memory: 6G` → **최소 8G, 여유롭게 10G 권장.** 6G 로 두면 CCH 전처리 중 OOM 확정.
  ```yaml
  deploy:
    resources:
      limits:
        memory: 10G       # 6G → 10G (CCH 부팅 피크 ~8.2GB 실측)
      reservations:
        memory: 6G
  ```
- geojson 에서 pkl 을 **재빌드**해야 하는 상황이면 (pkl 을 못 받았을 때): 네이티브 빌더는 8~9 GB 피크라 16 GB 머신에서 OOM 납니다. 작업자에게 lean 스트리밍 빌더(`build_lean.py`, 피크 6.5 GB) 를 받으세요. **가급적 pkl 을 직접 받아서 재빌드를 피하세요.**

---

## 6. 첫 부팅

- 서버에 `road_10m_slope_seoul.cchorder.pkl` 이 **없으므로** 첫 부팅은 CCH inertial order 계산에 **약 120 ~ 150 초** 걸립니다. `/health` 가 그동안 안 뜹니다. (전체 부팅: 그래프 로드 ~20s + 교차로 사전계산 + CCH 전처리.)
- `backend/Dockerfile` 의 `HEALTHCHECK --start-period=600s` 라서 이 시간은 이미 감안돼 있습니다. **로드밸런서/오케스트레이터의 헬스체크 grace period 도 최소 5분**으로 잡으세요.
- 부팅 완료 후 `data/` 에 `road_10m_slope_seoul.cchorder.pkl` (약 8.5 MB) 이 생깁니다. **두 번째 부팅부터는** inertial order 계산을 건너뛰어 CCH 전처리가 **약 80 초**로 줄어듭니다 (KDTree·엣지배열·7개 metric 은 매번 다시 만듦 — "~0.2초" 는 order 계산 단계만). 이 파일을 지우지 마세요.
- 부팅 성공 확인:
  ```bash
  curl -s http://localhost:5000/health
  # {"status":"ok","nodes":1733511}   ← nodes 가 1,733,511 이면 새 그래프
  ```
  `nodes` 가 1,705,062 이하면 **구버전 pkl** 이 로드된 것.

---

## 7. 부팅 후 스모크 테스트 (OD 4개)

`user_type` 은 `manual_wheelchair` 기준. 각 좌표로 `/route` POST → `total_length_m` 이 아래 범위 안이면 정상 (회귀 baseline ±30%).

```bash
BASE=http://localhost:5000

# 1) 시청 → 서울역        기대 ≈ 1,854 m  (범위 1,300 ~ 2,410)
curl -s -XPOST $BASE/route -H 'Content-Type: application/json' -d \
'{"origin_lat":37.5663,"origin_lon":126.9779,"dest_lat":37.5553,"dest_lon":126.9707,"user_type":"manual_wheelchair"}' \
| python -c 'import sys,json;print("total_length_m =", json.load(sys.stdin)["total_length_m"])'

# 2) 서울역 동측 → 서측 서부역   기대 ≈ 476 m   (범위 330 ~ 620)   ★ 버그 핵심 지표
curl -s -XPOST $BASE/route -H 'Content-Type: application/json' -d \
'{"origin_lat":37.5546,"origin_lon":126.9726,"dest_lat":37.5548,"dest_lon":126.9683,"user_type":"manual_wheelchair"}' \
| python -c 'import sys,json;print("total_length_m =", json.load(sys.stdin)["total_length_m"])'

# 3) 서울역 동측 → 남대문시장   기대 ≈ 1,017 m  (범위 710 ~ 1,320)
curl -s -XPOST $BASE/route -H 'Content-Type: application/json' -d \
'{"origin_lat":37.5546,"origin_lon":126.9726,"dest_lat":37.5595,"dest_lon":126.9780,"user_type":"manual_wheelchair"}' \
| python -c 'import sys,json;print("total_length_m =", json.load(sys.stdin)["total_length_m"])'

# 4) 서울역 → 숙대 방면    기대 ≈ 1,887 m  (범위 1,320 ~ 2,450)
curl -s -XPOST $BASE/route -H 'Content-Type: application/json' -d \
'{"origin_lat":37.5553,"origin_lon":126.9707,"dest_lat":37.5450,"dest_lon":126.9665,"user_type":"manual_wheelchair"}' \
| python -c 'import sys,json;print("total_length_m =", json.load(sys.stdin)["total_length_m"])'
```

| OD | 기대 (m) | 합격 범위 (±30%) | 불합격 시 |
|---|---|---|---|
| 시청 → 서울역 | 1,854 | 1,300 ~ 2,410 | — |
| **동측 → 서측 서부역** | **476** | **330 ~ 620** | **km 단위로 나오면 데이터 교체 실패 (3·4번 다시)** |
| 동측 → 남대문시장 | 1,017 | 710 ~ 1,320 | 5,000m 대로 나오면 pkl 구버전 |
| 서울역 → 숙대 방면 | 1,887 | 1,320 ~ 2,450 | — |

> 참고: 위 값은 NetworkX 최단 기준입니다. 운영은 CCH 엔진이라 스냅 노드 차이 + 정수 양자화로 **3 ~ 4% 정도 높게** 나올 수 있습니다 (정상). ±30% 범위가 흡수합니다.

---

## 8. 최종 확인 — 원 신고 경로 (실기기)

버그 최초 신고: **서울역 공항철도 15번 출구 → 1호선 4번 출구** 도보 경로가 약 **5.7 km** 로 나옴 (네이버 지도 기준 약 683 m).

앱에서 이 출발/도착으로 도보 경로 요청:
- **수정 전**: ~5,700 m (역 남쪽으로 크게 우회)
- **수정 후 기대**: 수백 m ~ 1 km 대. 동/서 횡단 baseline 이 476 m 이고, 실제 출구 좌표(카카오 지오코딩) + CCH 오차를 감안하면 **네이버 683 m 와 비슷한 규모**로 나와야 함.
- **km 단위로 계속 나오면**: 데이터 파일 교체가 안 됐거나 (4번 검증 재확인), 카카오가 반환한 출구 좌표가 그래프에서 60 m 이상 떨어진 지점 (로그의 `[ROUTE] origin=... dest=...` 와 스냅 거리 확인).

이 경로가 정상 범위로 나오면 배포 검증 완료.

---

## 8.5 이미 검증된 것 / 부가 엔드포인트 참고

이 배포본을 로컬에서 실제 기동해 전 엔드포인트를 돌려봤습니다 (`ando-BE/data` 의 새 geojson+pkl, CCH 엔진 사용).

**정상 (FAIL 0):**
- `/route` 도보 — **6개 이동유형 전부 + 최단** × 10개 OD: 우회·블로업 없음. 동측→서측 **486 m** (CCH, NX baseline 476 대비 +2%). 한강 건너편 OD 도 정상 도하.
- `/route/safe` (대중교통 도보구간) — 6유형 × `light` F/T: `/route` 와 거리 일치, `light=true` 시 nav segment 축약.
- `/route?candidates=compare` — 6유형: 유형별+최단 카드 정상, 블로업 없음.
- `end_station_name="서울역"` — 6유형: 도착지가 역 출구(126.97221, 37.55462)로 스냅, 경로 ~1,810 m.
- 서울 경계 밖(광명) — `routes` 2개(유형별+최단) 하이브리드 응답.
- `/bus/lowfloor?route_no=402` → `{licensed:37, lowfloor:26, ratio:70.3}` 정상.
- `/subway/station-summary`, `/subway/chargers` → 200 (graceful).

**데이터/키 의존 — 코드 문제 아님, FE 폴백으로 처리됨:**
- `/subway/best-exit?station=서울역` → **404** ("이용 가능한 출구 없음"). 지하철 편의시설 DB 에 서울역 엘리베이터/에스컬레이터 출구 데이터가 없음. FE 는 404 시 답사 기반 하드코딩 출구로 폴백 (설계된 동작). 서울역 출구 데이터를 넣으려면 `subway_data` 디렉토리 보강 필요 — **이번 배포 블로커 아님.**
- `/bus/arrival` → `{available:false, reason:"route_id_unresolved"}`. 서울시 버스도착 API 키(`.env`)가 서버에 있어야 실시간 배지가 뜸. 없으면 FE 는 정적(카카오) 시간만 표시 (graceful).

---

## 9. 롤백

```bash
cd ando-deploy/backend/data
mv road_10m_slope_seoul.geojson.old road_10m_slope_seoul.geojson
mv road_10m_slope_seoul.pkl.old     road_10m_slope_seoul.pkl
rm -f road_10m_slope_seoul.cchorder.pkl
# 컨테이너 재시작
```

코드 롤백이 필요하면 `release_v7` 로 배포 (backend 는 우회 수정 이전 상태).

---

## 브랜치 참조

| repo | 브랜치 | commit | 내용 |
|---|---|---|---|
| ando-deploy | `release_v8` | `fc780ed` | 이 배포본 (`/route` 데코레이터 + python-multipart 수정 포함) |
| ando-BE | `gdy/deploy-v2-routing` | `7a60638` | backend 소스 원본 (release_v8/backend `app.py` 와 byte-identical) |
| ando-BE | `gdy/seoul-routing` | `5b2bf50` | 우회 수정 6커밋 + 회귀 하네스 (`tests/`) |
| ando-FE | `gdy/fe-personalization` | `8cae653` | frontend 소스 (routeApi 폴백 포트 정정 포함) |

회귀 하네스는 `ando-BE/tests/` (deploy 본에는 관례상 미포함): `run_routing_regression.py`, `detour_scan.py`, `routing_regression.json`.
