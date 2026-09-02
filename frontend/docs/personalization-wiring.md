# 개인화 파일럿 — 연결 가이드 (⑬⑭⑮)

작성: FE 개인화 작업 (⑪⑫ 완료·검증됨, ⑬⑭⑮ 빌딩블록 완료·미연결)

이 문서 하나면 **백엔드가 준비된 뒤 화면 3개를 앱 흐름에 붙이는 데 필요한 모든 것**이 있다.
핵심 원칙: `src/personalization/config.ts` 의 플래그가 전부 `false` 인 동안 앱 동작은 지금과 100% 동일하다.
연결은 (1) 플래그 켜기 + (2) 아래 **PENDING_WIRE** 목록대로 WIP 파일에 한 줄씩 추가, 이 두 가지뿐이다.

```
git grep "PENDING_WIRE"      # 코드에 박아둔 마커 전부 보기
node --import ./scripts/_register-ts-hook.mjs scripts/verify_instrumentation.mjs   # 순수 로직 63개 체크
```

---

## 1. 완료 상태

| 항목 | 상태 | 파일 |
| --- | --- | --- |
| ⑪ 경사 bin 계측 | ✅ 커밋·검증 (`7d6bd14`, `8f6deb7`) | `src/utils/slopeBinTracker.ts`, `NavigationScreen.tsx` |
| ⑫ 배치 전송(큐·플러시·오프라인·멱등) | ✅ 커밋·검증 | `src/utils/collectQueue.ts`, `src/api/collect.ts` |
| ⑬ 3경로 비교 — 로직/API/화면 | ✅ 빌딩블록 (`3f4a5ed`) · ⛔ 미연결 | `routeChoiceModel.ts`, `api/routeCompare.ts`, `screens/route/RouteCompareScreen.tsx`, `app/route-compare.tsx` |
| ⑭ 구간 평가 — 로직/화면 | ✅ 빌딩블록 · ⛔ 미연결 | `segmentFeedbackModel.ts`, `screens/route/SegmentFeedbackScreen.tsx`, `app/segment-feedback.tsx` |
| ⑮ 왕복·방향 교대 — 로직/배너 | ✅ 빌딩블록 · ⛔ 미연결 | `utils/roundtripHint.ts`, `personalization/RoundtripHintBanner.tsx` |
| 진입 헬퍼 (플래그 게이트) | ✅ | `src/personalization/entry.ts` |

---

## 2. 백엔드 의존성 (구현되면 확인/수정할 것)

전부 `src/personalization/config.ts` 한 파일에 상수로 모아뒀다. 실제 응답과 이름이 다르면 **거기만** 고친다.

| 상수 | 현재값 | 확인 포인트 |
| --- | --- | --- |
| `COLLECT_BATCH_PATH` | `/collect/batch` | 인계 §3.1 그대로. 배치 스키마(`slope_observations`/`speed_samples`/`route_choice`/`segment_feedback`)는 `src/api/collect.ts` 타입과 일치해야 함 |
| `ROUTE_PATH` + `ROUTE_CANDIDATES_KEY`=`candidates` + `ROUTE_CANDIDATES_COMPARE`=`compare` | — | `POST /route` 에 `candidates:"compare"` 지원 (ando-BE `app.py`) |
| `CANDIDATE_ROUTES_FIELD` | `candidateRoutes` | compare 응답의 후보 배열 키 |
| `CANDIDATE_FIELD.*` | `kind`/`coordinates`/`totalDistance`/`avgSlope`/`estimatedTimeS`/`routeSegments` | 후보 1개의 필드명. BE 가 snake_case 로 주면 여기서 매핑 |

**⑬의 실질 블로커**: 지금 `candidateRoutes` 는 `kind:"type"` **1개만** 채워진다(BE TODO: 거리 metric ②, 개인 metric ③).
→ 2개 이상 채워지기 전엔 `ROUTE_COMPARE_ENABLED` 를 켜도 "경로 A" 1장(=비교 없음)만 뜬다.
`RouteCompareScreen` 은 배열을 그대로 순회하므로 후보가 늘면 코드 수정 없이 2~3장이 된다.

**⑭⑮는 BE 무관** — `segment_feedback` 는 `route_id`(기존 `/navigation/start` 응답)로 연결되고,
⑮는 로컬 카운터만 쓴다. 지금 켜도 동작한다.

---

## 3. PENDING_WIRE — WIP 파일에 추가할 한 줄들

> WIP 파일(다른 사람이 작업 중)이라 여기서 직접 수정하지 않았다. 아래대로 넣으면 된다.
> 전부 플래그 게이트라, 플래그가 꺼져 있으면 넣어도 동작 변화 없음(안전).

### PENDING_WIRE(walk-compare) — ⑬ 진입

**파일**: `src/screens/route/WalkContent.tsx` · **함수**: `handleStartNavigation` (현재 working tree ~L473)

```tsx
// 파일 상단 import 에 추가
import { goToRouteCompareIfEnabled } from "../../personalization/entry";

const handleStartNavigation = () => {
  if (!selectedRouteObj) return;

  // ▼ 추가: 비교 화면이 켜져 있으면 그쪽으로 보내고 여기서 끝낸다
  if (goToRouteCompareIfEnabled(navigation, {
    from, to, walkerType,
    startName, startAddress, startLatitude, startLongitude,
    endName, endAddress, endLatitude, endLongitude,
  })) return;
  // ▲ 추가 끝 — 아래는 기존 코드 그대로

  navigation?.navigate('Navigation', { /* ... 기존 ... */ });
};
```

`RouteCompareScreen` 이 선택 후 `navigation.navigate("Navigation", { ..., collectSessionId, routeData })` 로
같은 세션을 이어서 넘긴다. (`app/route-compare.tsx` 어댑터가 `router.replace("/navigation")` 처리)

### PENDING_WIRE(nav-segfeedback) — ⑭ 진입

**파일**: `src/screens/NavigationScreen.tsx` · **함수**: `handleRatingSubmit`, `handleRatingSkip` (현재 ~L1171, ~L1176)

두 곳의 `navigation?.navigate("RouteDetail", { routeId: savedRouteId });` 를 아래로 교체:

```tsx
// 파일 상단 import
import { routeAfterRating } from "../personalization/entry";

// handleRatingSubmit / handleRatingSkip 의 마지막 줄을 교체
routeAfterRating(navigation, {
  serverRouteId: serverRouteIdRef.current,
  routeSegments,                 // 이미 이 컴포넌트에 있는 normalizeSegments 결과
  nextRouteId: savedRouteId,
});
```

`routeAfterRating` 이 `SEGMENT_FEEDBACK_ENABLED` + 경사 뚜렷한 구간 유무를 보고
`SegmentFeedback`(→ 그 다음 `RouteDetail`) 또는 곧장 `RouteDetail` 로 보낸다.
`app/navigation.tsx` 의 `navigate` 어댑터에 **`SegmentFeedback` 케이스 추가 필요**:

```tsx
if (screenName === "SegmentFeedback") {
  router.replace({ pathname: "/segment-feedback", params: screenParams });
  return;
}
```

### PENDING_WIRE(nav-roundtrip) — ⑮ 진입

**파일**: `src/screens/NavigationScreen.tsx` · **위치**: 최상단 오버레이 (`<View style={ss.topOverlay}>` 근처, ~L1221)

```tsx
import RoundtripHintBanner from "../personalization/RoundtripHintBanner";

// return( ... ) 안, topOverlay 형제로
<RoundtripHintBanner from={from} to={finalDestinationName ?? to} />
```

`ROUNDTRIP_HINT_ENABLED` 가 false 면 `null` 을 렌더하므로 넣어도 무해.
방향 카운터(`@ando/roundtrip_seq`)는 배너가 마운트될 때 1 증가한다(세션당 1회).

> ⑮ 심화(선택): 역방향일 때 출발/도착을 실제로 바꾸려면 `orientEndpoints()` 를
> 경로 요청 직전에 적용. 파일럿에선 "안내 문구"만으로 충분(문서 §3.5 는 *안내* 라고 명시).

---

## 4. expo-router 페이지 (이미 추가됨)

| 경로 | 파일 | 필요한 params |
| --- | --- | --- |
| `/route-compare` | `app/route-compare.tsx` | `from,to,walkerType,startName,startAddress,startLatitude,startLongitude,endName,endAddress,endLatitude,endLongitude` |
| `/segment-feedback` | `app/segment-feedback.tsx` | `routeSegments`(JSON), `serverRouteId`, `nextRouteId` |

두 페이지 모두 `navigation` 어댑터를 자체 포함. `app/navigation.tsx` 에는 위 3.2의
`SegmentFeedback` 케이스만 추가하면 된다.

---

## 5. 연결 순서 (BE 준비 후)

1. `segment_feedback`(⑭)·⑮ 부터 — BE 무관. `SEGMENT_FEEDBACK_ENABLED`/`ROUNDTRIP_HINT_ENABLED` = true,
   PENDING_WIRE(nav-segfeedback), PENDING_WIRE(nav-roundtrip) 적용. `app/navigation.tsx` 케이스 추가.
2. BE 가 `candidateRoutes` 를 2개 이상 채우면 — `ROUTE_COMPARE_ENABLED` = true,
   PENDING_WIRE(walk-compare) 적용.
3. `config.ts` 계약 상수를 실제 응답과 대조 (필드명/경로).
4. 파일럿 3세션 걷고 Supabase 에서 로그 전수 검증:
   ```sql
   select * from trip_slope_observations where session_id = 'sess-…' order by id;
   select count(*), sum(sub_distance_m) from speed_samples where session_id = 'sess-…';
   select * from route_choice_log where session_id = 'sess-…';
   select * from segment_feedback where route_id = <id> order by id;
   ```
   확인: bin 경계 0.5% 단위 / `sum(distance_m)` ≈ 경로 총거리 / `sum(elapsed_ms)` ≈ 총 안내시간.
