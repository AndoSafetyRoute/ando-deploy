# 개인화 파일럿 — FE → BE 전달 사항

FE(`ando-FE` / `gdy/fe-personalization`) 개인화 작업 기준. 근거: `ando_ml_plan_v2.md`, `인계 문서`.
FE 코드는 ⑪⑫ 완료·검증, ⑬⑭⑮ 빌딩블록 완료(플래그 off, 연결만 남음).

---

## A. 지금 확인 필요 — 계약 일치

FE가 코드로 고정해 둔 스키마. BE 응답/스펙과 **이름·타입이 다르면 알려주면** FE는
`src/personalization/config.ts` 상수 + `src/api/collect.ts` 타입만 고치면 된다.

### A-1. `POST /collect/batch` (인계 §3.1) — FE 가 보내는 본문

```jsonc
{
  "session_id": "sess-<ts>-<rand>",   // FE 생성. 재전송 시 동일값 그대로
  "seq": 0,                            // 플러시마다 0,1,2…
  "slope_observations": [
    { "route_id": 42|null, "slope_bin": 2.5, "distance_m": 25.0,
      "elapsed_ms": 30000, "stop_ms": 0, "gps_sample_n": 6 }
  ],
  "speed_samples": [
    { "route_id": 42|null, "slope_bin": 2.5, "sub_distance_m": 8.3, "speed_ms": 0.55 }
  ],
  "route_choice": {                    // 비교 안 했으면 null
    "candidates": [
      { "kind": "type", "profile": [{ "bin": 2.5, "length_m": 25.0 }],
        "length_m": 300.0, "shown_pos": 1 }
    ],
    "n_shown": 2,
    "chosen_kind": "type"|null
  },
  "segment_feedback": [
    { "route_id": 42|null, "slope_mean": 6.2, "length_m": 90.0, "verdict": -1 }
  ]
}
```

- 헤더 `Authorization: Bearer <firebase_id_token>` 필수(없으면 401), FE 는 재시도 큐에 넣음.
- **멱등**: FE 는 실패한 배치를 `(session_id, seq)` 그대로 재전송한다. `collect_batch_log`
  로 중복 무시하고 `{"ok":true,"duplicate":true}` 만 주면 FE 가 큐에서 제거한다.
- `route_id`, `stop_ms` 는 생략 가능. `verdict` 는 -1/0/+1 정수.

### A-2. `POST /route` with `candidates:"compare"` (인계 §3.2)

FE 가 **비교 화면에서만** 호출. 대중교통 도보(`/route/safe`, `requestWalkLeg`)엔 절대 안 붙임 —
BE 도 `/route/safe` 에는 compare 로직 넣지 말 것.

FE 가 읽는 필드 (`candidateRoutes[i]`):

| 필드 | 용도 |
|---|---|
| `kind` (`"type"`\|`"distance"`\|`"personal"`) | 로그(`route_choice.chosen_kind`)에만. 화면엔 절대 노출 안 함 |
| `coordinates` `[lng,lat][]` | 지도 폴리라인 |
| `totalDistance`, `avgSlope`, `estimatedTimeS` | 카드 표시 |
| `routeSegments` (`slope` 부호포함 + `length`/`length_m`) | 경사 히스토그램 + 안내 계측 입력 |

- **FE 는 `candidateRoutes` 를 배열로 순회한다.** 3개 고정 아님. 지금은 1개(`kind:"type"`)만
  와서 화면에 "경로 A" 1장(= 비교 없음) 만 뜬다.
- (가능하면) 각 후보에 `navigation_segments` + `waypoints` 도 실어 주면, 선택한 경로를
  턴바이턴·zone 색칠까지 온전히 안내할 수 있다. 없으면 계측은 되지만 음성/지도색이 빠진다.

---

## B. BE 작업 필요 — FE 가 기다리는 것

### B-1. ⑬ 3경로가 채워져야 비교 화면이 산다  ★블로커
`candidateRoutes` 에 지금 `kind:"type"` 1개뿐. 계획 §6.1/§6.2 + `cch_personalization §3.1`:
- `kind:"distance"` — **8번째 CCHMetric (거리 + 금지구간 배제)** 필요
- `kind:"personal"` — **캐시된 개인 metric** (배치로 구성) 필요

2개 이상 채워지면 FE 는 코드 수정 없이 자동으로 2~3장이 된다. `ROUTE_COMPARE_ENABLED` 플립만.

### B-2. `user_speed_profile` (`v̄_flat`) EMA 갱신 경로 이전  ★확인 필요
FE 가 `POST /navigation/:id/zone`(`submitZoneObservation`) **개별 POST 를 제거**했다
(인계 §5 ⑫ "개별 POST 금지" + §3.6 `trip_zone_observations` 역할 축소).
그 엔드포인트가 EMA 로 `v̄_flat` 을 갱신하던 경로였다.

- §3.8: "신호 A·B 는 동일한 `v̄_flat`(user_speed_profile) 사용" → 학습이 이 값을 읽음
- §3.9: "이후 세션에서도 평지 관측이 들어오면 EMA 로 갱신"

→ **BE 가 `/collect/batch` 의 `slope_bin == 0` 인 `slope_observations` 행으로 `v̄_flat` 을
EMA 갱신**하도록 옮겨야 한다. FE 는 평지 bin 관측을 그대로 보낸다.
`/navigation/:id/zone` 은 FE 가 더는 호출 안 함 → 정리 대상.

### B-3. 학습 파이프라인 — 20m 미만 컷은 학습단에서
§3.4 는 "20m 미만 구간 제외" 지만 **FE 는 안 자르고 전부 보낸다.**
이유: ① 임계값 미확정("파일럿 GPS 로 재확인") ② 관문 검증("거리 합계 = 경로 총합")이
성립하려면 전부 필요 ③ §3.8 "원본 저장, 판정은 학습 시점".
→ 학습 코드가 `distance_m < 20` 필터를 적용하고, 파일럿 데이터로 임계값 재보정.

### B-4. `slope_bin` 은 부호 있는 값
§1.2/§3.5 (내리막 최적점, 왕복 대칭) 근거. `slope_bin`(및 `route_choice` 의 `profile[].bin`)은
부호 포함 0.5% 중심값 (`-2.5`, `0`, `2.5` …). **학습에서 절댓값으로 뭉개면 안 됨.**

### B-5. `route_id` / `session_id` 연결
- `slope_observations`/`speed_samples`: `route_id`(= `/navigation/start` 응답) + `session_id` 둘 다 옴.
  세션 시작 실패 시 `route_id` 는 null → 학습은 `session_id` 로도 그룹핑되어야 함.
- `route_choice_log`: `session_id` 로 연결 (같은 세션의 계측과 짝지음). FE 가 비교→안내에
  같은 `session_id` 를 넘긴다.
- `segment_feedback`: DDL 에 `session_id` 없음 → `route_id` 로만 연결. FE 도 그렇게 보냄. (확인)

---

## C. 합의/결정 필요 — 상수 (문서 §4·§5.6 "C등급: 근거 없음")

FE 가 임시로 박아둔 값. `src/personalization/config.ts` 에 모아둠. 팀 합의 후 확정.

| 상수 | FE 임시값 | 의미 |
|---|---|---|
| bin 폭 | 0.5% | §4 설계상수 — 고정 |
| `NEAR_STOP_SPEED_MS` | 0.15 m/s | 이하이면 `stop_ms` 로 누적 |
| `SPEED_SAMPLE_MAX_GAP_S` | 30 s | 이보다 긴 GPS 공백은 순간속도 표본 제외 |
| `SPEED_SAMPLE_MAX_JUMP_M` | 100 m | 이보다 큰 픽스 이동은 점프로 보고 제외 |
| 20m 컷 (§3.4) | — | 학습단, 값 미확정 (파일럿 재보정) |
| `stop_ms` 산출 | FE 가 bin별 `<0.15m/s` 구간 시간 합산 | 학습에서 `elapsed_ms - stop_ms` = 실이동시간 |

---

## D. 참고

- **캘리브레이션(§3.9)**: 첫 세션 평지 |g|<0.5% 300m 로 `v̄_flat` 확보. FE 안내 UI 미구현
  (별도 화면 vs 기존 안내 통합 — 팀 결정). BE 는 초기 `v̄_flat` 저장 + B-2 의 EMA 갱신.
- **브랜치**: FE `ando-FE/gdy/fe-personalization`. BE `ando-BE/ljy/personalization`
  (= `gdy/seoul-routing` 기준, `integration` 엔 CCH 없음 — 인계 §0.1). 병합 시 base 주의.
- **FE 산출물 위치**: 배치 스키마 `src/api/collect.ts` · 계약 상수 `src/personalization/config.ts`
  · 연결 가이드 `docs/personalization-wiring.md`.
- **9.2절 실측 5종**(인계 §4): WDAC 로 담당자 로컬에서 CCH 안 돌아감 → CCH 빌드 되는
  다른 환경에서 실행 필요. FE 무관하나 7.x/8.4 설계 결정에 필요.
