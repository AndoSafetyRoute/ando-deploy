# Ando 백엔드 (FastAPI)

경사도 기반 접근성 경로탐색 서버. 서울 전역 보행로 그래프에 Contraction Hierarchies(CCH)
알고리즘을 얹어 사용자 유형(수동/전동 휠체어, 보행보조기, 고령자 등)별 최적 경로를 계산합니다.

## 요구사항

- Python 3.11 권장 (3.10~3.12 정도면 무난히 동작할 것으로 예상, `routingkit-cch` 휠 지원 버전 확인 필요)
- PostgreSQL (Supabase 사용 중 — 로컬 Postgres로 대체 가능)
- 디스크 여유 공간 최소 2~3GB (그래프 원본 + pickle 캐시)
- 메모리 4GB 이상 권장 (서울 전역 그래프 로딩 시 노드 170만 개 규모)

## 1. 가상환경 + 의존성 설치

```bash
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

`routingkit-cch`는 PyPI에 사전 빌드된 wheel이 없는 플랫폼도 있습니다. 설치 실패 시 해당 패키지의
빌드 요구사항(C++ 컴파일러 등)을 확인하세요.

## 2. 환경변수 설정

```bash
cp .env.example .env
```

값을 채우는 방법은 `.env.example` 안의 주석에 각각 적어뒀습니다. 요약하면:

- `KAKAO_REST_API_KEY` / `KAKAO_JS_API_KEY` — 카카오 개발자 콘솔
- `DATABASE_URL` — Supabase(또는 로컬 Postgres) 연결 문자열
- `FIREBASE_KEY_PATH` — 아래 3번 참고
- `GEOJSON_PATH` — 아래 4번 참고
- `SEOUL_*_KEY` 5종 — 서울 열린데이터광장(data.seoul.go.kr)에서 각 서비스별로 신청

## 3. Firebase 서비스 계정 키 (firebase-key.json)

Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성"으로 JSON 파일을 받아
`backend/firebase-key.json`으로 저장하세요 (git에 포함 안 됨). 로그인 토큰 검증(Firebase Admin SDK)에
사용합니다.

## 4. 경사도 그래프 데이터 (가장 중요, 용량 큼)

`data/` 아래 그래프 원본 파일들은 500MB~1GB 이상이라 git에 포함하지 않았습니다. 두 가지 방법 중
하나를 선택하세요.

### 방법 A — 완성된 데이터 파일을 직접 전달받기 (권장)

프로젝트 담당자에게 아래 파일을 요청해서 `data/` 폴더에 넣으세요:

- `data/road_10m_slope_seoul.geojson` (서울 전역, 약 530MB) — 이것만 있으면 됩니다. 서버가 최초
  실행 시 같은 이름의 `.pkl` 캐시를 자동 생성합니다(최초 1회만 느림, 이후 재시작은 수십 초~2분).
- 서울 전역이 아니라 일부 지역(예: 용산구)만 테스트하면 되면 더 작은
  `data/road_5m_slope.geojson`(약 24MB)으로 대체 가능 — 이 경우 `.env`의 `GEOJSON_PATH`도 그에 맞게
  바꿔주세요. 이 작은 그래프는 노드 수가 20만 개 미만이라 CCH 대신 NetworkX로 자동 폴백됩니다
  (약간 느리지만 별도 설정 불필요).

### 방법 B — 원본 데이터로 직접 생성

1. DEM(수치표고모델) 래스터: `data/dem-seoul.tif`
2. 도로망 GeoJSON(OSM 기반, Geofabrik 등에서 추출): `data/roads-seoul.geojson`
3. 아래 스크립트로 경사도 계산 + N미터 단위로 밀집화:

```bash
python scripts/densify_slope.py \
  --dem data/dem-seoul.tif \
  --roads data/roads-seoul.geojson \
  --output data/road_10m_slope_seoul.geojson \
  --step 10 --window 2
```

원본 DEM/도로망 데이터의 정확한 출처는 프로젝트 담당자에게 확인하세요 — 코드에는 파일 포맷
기대치만 있고 다운로드 경로는 기록돼 있지 않습니다.

## 5. 실행

```bash
uvicorn app:app --host 0.0.0.0 --port 5000
```

최초 실행(pickle 캐시가 없을 때)은 그래프 빌드 + CCH 전처리로 서울 전역 기준 약 5~10분 걸릴 수
있습니다. 이후 재시작은 pickle 캐시 로딩(수 초) + CCH 재전처리(1~2분) 정도입니다.

정상 기동 확인:

```bash
curl http://localhost:5000/health
# {"status":"ok","nodes":1705062}
```

## 실기기(프론트)에서 접근하려면

PC와 폰이 같은 Wi-Fi에 있다면 프론트 `.env`의 `EXPO_PUBLIC_ROUTE_API_URL`을 PC의 사설 IP로
설정하세요. USB 연결이면 `adb reverse tcp:5000 tcp:5000` 후 `http://localhost:5000`을 쓰면 됩니다.

## 알려진 이슈

### 서울역 인근 도보 경로 우회 문제

서울역 인근에서 출발/도착하는 경로가 실제보다 훨씬 긴 우회 경로로 계산됩니다. 확인된 증상:

- 서울역~서울숲(직선거리 약 5.9km) 최단 도보 거리가 14.3~14.5km로 계산됨
- 서울역 좌표를 150m 단위로 동/서로 옮겨도 동일하게 재현 — 특정 좌표가 아니라 서울역 인근 지역
  전체의 문제로 보임
- 대중교통 탭의 소요시간도 같은 이유로 부정확해짐 (승차 지점까지의 도보 구간이 같은 엔진을 쓰기
  때문)

**추정 원인**: `routing/graph.py`의 `_connect_components()`는 원본 도로망 데이터에 있는 끊어진
연결 성분들을 `BRIDGE_GAP_M`(기본 50m) 이내일 때만 자동으로 이어붙입니다. 서울역 서쪽의 대형 철도
조차장 주변 보행로 데이터에 이 반경을 넘는 실제 빈틈이 있어서, 그 지역에서 출발하는 경로가 훨씬
먼 우회 연결점(관찰 결과 경복궁·청량리 방면)까지 돌아가는 경로를 "최단"으로 계산하는 것으로
보입니다. CCH 엔진의 최단거리 계산 자체가 이 값을 내놓기 때문에 애플리케이션 로직 버그는 아니고,
원본 보행로 지오데이터(`data/roads-seoul.geojson`)의 빈틈으로 추정됩니다.

**다음에 시도해볼 것**:

1. `_connect_components()`가 로그로 남기는 연결 성분 개수/브리지 개수를 서울역 인근에 한정해서
   확인 (그래프를 pickle 캐시 없이 처음부터 다시 빌드해야 로그가 찍힘 — 시간 소요)
2. 서울역 인근에서 실제로 빠진 보행로(지하보도, 육교 등)가 있는지 원본 GeoJSON을 QGIS 등으로
   시각화해서 확인
3. 필요시 `config.py`의 `BRIDGE_GAP_M`을 국지적으로 늘리거나, 누락된 보행로를 원본 데이터에 수동
   보강
