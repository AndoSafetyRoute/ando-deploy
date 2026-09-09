# 개인 맞춤 경로 — 데이터 수집 계획 & 이연 작업

배포 v2(`gdy/deploy-v2`) 기준. 신호 A~D 수집 파이프라인의 **수집 시점 정책**과,
데이터가 쌓인 뒤로 미룬 작업을 한 곳에 모은다. 수집 전 구현이 끝난 항목은
`## 1`, 학습·운영 단계로 미룬 항목은 `## 2`, ⑬(경로 선택) 활성화 체크리스트는 `## 3`.

관련 파일: `database.py`(스키마·`save_collect_batch`), `routing/speed.py`(EMA·검증),
`app.py`(`/collect/batch`, `/route?candidates=compare`, `/user/personalization-status`).
FE 계약: `ando-FE/src/api/collect.ts`, `src/personalization/config.ts`.

---

## 1. 수집 시점 정책 (구현 완료)

### 1.1 `v̄_flat` 스냅샷 정책  ★재현성의 핵심

`user_speed_profile` 의 `zone_key='flat'` 행(`v̄_flat`)은 **신호 A·B 정규화의 기준**이다
(감속 판정 = `v̄_flat × 0.4`, 신호 A 의 상대 속도 = `관측속도 / v̄_flat`).
이 값은 `/collect/batch` 가 들어올 때마다 EMA 로 갱신돼 **시간에 따라 계속 변한다**.

정책:

1. **캘리브레이션 게이트** — 누적 평지 관측 거리(`user_speed_profile.cumulative_distance_m`)가
   `CALIBRATION_FLAT_M`(300m) 미만이면 `get_user_speed_profile(calibrated_only=True)` 가
   `flat` 을 내보내지 않는다. 그 전까지 소요시간 추정은 유형 문헌 기본값(`ZONE_SPEED_DEFAULTS`)
   으로 폴백한다. 배치 학습(⑨)은 `calibrated_only=False` 로 원본을 그대로 읽는다.

2. **학습 시 고정** — 배치 학습(⑨)은 실행 시작 시점에 각 유저의 `user_speed_profile.flat.speed_ms`
   를 **한 번 읽어 상수로 고정**하고, 그 학습 실행 전체에서 신호 A·B 정규화에 그 값만 쓴다.
   학습 도중 EMA 가 바뀌어도 무시한다. 고정한 값은 `user_slope_curve.v_flat_used` 에
   기록한다(아래 스키마). 다음 학습 실행은 그 시점의 새 `flat` 을 다시 고정한다.

3. **재현성** — `user_slope_curve` 한 행이 있으면
   `(theta, cost_grid, beta_gamma, v_flat_used, model_ver, fitted_at, n_sessions)` 로
   그 곡선이 "어느 `v̄_flat` 기준, 몇 세션으로, 언제, 어느 코드로" 나왔는지 완전히 특정된다.

`user_slope_curve` 스키마(현재 + 추가):

| 컬럼 | 의미 |
|---|---|
| `uid` PK | |
| `theta` JSONB | 기저함수 계수 |
| `cost_grid` JSONB | 사전 평가된 `c_u(g)` 격자 |
| `beta_gamma` FLOAT | 선택 모델 스케일 |
| `v_flat_used` FLOAT | **이 학습이 정규화에 쓴 `v̄_flat` (신규, 정책 2)** |
| `valid_min` / `valid_max` FLOAT | 곡선 신뢰 구간(관측 커버 경사 범위) |
| `n_sessions` INT | 학습에 들어간 세션 수 |
| `model_ver` TEXT | 코드/하이퍼파라미터 버전 태그 |
| `fitted_at` TIMESTAMPTZ | 학습 실행 시각 |

### 1.2 세션 시점 `user_type` 스냅샷

`trip_slope_observations.user_type` 에 관측이 **일어난 세션의 유형**을 박아 넣는다
(`save_collect_batch` 가 `users.user_type` 를 배치 처리 시점에 읽어 각 행에 복사).
파일럿 중 사용자가 유형을 바꿔도 과거 관측의 유형 귀속이 깨지지 않는다.
학습은 `users.user_type`(현재값)이 아니라 이 컬럼(관측 시점값)으로 그룹핑한다.

> 한계: 배치가 세션 종료 후 도착하므로 "배치 처리 시점" 유형이다. 세션 진행 중
> 유형을 바꾸고 그 세션 배치가 그 뒤 도착하면 새 유형으로 찍힌다. 파일럿에서
> "세션 중 유형 변경 금지"를 참가자 안내에 포함하면 이 창은 닫힌다.

### 1.3 `route_id=NULL` 세션의 경로 형상 보존

`/navigation/start` 가 실패하면 `route_id` 가 `NULL` 이고, 학습은 `session_id` 로 관측을
묶지만 "그 세션이 어떤 경로였나"(좌표열·구간 경사 프로파일)가 어디에도 안 남았다
(`navigation_segments` 는 `route_id` 필수).

해결: FE 가 세션 첫 배치에 `route_profile`(구간별 `{slope, length_m}` 배열 + 총거리 +
좌표열)을 1회 실어 보내고, BE 가 `session_route_profile(uid, session_id, ...)` 에 UPSERT.
`route_id` 유무와 무관하게 항상 저장하므로, `route_id` 있는 세션에서도 교차 검증용으로 쓸 수 있다.

### 1.4 첫 관측 EMA 과반영 방지

`ema_update(prior, observed, n=0)` 은 `alpha = 1/(n+1) = 1.0` 이라, 관측이 없던 zone 에
첫 관측 1건이 유형 기본값을 **완전히** 덮어썼다. 희귀 zone(`up_forbidden` 등)에서 첫
걸음이 GPS 노이즈면 다수 샘플이 쌓일 때까지 프로파일이 오염된다.

해결: `alpha` 상한을 `EMA_START_ALPHA_CAP`(0.5)로 둔다. 첫 관측은 `prior` 50% + `관측` 50%.
n 이 커지면 기존대로 `1/(n+1)` → `_EMA_MIN_ALPHA`(0.05) 로 수렴.

### 1.5 GPS 오차 — 수집 시점 처리 (FE)

| 상황 | 처리 |
|---|---|
| `accuracy > 20m` 픽스 | 위치 기반 로직 스킵. 단 `noteGpsSample()` 는 호출 — GPS 커버리지는 있었다는 신호이므로 `gps_sample_n` 에는 반영(터널/무신호 구간과 구분). |
| `dt ≥ 10s` 또는 `d ≥ 100m` (점프/공백) | 그 표본 폐기 + 진행 중이던 bin 통째 무효화(`invalidateCurrent`). 다음 bin 경계 전까지 관측 미방출. |
| `v < 0.15 m/s` (사실상 정지) | `stop_ms` 로 누적. 학습에서 `elapsed_ms - stop_ms` = 순이동시간. |
| 앱 백그라운드 전환 | 복귀 시 경과가 `SPEED_SAMPLE_MAX_GAP_S` 초과면 `invalidateCurrent` — 화면 꺼둔 동안의 시간이 bin `elapsed_ms` 를 오염시키지 않게. |

BE 검증(`validate_observation`): `gps_sample_n<3` / 순경과<3s / `distance≤0` / 속도 `0.05~2.5 m/s`
밖 → **EMA 갱신에서만 제외**. 원본은 `trip_slope_observations` 에 그대로 남긴다(3.8절 원칙).

---

## 2. 이연 작업 (데이터가 쌓인 뒤 / 학습 단계)

지금 구현하지 않는다. 파일럿 로그가 나오면 착수.

### 2.1 학습 단계 전처리 (⑨ 배치 코드에서)
- **20m 미만 구간 컷** (`ando_ml_plan_v2 §3.4`). FE 는 안 자르고 전부 보낸다(관문 검증
  "거리 합계 = 경로 총합" 성립 + 임계값 미확정). 학습 코드가 `distance_m < 20` 필터를
  적용하고, 파일럿 GPS 로 임계값 재보정.
- **감속 판정** — `speed_samples.speed_ms` 원본에서 `v < v_flat_used × 0.4` 를 학습 시점에 계산.
  `sub_distance_m` 가중 평균으로 bin 대표 속도 산출.
- **`slope_bin` 부호 유지** — 절댓값으로 뭉개지 말 것(내리막 최적점·왕복 대칭 근거).
- **`elapsed_ms` 이상치 필터** — `distance_m / (elapsed_ms/1000)` 가 비현실값(<0.05 또는
  >2.5 m/s)이거나 `elapsed_ms` 가 `observed_at` 간격과 크게 어긋나는 행 제외. 앱
  백그라운드로 새어든 시간을 사후 제거.
- **세션 그룹핑** — `route_id` 우선, 없으면 `session_id`. 경로 형상은 `navigation_segments`
  (route_id 있을 때) 또는 `session_route_profile`(항상).

### 2.2 인덱스 (데이터량 늘면)
```sql
CREATE INDEX IF NOT EXISTS idx_speed_samples_session ON speed_samples (session_id);
CREATE INDEX IF NOT EXISTS idx_speed_samples_uid_bin ON speed_samples (uid, slope_bin);
CREATE INDEX IF NOT EXISTS idx_tso_session ON trip_slope_observations (session_id);
```
파일럿 규모(수십 세션)에선 seq scan 으로 충분. 수천 세션부터 추가.

### 2.3 `collect_batch_log` 정리 정책
`(uid, session_id, seq)` 로 영구 누적. 파일럿에선 무시. 운영 전환 시:
- 90일 지난 행 삭제하는 주기 작업, 또는 `received_at` 기준 월 파티션.
- 멱등 창(같은 배치 재전송 허용 기간)을 30일로 못박고 그보다 오래된 로그는 삭제해도
  안전(그 시점엔 FE 큐에도 안 남아 있음 — `MAX_PENDING_BATCHES=40`, 2분 플러시).

### 2.4 프론트 성능 (파일럿 관찰 후 판단)
- `submitSegment` 개별 POST(`NavigationScreen` 구간 통과마다 1건)를 `navigation_segments`
  배치 엔드포인트로 합치기. 개인화 배치와 별개 경로라 지금 건드리면 회귀 위험만 큼.
- GPS 콜백의 `O(구간수 + waypoint수)` 루프 — 서울 전역 장거리 도보에서 프레임 드랍
  관찰되면 현재 구간 인덱스 주변만 스캔하도록 좁히기.

### 2.5 수집 데이터 모니터링 뷰
파일럿 검증은 `personalization-wiring.md §5` 의 SQL 로 수동. 운영 단계에서 관측 현황
대시보드(세션 수, bin 커버리지, 유효율)가 필요하면 별도 구축.

---

## 3. ⑬ 경로 선택(신호 C) 활성화 체크리스트

신호 C 는 아래가 모두 충족돼야 데이터가 쌓인다. 현재는 수집 0.

- [ ] **C1** `ando-FE/src/personalization/config.ts` `ROUTE_COMPARE_ENABLED = true`
      (파일럿 3세션 로그 전수 검증 통과 후)
- [ ] **C2** BE `candidateRoutes` 가 2개 이상 채워짐:
  - `kind:"distance"` — CCH 8번째 metric(거리 + 금지구간 배제). 서울 전역 그래프에서만
    (`_cch` 존재). 용산 로컬(NetworkX)은 안 뜬다.
  - `kind:"personal"` — `_personal_cache` 에 θ 기반 metric. ⑨ 배치가 채워야 함.
- [x] **C3** `requestRouteCandidates` 가 `Authorization: Bearer` 전송 (구현 완료) —
      없으면 BE `decoded=None` 이라 `personal` 후보 분기가 영구 불발이었음.
- [x] compare 후보 `routeSegments` 에 `length`/`slope` 별칭 정규화 (구현 완료) —
      distance/personal 후보가 원본 형식(`length_m` 만)이라 FE `SlopeBinTracker` 가
      `seg.length ?? 5` 로 5m fallback 하던 문제.

활성화 후 검증: `route_choice_log` 에 `n_shown ≥ 2`, `chosen_kind` 비-NULL.
(2026-09 이후 `shown_pos`는 무작위가 아니라 고정 순서 — `routeChoiceModel.ts` 참고.)

- [ ] **신규 발견 — compare 후보별 `navigation_segments`/`waypoints` 누락**: `/route`
      `candidates:"compare"` 응답은 최상위(type 경로 기준) `navigation_segments`/`waypoints`
      만 계산하고, `candidateRoutes[]`의 `distance`/`personal` 후보에는 안 붙는다.
      FE `RouteCompareScreen`이 "distance"나 "personal"을 선택하면 그 경로 데이터로
      `Navigation` 화면에 진입하는데, `navigation_segments`가 없어 지도 zone 색칠이
      `getSegmentColor` 폴백(3%/8% 고정 임계, 별도 팔레트)으로 떨어지고 **회전 음성
      안내(waypoints)가 아예 없다.** ⑬ 활성화 전에 BE가 각 후보에 대해서도
      `build_navigation_segments`+waypoint 생성을 돌려 붙여줘야 한다.
