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

## S3. 신호 A 행 구조 변경

파일: `frontend/src/utils/distanceRowTracker.ts`, `frontend/src/personalization/config.ts`

| 상수 | 값 | 근거 등급 | 근거 | 실기기 검증 |
|---|---|---|---|---|
| `ROW_LEN_M` | `25`(m) | C | 스펙 지정값 | ⬜ 대기 |
| `IMPLIED_SPEED_JUMP_MPS` | `3.0`(m/s) | C | 도보 순간최고속도를 넉넉히 웃도는 선(임의). 기존 `SPEED_SAMPLE_MAX_JUMP_M`(100m 고정거리)을 대체 — dt에 무관한 기준으로 전환 | ⬜ 대기 |
| `JUMP_ACCURACY_MAX_M` | `20`(m) | C | 스펙 지정값 | ⬜ 대기 |

**행 구조 변경 요약**: `slope_bin`(0.5% 폭 bin 변화 시 방출) → 고정거리 25m마다 방출. 저장값도 `slope_bin` 단일값 대신 `slope_mean`(거리가중평균)·`slope_max`(절댓값 최대)·`ascent_m`/`descent_m`(연속값)로 변경 — bin은 학습 시점에 `slope_mean`으로부터 계산(FE는 더 이상 bin을 모름). `trip_slope_observations.slope_bin` 컬럼은 nullable로 완화(기존 행 보존, 신규 행은 NULL).

**1행 지연 스트리밍**: 경로 끝의 자투리(<25m)를 "짧은 행 단독 방출" 대신 직전 행에 병합하기 위해, `DistanceRowTracker.completeSegment()`는 "방금 완성된 행"이 아니라 "그 직전에 완성됐던 행"을 반환한다(`finalize()`가 마지막 보류 행 + 자투리를 병합해 마무리). 헤드리스 테스트(`frontend/scripts/distanceRowTracker_test.ts`)로 검증 완료.

## S4. 신호 D 질문 구성 (순위 + 무작위 대조)

파일: `backend/database.py`

| 상수 | 값 | 근거 등급 | 근거 |
|---|---|---|---|
| `SLOW_SEG_MAX_RANKED`(기존) | `5` | C | 유지 |
| `SLOW_SEG_RANDOM` | `2` | C | 스펙 지정값 |

**랭킹 기준 변경**: `_route_measurement_groups`/`_slow_seg_eligible`이 이제
`navigation_measurements.valid`/`facility`/`moving_ms`를 직접 읽는다 — 랭킹
대상은 `valid=true AND facility=false`만, 정렬은 `moving_ms`(정지시간 제외 이동
시간) 기준 pace. **주의**: 이 컬럼들은 S2가 채우므로, S2 도입 이전 행(`valid`
NULL)은 이 필터에서 자동 제외된다 — 과거 데이터로는 D 랭킹이 비어 보일 수 있음.

**seed 재현성**: `_rank_and_store_slow_segments(seed=...)`에 seed를 안 주면
`random.SystemRandom()`으로 새로 뽑아 DB에 저장 — 같은 seed로 재호출하면
순위 대조 선정·제시 순서(question_order)가 완전히 동일함을 테스트로 확인
(`backend/scripts/slow_segments_v2_test.py`).

## S5. "가장 힘들었던 구간" 문항

파일: `frontend/src/screens/route/SegmentHardestPickScreen.tsx`,
`backend/database.py::save_segment_hardest_pick`

- 3버튼 흐름(`segment-hardship-feedback`)과 **분리된 엔드포인트**로 구현 —
  문항 저장 단위가 "구간마다 1개"가 아니라 "경로 전체에서 1개"라 애초에
  스키마가 다르고, 둘 다 실패해도 서로 무관하게 재시도 가능한 게 더 단순함.
- `segment_hardest_pick`은 `route_id`당 1행(upsert) — 재제출하면 덮어씀.
- 검증: `backend/scripts/segment_hardest_pick_test.py`(저장/조회/upsert/소유자
  검증/제약조건 위반 케이스) 전부 통과.
- **에뮬레이터 화면 흐름 미검증**: 이 세션에서 Metro가 메모리 부족으로 한 번
  죽어 재현 위험을 피하려고 라이브 UI 테스트를 하지 않았다 — 코드는 기존
  `SlowSegmentFeedbackScreen`과 동일 패턴(expo-router 어댑터, RouteMapView
  재사용)으로 작성했고 `tsc --noEmit` 통과까지만 확인함. 실기기/에뮬레이터
  화면 흐름 확인은 `docs/device_verification_pending.md`로.

## (이후 S6~S15 상수는 해당 항목 작업 시 이 문서에 추가)
