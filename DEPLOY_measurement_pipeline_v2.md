# 측정 파이프라인 v2 배포 인수인계

GPS 실측 소요시간 측정 방식 개편 — 교차로 기준 구간(`navigation_segments`) 대신
**누적거리 30m+ 단위(`MeasurementUnit`)**로 GPS 통과를 판정해 `navigation_measurements`에
기록하고, 원본 GPS 궤적도 `gps_traces`로 별도 수집한다. 개인화 속도모델(신호 A,
`user_speed_profile`)은 이 파이프라인과 완전히 독립이라 영향 없음.

이 문서 기준 코드는 **작성 완료·타입체크/컴파일 통과**, **아직 커밋 안 됨**
(`release_v8` 브랜치 작업트리에 있음). 커밋·푸시는 별도 확인 후 진행할 것.

---

## 0. 무엇이 바뀌었나

| 파일 | 변경 |
|---|---|
| `backend/routing/measurement_units.py` | **신규.** raw edge(5~10m)를 누적거리 30m+ 단위로 분할, 거리가중평균 경사 계산 |
| `backend/app.py` | `/navigation/start`(세션 발급) · `/navigation/{id}/segment`(신 스키마: `session_id`/`unit_index`/`status`) · `/navigation/{id}/complete`(`reached_destination`로 `completed`/`completed_partial` 분기) · `/collect/gps-batch`(신규) |
| `backend/database.py` | `start_session` · `add_navigation_measurement` · `save_gps_batch` · `_route_measurement_groups`/`_rank_and_store_slow_segments`(navigation_measurements 기반 느린구간 랭킹) · `complete_navigation`(FE 벽시계 시간 안 믿고 BE가 집계) · **테이블 정의 5개**(§1) |
| `frontend/src/api/gpsTrace.ts` | **신규.** GPS 원본 배치 전송 (`/collect/gps-batch`) |
| `frontend/src/utils/gpsTraceBuffer.ts` | **신규.** GPS 원본 버퍼링(30초/50행 트리거, 실패 시 버림 — 재큐잉 없음) |
| `frontend/src/api.ts` | `MeasurementSegmentPayload`(신규 타입) + `submitSegment` 신 스키마 전송, `completeNavigation`에 `reachedDestination`/`sessionId` 추가 |
| `frontend/src/api/routeApi.ts` | `MeasurementUnit` 타입, `RouteResponse.measurement_units` |
| `frontend/src/screens/NavigationScreen.tsx` | GPS 콜백 안에 **measurementUnits 전용 독립 도착판정 루프**(신호 A/routeSegments 루프와 완전 분리) — catch-up/GPS공백 오염 시 `status='skipped'`, 초기화, 동의 게이트(§2), `reachedDestination` 판정 |
| `frontend/src/screens/route/SlowSegmentFeedbackScreen.tsx` | `route_slow_segments.seg_index`가 이제 `unit_index`를 가리키므로 하이라이트·위치설명을 `measurementUnits` 배열로 직접 인덱싱하도록 변경 |
| `frontend/src/personalization/entry.ts` | `routeAfterRating`이 `measurementUnits`를 `SlowSegmentFeedback` 화면 파라미터로 전달 |

---

## 1. DB 스키마 — 자동 생성됨, 단 1곳 확인 필요

`backend/database.py`의 `init_db()`가 서버 부팅 시(`app.py` lifespan, DB 실패해도
부팅은 계속됨) 아래 5개 테이블을 `CREATE TABLE IF NOT EXISTS`로 자동 생성한다.
**별도 마이그레이션 스크립트 실행 불필요.**

- `sessions` — 측정 세션(안내 1회 = 세션 1개), PK `session_id`
- `navigation_measurements` — unit별 실측/스킵, `UNIQUE(route_id, unit_index)`, `CHECK status IN ('measured','skipped','in_progress')`
- `gps_traces` — GPS 원본 궤적, PK `(session_id, seq)`
- `gps_batch_log` — gps-batch 수신 로그(멱등용), PK `(uid, session_id, seq)`
- `route_slow_segments` — 기존 테이블 재사용(신규 아님), `seg_index` 의미만 raw edge → `unit_index`로 바뀜

> ⚠️ **`gps_batch_log`는 코드에 자체 경고가 남아 있음**(`database.py:564`):
> "정확한 컬럼 목록을 Supabase 콘솔 실제 스키마와 대조 확인 필요." `sessions`/
> `navigation_measurements`/`gps_traces`는 "Supabase 콘솔에서 먼저 생성·검증한
> 스키마를 그대로 반영"이라고 돼 있어 신뢰도가 높지만, `gps_batch_log`만 미검증
> 상태로 남아 있다. **배포 후 첫 GPS 배치 전송에서 `/collect/gps-batch` 500 여부로
> 실제 확인할 것** — `CREATE TABLE IF NOT EXISTS`는 테이블이 이미 다른 구조로
> 존재하면 조용히 아무것도 안 하므로, 컬럼이 안 맞으면 첫 INSERT에서만 터진다.

---

## 2. 동의 게이트 변경 (프라이버시 — 컴플라이언스 수정, 단순 리팩터 아님)

기존 코드는 `route.params.collectSessionId`를 개인화 데이터 수집 동의 여부와
무관하게 `/navigation/start`·`submitSegment`에 그대로 실어 보냈다. 이는
`collectConsent.ts`의 동의 문구(`CONSENT_BODY`) — **"구간별 경사도와 통과
시간·속도(GPS 기반)"** — 를 명시적 동의 항목으로 적어둔 것과 어긋났다(동의
안 해도 서버에 `sessions`/`navigation_measurements` 행이 생기고 있었음).

**수정 후**: `session_id`는 동의가 `granted`로 확정된 뒤(`collectSessionIdRef.current`)에만
채워진다. 동의 거부/미응답이면 세션 자체가 생성되지 않아 해당 경로는
`navigation_measurements` 0행 — 이건 버그가 아니라 의도된 동작.

**DB에서 "동의 거부"와 "버그로 측정 실패"를 구분하는 법**:
`routes LEFT JOIN sessions ON sessions.session_id = <route의 session_id 없음>`
— `sessions` 자체가 없으면 동의 거부/미응답, `sessions`는 있는데
`navigation_measurements`가 0행이면 버그(§4 모니터링 참고).

---

## 3. 배포 순서

**BE·FE 반드시 동시 배포.** `app.py`에 명시된 원칙 그대로: 구버전 FE(신 스키마
필드 없는 `/navigation/{id}/segment` 요청)는 배포 직후부터 이 엔드포인트가 전부
400/422로 실패한다 — 조용한 데이터 유실보다 드러난 실패를 택한 설계라서, BE만
먼저 올라간 시간 동안 구버전 FE 사용자의 측정 데이터가 그냥 유실된다(안내 기능
자체는 영향 없음).

---

## 4. 스모크 테스트

```bash
BASE=http://localhost:5000
TOKEN=<Firebase idToken>

# 1) 세션 발급 — sessions 행 생성 확인
curl -s -XPOST $BASE/navigation/start -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d \
'{"walker_type":"manual_wheelchair","from_name":"A","to_name":"B","mode":"walk",
  "total_segments":10,"session_id":"smoke-test-1","app_version":"1.0.0","schema_ver":1}'
# → {"route_id": N} 확인 후 DB에서: SELECT * FROM sessions WHERE session_id='smoke-test-1';

# 2) unit 제출 — measured
curl -s -XPOST $BASE/navigation/<route_id>/segment -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d \
'{"session_id":"smoke-test-1","unit_index":0,"distance_m":32.5,"slope_pct":1.2,
  "status":"measured","elapsed_ms":25000}'

# 3) unit 제출 — skipped (elapsed_ms 없이)
curl -s -XPOST $BASE/navigation/<route_id>/segment -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d \
'{"session_id":"smoke-test-1","unit_index":1,"distance_m":30.0,"slope_pct":0.5,"status":"skipped"}'

# 4) GPS 배치
curl -s -XPOST $BASE/collect/gps-batch -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d \
'{"session_id":"smoke-test-1","points":[{"seq":0,"t_ms":1234567890,"lat":37.55,"lon":126.97}]}'

# 5) 완료 — reached_destination=true → status='completed' 확인
curl -s -XPATCH $BASE/navigation/<route_id>/complete -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d \
'{"session_id":"smoke-test-1","reached_destination":true}'
# → SELECT status, total_duration_ms FROM routes WHERE id=<route_id>;  ('completed', 25000 근처)
```

**합격 기준**: 1)에서 `sessions` 행 생성, 2)·3)이 각각 `status='measured'`/`'skipped'`로
`navigation_measurements`에 들어감(3번은 `elapsed_ms IS NULL`), 5)에서 `routes.status='completed'`
및 `total_duration_ms`가 2)에서 넣은 `elapsed_ms` 합과 일치.

---

## 5. 파일럿 데이터 수집 시작 전 체크리스트

### 5-1. 실기기에서 직접 걸어봐야만 검증 가능한 항목

| 항목 | 어떻게 유발 | 정상 기준 |
|---|---|---|
| catch-up → `skipped` | 기내모드 30초+ on/off, 지하도 통과 | 공백 끝나고 첫 unit이 `skipped`(elapsed 없음) |
| unit 0 GPS 락 대기 미포함 | 실내 대기 후 출발 | unit 0 `elapsed_ms`에 대기시간 안 섞임 |
| AppState 백그라운드 복귀 오염 처리 | 화면 끄고 30초+ 후 재점등 | 복귀 직후 첫 unit이 `skipped` |
| 동의 3분기(동의/거부/무응답) | 각각 실제로 눌러봄 | 거부·무응답 시 `sessions`/`navigation_measurements` 0행 |
| 모달 응답 전 도보 시작 | 모달 뜬 채로 걷기 시작, 늦게 답 | 이번 경로만 세션 없이 진행(유실 의도됨), 다음 경로부터 정상 |
| `reached_destination` 참/거짓 | 도착 후 종료 vs 중간 종료 | 각각 `completed`/`completed_partial` |
| 신호A vs unit 두 트랙 독립성 | 아무 도보나 완주 | `navigation_measurements`와 `user_speed_profile` 둘 다 쌓이고 개수/경계 다름 |

### 5-2. 배포 직후 며칠 모니터링할 DB 지표

- `navigation_measurements.status` 분포 — `skipped` 비율 급증 시 GPS 주기/30m 임계값 재검토
- `sessions` 있는데 `navigation_measurements` 0행인 비율 — §2 방식으로 "동의 거부"와 구분해 버그만 추적
- `routes.status='in_progress'` 방치 건수 — 대중교통 멀티레그(§6-1)가 대부분인지, 단일 도보에서도 새로 생기는지
- `elapsed_ms / distance_m` 역산 pace 극단값 — "9.9m/27700ms" 패턴 재발 여부
- `route_slow_segments` 생성률 — 0에 가까우면 `SLOW_SEG_MIN_DIST_M`/`FLAT_THRESHOLD` 재검토
- `completed` vs `completed_partial` 비율 — 조기종료 베이스라인 확보

### 5-3. 알려진 이슈 (지금 안 고침, 코드에 주석 남겨둠)

1. **멀티레그 `in_progress` 잔류** — 대중교통 leg 자동전환 시 이전 leg가 `completeNavigation`을 못 받음(`NavigationScreen.tsx` transitNextLeg 블록에 주석). 기존 발견된 `in_progress` 방치 63건의 원인 중 하나로 추정.
2. **`descSegs` 분모 미포함 outside_seoul** — 하이브리드 경로(서울 밖 출발/도착)에서 느린구간 피드백의 "몇 % 지점" 텍스트가 살짝 어긋날 수 있음(하이라이트 위치는 정확). `SlowSegmentFeedbackScreen.tsx`에 주석.
3. **`measurement_units` 빈 배열 시 경고 로그만** — BE 실패 시 안내는 정상 진행되나 해당 route의 측정이 통째로 빔. `console.warn`만 남김(사용자 알림 없음, 의도적).
4. **`gps_batch_log` 스키마 미검증** — §1 참고.
5. **`total_segments` 필드 미사용** — `NavigationStartRequest.total_segments`는 BE가 저장/사용 안 함(코드에 명시). 정리 대상이나 이번엔 안 건드림.

---

## 6. 롤백

DB 마이그레이션이 `CREATE TABLE IF NOT EXISTS`라 새 테이블이 남아도 기존 엔드포인트
동작엔 영향 없음 — 코드만 이전 커밋으로 되돌리면 됨(`git revert`/이전 커밋 재배포).
새 테이블(`sessions` 등)을 지울 필요는 없다(다음 재배포 때 그대로 재사용됨).

---

## 브랜치 참조

| repo | 브랜치 | 상태 |
|---|---|---|
| ando-deploy | `release_v8` | 이 문서 기준 작업트리 — **미커밋** |

커밋 메시지 초안(원하면 이대로 커밋):
```
feat(measurement): 측정 파이프라인 v2 — 30m+ unit 기반 GPS 실측, gps_traces 원본 수집

- routing/measurement_units.py 신규: raw edge → 누적거리 30m+ MeasurementUnit
- /navigation/start·segment·complete 신 스키마, /collect/gps-batch 신규
- FE: measurementUnits 독립 도착판정 루프, catch-up/GPS공백 skipped 처리,
  동의 게이트를 CONSENT_BODY 문구에 맞춰 수정(session_id를 동의 확정 후에만 전송)
- SlowSegmentFeedbackScreen: unit_index 기반 하이라이트로 인덱스 체계 정합
```
