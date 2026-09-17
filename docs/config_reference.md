# 설정 상수 레퍼런스

ANDO 개인화 실험(S0~S15) 과정에서 도입되는 모든 임계값·설정 상수를 한 곳에
모은다. 항목마다 **값 / 근거 등급 / 근거 / 실기기 검증 상태**를 적는다.

근거 등급:
- **A**: 실기기 데이터로 직접 산출(세션 ID·통계치 인용 가능)
- **B**: 문헌/공식 문서 기반
- **C**: 근거 없음 — 일단 시작값, 실측 후 조정 예정

---

## S0. GPS 수신 간격 개선

파일: `frontend/src/personalization/config.ts`

| 상수 | 값 | 근거 등급 | 근거 | 실기기 검증 |
|---|---|---|---|---|
| `GPS_ACCURACY` | `Location.Accuracy.BestForNavigation` | C | GPS 칩에 가장 짧은 갱신주기를 요청해 OS 스케줄링 여유를 줄이려는 시도. **주의**: 기존 코드는 `Accuracy.High`가 실내·건물 인근에서 GPS 하드웨어 단독 픽스만 기다려 첫 위치 무한 대기를 유발한 known 이슈 때문에 일부러 `Balanced`를 썼었다(`NavigationScreen.tsx` 옛 주석). `BestForNavigation`은 `High`보다도 엄격해 같은 문제가 더 심해질 수 있음 — 미검증. | ⬜ 미검증 |
| `GPS_TIME_INTERVAL_MS` | `1000` | C | 목표(콜백 간격 중앙값 ≤2s) 역산. 기존 `3000ms`도 OS가 하한으로 지키지 않았음(중앙값 6.9s 실측, 아래 근거 A 참고) — 값을 낮춘다고 비례 보장되는 건 아님. | ⬜ 미검증 |
| `GPS_DISTANCE_INTERVAL_M` | `1` | C | 도보 최소 유의 이동량. `0`은 정지 중 GPS 지터만으로 과다 콜백 우려. | ⬜ 미검증 |
| (기존, 변경 없음) `SPEED_SAMPLE_MAX_GAP_S` | `20` | **A** | 실기기 세션 `sess-1789364304261-iy39nwa8`(route 169) `gps_traces` 실측: dt 중앙값 6.9s·p75 12.9s·5s 미만 표본 0건, dt≥10s 콜백 42%(33/78). | 실측 완료(구 설정 기준) |

**Before (실기기 실측, 근거 A)**: 중앙값 6.9s / p75 12.9s / 최대 27.7s (`accuracy: Balanced, timeInterval: 3000, distanceInterval: 5`).

**After**: 미측정. 로컬 dev Postgres(Docker `ando-local-pg`)가 이 세션 시점에
기동돼 있지 않아 조회 불가했고, 애초에 이 비교엔 **실제 도보 테스트**가
필요합니다(코드 변경만으론 OS 스케줄링 결과를 알 수 없음). 실기기 1회 보행
후 `gps_traces`를 같은 방식으로 집계해 이 표를 채워야 합니다 — 쿼리는
`backend/scripts/gps_interval_report.py` 참고(로컬 dev DB 전용, 미검증 —
DB 미기동으로 실행 확인 못 함).

**foreground service 검토 결과**: 이번 패스에서는 구현하지 않음. 현재 구조는
`Location.watchPositionAsync`(포그라운드 전용)만 쓰고 백그라운드 위치 태스크가
전혀 없어(`TaskManager`/`startLocationUpdatesAsync` 레포 전체 0건), 안내 중
앱이 항상 화면에 떠 있는 게 전제다. 이 경우 콜백 지연의 주 원인은 "백그라운드
전환"이 아니라 "화면 꺼짐에 따른 Doze/절전"일 가능성이 높아, `useKeepAwake()`
(화면 꺼짐 방지)만으로 상당 부분 해소될 것으로 예상 — foreground service는
더 큰 네이티브 구성 변경(알림 상주 등)이 필요해 실기기 테스트로 keep-awake의
효과를 먼저 확인한 뒤 필요성을 재판단하는 게 낫다고 판단.

---

## S1. 걸음 수 수집

파일: `frontend/src/utils/stepRingBuffer.ts`

| 상수 | 값 | 근거 등급 | 근거 |
|---|---|---|---|
| `RING_WINDOW_MS` | `60_000` | C | 스펙 지정값(최근 60초) 그대로 |

## S2. 저속 구간 판정 통합 (stopClassifier)

파일: `frontend/src/utils/stopClassifier.ts`

| 상수 | 값 | 근거 등급 | 근거 | 실기기 검증 |
|---|---|---|---|---|
| `GAP_SEC` | `20` | A(값 자체는 재사용) | 기존 `SPEED_SAMPLE_MAX_GAP_S`와 동일값 — 실기기 세션(sess-1789364304261-iy39nwa8) 실측 근거를 그대로 물려받음 | 재검증 안 함(기존 값 재사용) |
| `STEP_MOVING_MIN` | `3` | C | 창(5~6s) 동안 3걸음 이상이면 이동 확정 — 임의값 | ⬜ 대기 |
| `MIN_SAMPLES` | `3` | C | 스펙 지정값 | ⬜ 대기 |
| `ACC_STOP_MAX` | `15`(m) | C | 스펙 지정값 | ⬜ 대기 |
| `SPREAD_STOP_MAX` | `5`(m) | C | 스펙 지정값 | ⬜ 대기 |
| `NEAR_CROSSING_MAX_M` | `15`(m) | C | 스펙 지정값. **주의**: 횡단보도 노드 거리 데이터 소스가 현재 코드에 없음(그래프에 횡단보도 태그 없음, 확인 불가) — 이 상수 자체는 정의돼 있지만 실제로 값이 공급되는 경로가 아직 없어 `near_crossing`은 항상 `false`로 저장됨. 데이터 소스 마련 전까지는 미완성 기능. |
| `V_STOP_FLOOR` / `V_STOP_PERSONAL_RATIO` / `V_STOP_DEFAULT` | `0.3` / `0.4` / `0.4`(m/s) | C | 스펙 지정값. 개인 평지속도(`user_speed_profile.flat`)가 FE에 연동돼 있지 않아 현재는 항상 기본값(0.4) 사용 — S8/S10에서 개인화 연동 재검토 필요 | ⬜ 대기 |
| `CLASSIFY_WINDOW_SEC` | `6` | C | S0 목표(콜백 간격 중앙값 ≤2s) 달성 전제, 스펙의 "5~6s 중 상단" | S0 실측 결과에 따라 조정 필요 |

**미해결 데이터 갭**: `near_crossing`(횡단보도 근접 여부)을 계산하려면 "가장 가까운 횡단보도 노드까지 거리"가 필요한데, 이 프로젝트의 그래프(`graph.py`)에는 횡단보도를 나타내는 태그가 없다(계단의 `highway=='steps'`처럼 확인해본 적 없음 — 별도 조사 필요). 현재 `classifyElapsed()` 호출부(`NavigationScreen.tsx`)는 이 인자에 항상 `null`을 넘긴다.

## (이후 S3~S15 상수는 해당 항목 작업 시 이 문서에 추가)
