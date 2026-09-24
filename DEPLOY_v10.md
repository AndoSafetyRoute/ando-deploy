# release_v10 배포 인수인계

`release_v10` = `release_v9` + 버스·지하철 실시간(저상버스 포함) + 라우팅 개선(계단 회피·속도) + 지도/안내 UI 수정.

이 문서 순서대로 따라가면 됩니다. 코드는 끝났고, 남은 건 **데이터 파일 확인 · `.env` 키 · 메모리 설정 · 빌드 · 검증**입니다.

---

## 0. 무엇이 바뀌었나 (release_v9 이후)

### 백엔드
| 영역 | 변경 |
|---|---|
| 라우팅 엔진 | NetworkX 폴백 제거 — **CCH 단독** (`2999a22`) |
| alpha 이진탐색 | 타원 부분그래프 + scipy dijkstra (`360388b`) + bbox 사전필터·dijkstra 상한 (`be7c4c2`). 서울역→강남역 12.8s(구) → 0.69s |
| **계단 회피** | 출발/도착을 **계단 없이 오갈 수 있는 주 도로망**에만 스냅 (`be7c4c2`). 계단으로만 나갈 수 있는 작은 구역(서울역 내부·남산 테라스 등)에 붙어 계단이 강제되던 문제. 36콜 계단 합 3,505m → 39m. 주 도로망이 200m 넘게 멀면 기존 스냅 유지 |
| **"최단 거리" 카드 계단 회피** | 계단 엣지만 15배 비용인 거리 metric (`75d171b`). 계단 없던 경로는 불변, 계단 있던 경로 거리 +0.9%(중앙값) |
| 역 이름 도착 속도 | 승강기 운행상태 API 캐시(5분) + 기동 시 미리 채움 (`89d4358`). **역 이름 도착 `/route` 30초 → 0.1~0.4초** |
| 버스 실시간 | `/bus/arrival` — 도착 카운트다운 + **저상버스 여부 실시간** (`c717d69`) |
| 지하철 실시간 | `/subway/arrival` — "서울역"↔"서울" 역명 불일치, 노선코드표 오기, "경의중앙선" 접미사, **초를 안 주는 노선(1호선·경의중앙·공항철도·신분당)은 "N정거장 전"**, 떠난/오래된/중복 행 제거 (`c717d69` `8785ad8` `aa0a4c3`) |
| `docker-compose.yml` | 메모리 한도 **6G → 12G** (아래 4번) |
| `.env.example` | 버스 키 3종 항목 추가 |

롤백 스위치(코드 수정 없이 끄기, `backend/routing/cch_engine.py` 상단):
`SNAP_ACCESSIBLE_ENABLED` · `SHORTEST_AVOID_STAIRS` · `ALPHA_SEARCH_LOCAL_ENABLED` · `ALPHA_SEARCH_LOCAL_LIMIT`

### 프론트엔드
| 영역 | 변경 |
|---|---|
| 대중교통 탭 | 버스 배지(저상 ♿·초 단위 카운트다운·20초 갱신), 지하철 배지(방면 "OO행", "N정거장 전") |
| 경로 지도 | **선 굵기를 줌 레벨에 비례** — 축소된 첫 화면에서 과하게 두껍던 문제 (`4849216`). 버스 노선유형 색, 비선택 후보 투명도 0.3 |
| 안내 화면 | 안내 배너가 "접근성 경로 ⓘ" 범례를 가리던 문제 — 배너 오른쪽을 비움 (ljy 방식, `c9f86f6`) |
| 경로 상세 | "걸은 경로" 경사도 색 지도 (`91292e0`) |
| 기타 | 경로 기록 CSV 내보내기, **화면 회전 허용**(`app.json` orientation `default`) |

---

## 1. 데이터 파일 확인 ⚠️ (git 에 없음)

`backend/data/` 의 그래프가 **2026-09-15 재생성본**이어야 합니다 (layer 오연결 차단 `192a527` 반영). release_v8 때 파일이면 교체 필요.

| 파일 | 크기 | SHA-256 |
|---|---|---|
| `road_10m_slope_seoul.geojson` | 696,350,894 B | `0a1123d5cd4dbdba60683e7e2ad1978d421b470d0c1487fc3c2d7f8aa4a4f5f2` |
| `road_10m_slope_seoul.pkl` | 820,123,502 B | `aefc99736e6489f86b623684d190bb67c87c0605348626ff0f2e95d6043d0a25` |

```bash
cd ando-deploy/backend/data
sha256sum road_10m_slope_seoul.geojson road_10m_slope_seoul.pkl
```
다르면 작업자에게 두 파일을 받아 교체하고, **`road_10m_slope_seoul.cchorder.pkl` 은 지우세요**(그래프가 바뀌면 재계산 필요 — 첫 부팅이 2분쯤 더 걸릴 뿐).
교체 전 구버전은 `.old` 로 백업(롤백용).

---

## 2. 서버 `.env` — 키 확인

`backend/.env` (git 에 없음). 아래가 채워져 있어야 해당 기능이 동작합니다. 비어 있어도 서버는 뜨고 배지만 안 보입니다.

| 키 | 용도 |
|---|---|
| `SEOUL_REALTIME_KEY` | 지하철 실시간 배지 (서울 열린데이터광장 swopenapi) |
| `BUS_ARRIVAL_KEY` | 버스 도착정보조회 (공공데이터포털) |
| `BUS_ROUTE_INFO_KEY` | 버스 노선정보조회 — 위와 다른 계정 키 (같으면 비워도 됨) |
| `BUS_ROUTE_INFO_ENABLED` | `1` |
| `SEOUL_ELEVATOR_KEY` / `SEOUL_ESCALATOR_KEY` | 역 승강기 운행상태 (기존) |

버스 키 값은 ljy 에게 받음 (로컬 `.env` 에 반영돼 동작 확인됨).

---

## 3. `eas.json` 서버 주소

`frontend/eas.json` 의 `EXPO_PUBLIC_ROUTE_API_URL` = **`http://3.34.107.148`** (development/preview/production 3곳 동일, 포트 없음 = 80). 서버가 이 주소·포트로 백엔드를 받는지(리버스 프록시 → 5000) 확인.

---

## 4. 서버 메모리 ⚠️

- 실측(이 배포본, 로컬): 부팅 피크 **약 9.4 GB**, 정착 **약 7.7 GB**. release_v8(8.2 GB) 보다 큼 — 그래프가 커졌고(노드 1.73M → 2.03M) 계단 회피용 KDTree·metric 이 추가됨.
- `docker-compose.yml` 을 **limits 12G / reservations 8G** 로 올려 둠. 호스트 RAM 이 16 GB 미만이면 부팅 중 OOM 가능.

---

## 5. 첫 부팅

- 그래프를 교체했다면 `cchorder.pkl` 재계산으로 첫 부팅 **약 3~4분** (`HEALTHCHECK --start-period=600s` 로 감안됨). 이후 부팅은 짧아짐.
- 확인:
  ```bash
  curl -s http://localhost:5000/health
  # {"status":"ok","nodes":2027476}   ← 2,027,476 이면 올바른 그래프
  ```
  `nodes` 가 1,733,511 이면 **release_v8 그래프** — 1번 다시.
- 부팅 로그에 다음이 보여야 함:
  `[CCH] 계단 회피 거리 metric 생성...` / `[CCH] 계단 없는 주 네트워크 2,013,185/2,027,476 노드 (99.3%)`

---

## 6. 스모크 테스트

`user_type=manual_wheelchair`. `/route` POST → `total_length_m` 이 범위 안이면 정상 (±30%).
(이번 배포본 실측값. release_v8 문서의 기대값과 다른 건 스냅 개선 때문 — 정상)

```bash
BASE=http://localhost:5000
q(){ curl -s -XPOST $BASE/route -H 'Content-Type: application/json' -d "$1" \
  | python -c 'import sys,json;d=json.load(sys.stdin);print(round(d["total_length_m"]), [(r.get("id"),round(r["totalDistance"])) for r in d["routes"]])'; }

q '{"origin_lat":37.5663,"origin_lon":126.9779,"dest_lat":37.5553,"dest_lon":126.9707,"user_type":"manual_wheelchair"}'  # 시청→서울역
q '{"origin_lat":37.5546,"origin_lon":126.9726,"dest_lat":37.5548,"dest_lon":126.9683,"user_type":"manual_wheelchair"}'  # 동측→서측
q '{"origin_lat":37.5546,"origin_lon":126.9726,"dest_lat":37.5595,"dest_lon":126.9780,"user_type":"manual_wheelchair"}'  # 동측→남대문
q '{"origin_lat":37.5553,"origin_lon":126.9707,"dest_lat":37.5450,"dest_lon":126.9665,"user_type":"manual_wheelchair"}'  # 서울역→숙대
q '{"origin_lat":37.5511,"origin_lon":126.9884,"dest_lat":37.5636,"dest_lon":126.9850,"user_type":"manual_wheelchair"}'  # 남산도서관→명동
```

| OD | 기대 (m) | 범위 | 비고 |
|---|---|---|---|
| 시청 → 서울역 | 1,938 | 1,360 ~ 2,520 | |
| **동측 → 서측 서부역** | **505** | **350 ~ 660** | km 단위면 그래프 구버전 |
| 동측 → 남대문시장 | 1,144 (최단 937) | 800 ~ 1,490 | |
| 서울역 → 숙대 방면 | 1,594 (최단 1,320) | 1,120 ~ 2,070 | |
| 남산도서관 → 명동 | 3,822 (최단 3,572) | 2,680 ~ 4,970 | **2,1xx m 면 계단 경로(549m 계단) — 스냅 수정 미반영** |

실시간 배지 (키 설정 시):
```bash
curl -s "$BASE/bus/arrival?route=402&stop=%EC%84%9C%EC%9A%B8%EC%97%AD%EB%B2%84%EC%8A%A4%ED%99%98%EC%8A%B9%EC%84%BC%ED%84%B0"  # available:true, is_lowfloor true/false
curl -s "$BASE/subway/arrival?station=%EC%84%9C%EC%9A%B8%EC%97%AD&line_no=4"                                           # available:true, line_no "4"
```
`available:false` 면 `reason` 확인: `key_unset`(키 없음) / `route_id_unresolved`(노선정보 키 문제) / `no_active_train`·`no_active_bus`(심야 등 정상).

역 이름 도착 속도: 로그 `[TIMING] /route pre(exit_snap 등)=…` 가 1초 미만이면 정상.

---

## 7. 앱 빌드 · 실기기 확인

`eas build` 후 실기기에서:
- 대중교통 탭: 버스 배지(저상 ♿), 지하철 배지(서울역 1·4호선, "N정거장 전")
- 경로 지도: 첫 화면(축소)에서 선이 과하게 두껍지 않은지, 확대하면 굵어지는지
- 안내 화면: 배너가 범례 버튼을 가리지 않는지, 가로 회전 시 배치
- 남산도서관 → 명동 도보: 계단 구간 없이 나오는지

---

## 8. 알려진 이슈 (이번 배포 블로커 아님)

- **도보 탭 경로 지도가 가끔 스피너로 남음** — 지도 영역 크기 측정(onLayout)이 안 잡히면 "접기/펼치기" 등 레이아웃이 바뀔 때까지 지도가 안 그려짐. 에뮬레이터에서 1회 재현. 이번 변경과 무관(해당 코드 미수정), 별도 수정 필요.
- **동시 요청 시 장거리 느려짐** — 장거리 5건 동시면 건당 ~2.7s (단건 0.69s). scipy dijkstra 가 병렬로 안 돌아서(GIL). 근본 해결은 계산 프로세스 분리.
- **지하철 역 출구 스냅** — 별도 개발 중. `SUBWAY_DATA_DIR` 는 그쪽 작업에서 설정.
- 출발점 스냅 이동: 계단 구역 회피로 출발/도착점이 최대 200m 옮겨질 수 있음(무작위 지점의 0.9%, 중앙값 18m).

---

## 9. 롤백

- 기능 단위: `cch_engine.py` 상단 스위치를 `False` 로 (0번 참고) → 재시작.
- 전체: `release_v9` 로 배포. 데이터 파일을 바꿨다면 `.old` 로 되돌리고 `cchorder.pkl` 삭제.

---

## 브랜치 참조

| 레포 | 브랜치 | 커밋 |
|---|---|---|
| ando-deploy | `release_v10` | 이 문서 커밋 |
| ando-deploy | `release_v9_2/cch-local-alpha` | 작업 브랜치 (release_v10 과 같은 코드) |
| ando-BE | `ljy/transportation-realtime` | `0143931` — 지하철 수정분 역반영 |
| ando-FE | `ljy/transportation-realtime` | `ad2c0e1` — 지하철 배지 수정분 역반영 |

검증 스크립트: `backend/scripts/snap_limit_validate.py`, `shortest_stairs_validate.py`, `alpha_local_validate.py`, `concurrency_probe.py`
