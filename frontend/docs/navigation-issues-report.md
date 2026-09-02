# 안내(Navigation) 화면 관련 이슈 정리 — 전달용

작성일: 2026-07-31
대상 파일: `src/screens/route/RouteMapView.tsx`, `src/screens/NavigationScreen.tsx`, `src/screens/route/TransitContent.tsx`

---

## 1. 지도 줌인이 안 되던 문제 (도보/대중교통 탭 공통)

### 증상
경로 탐색 화면(도보 탭, 대중교통 탭)의 미리보기 지도에서 `+`/`-` 버튼을 눌러도 확대/축소가 적용되지 않고 항상 원래 화면으로 돌아왔다.

### 시도 1 — 통신 방식 교체 (근본 원인 아니었음)
초기에는 RN→WebView 통신에 `postMessage` 브릿지를 썼는데, 이 앱에서 검증 안 된 유일한 통신 경로였다. `injectJavaScript` + `window` 전역함수 방식(이 앱의 다른 곳에서 이미 안정적으로 쓰이던 패턴)으로 교체했다.

```ts
// RouteMapView.tsx
window.zoomIn  = function () { if (map) map.setLevel(map.getLevel() - 1); };
window.zoomOut = function () { if (map) map.setLevel(map.getLevel() + 1); };
```
```tsx
onPress={() => webviewRef.current?.injectJavaScript('if(window.zoomIn){window.zoomIn();}true;')}
```
→ 이걸로도 해결 안 됨.

### 시도 2 — 진단 로그 추가 → 근본 원인 발견
버튼 클릭 자체가 되는지, `window.zoomIn`이 존재하는지, 실제 줌 레벨이 바뀌는지를 각각 확인하는 로그를 추가:

```tsx
onPress={() => {
  console.log('[RouteMapView] + 버튼 눌림');
  webviewRef.current?.injectJavaScript(
    "var __before = map ? map.getLevel() : null; if(window.zoomIn){window.zoomIn();} " +
    "var __after = map ? map.getLevel() : null; " +
    "window.ReactNativeWebView.postMessage('zoomIn: ... level ' + __before + '→' + __after); true;"
  );
}}
```

실제 로그 결과:
```
LOG  [RouteMapView] + 버튼 눌림
LOG  [RouteMapView][WebView] zoomIn: window.zoomIn존재=true map존재=true level 7→6
LOG  [RouteMapView] + 버튼 눌림
LOG  [RouteMapView][WebView] zoomIn: window.zoomIn존재=true map존재=true level 7→6
```

버튼도 눌리고, 함수도 존재하고, 레벨도 바뀌는데(`7→6`) **두 번 다 "7→6"** — 즉 다음 클릭 전에 항상 7로 되돌아가 있었다.

### 근본 원인
지도 초기화 시 등록한 `tilesloaded` 이벤트 리스너가 지도 수명 내내 살아있었다:

```js
// 기존 코드
kakao.maps.event.addListener(map, 'tilesloaded', fitToBounds);
```

`tilesloaded`는 최초 로딩뿐 아니라 **줌/드래그로 타일이 다시 로드될 때마다** 발생한다. 사용자가 줌인하면 타일이 새로 로드되고, 그때마다 `fitToBounds()`가 다시 호출돼서 원래 경로 범위(레벨 7)로 즉시 되돌리고 있었다.

### 수정
초기 레이아웃 안정화 기간(3초)만 리스너를 유지하고 이후 제거:

```js
if (kakao.maps.event && map) {
  var tilesLoadedHandler = function () { fitToBounds(); };
  kakao.maps.event.addListener(map, 'tilesloaded', tilesLoadedHandler);
  setTimeout(function () {
    kakao.maps.event.removeListener(map, 'tilesloaded', tilesLoadedHandler);
  }, 3000);
}
```
겸사겸사 `kakao.maps.Map` 생성 옵션에 `zoomable: true, draggable: true`도 명시적으로 추가함(원래도 기본값이 true라 원인은 아니었음).

### 상태
**원인 확정 및 수정 완료.** 재테스트 필요.

---

## 2. 대중교통 안내 화면에서 "환승 이후 구간부터만" 보이는 문제

### 배경 — 두 개의 다른 지도가 있음
- **미리보기 지도** (`TransitContent.tsx` → `RouteMapView`, "안내 시작" 누르기 전): 이전 작업에서 전체 여정(도보+탑승+도보)을 구간별 색상으로 이미 표시하도록 구현됨(`mapSegments`).
- **실제 안내 지도** (`NavigationScreen.tsx`, "안내 시작" 누른 후): **애초에 도보 구간 하나만 GPS로 안내하도록 설계된 화면**. 대중교통 경로는 도보1(승차 지점까지) → 탑승(GPS 추적 불가) → 도보2(하차 후) 구조라, `handleStartNavigation`이 도보 구간마다 별도의 `NavigationScreen` 인스턴스로 순차 진입시킨다. 탑승 구간 자체는 이 화면에 그려진 적이 없다.

### 결정된 방향
사용자가 "전체 지도를 이 화면에서 재설계"(옵션 A) 대신 **"상단에 진행률 스테퍼 UI"**(옵션 B)로 결정 → 스테퍼는 별도 구현 완료(아래 참고).

### 이번 시도 — 지도에도 전체 경로를 옅은 참고선으로 표시
스테퍼(텍스트 정보)만으론 "지도 자체가 부분적으로만 보인다"는 체감이 남을 수 있어서, 이미 계산해둔 전체 여정 좌표(`routeToMapCoordinates(currentRoute)`, 미리보기 지도와 동일한 데이터)를 `NavigationScreen`으로 같이 넘겨서, 지금 GPS로 추적 중인 구간(선명한 색) 아래에 전체 여정을 옅은 회색 점선으로 깔아주도록 함:

```ts
// TransitContent.tsx — handleStartNavigation
const journeyMapPathJson = JSON.stringify(routeToMapCoordinates(currentRoute));
// preWalkParams/postWalkParams/스텁 params 전부에 journeyMapPath로 실어보냄
```
```js
// NavigationScreen.tsx — makeKakaoMapHtml
if (journeyPath.length > 1) {
  new kakao.maps.Polyline({
    map: map, path: journeyLatLngs,
    strokeWeight: 4, strokeColor: "#9E9E9E",
    strokeOpacity: 0.5, strokeStyle: "shortdash"
  });
}
```

### 남는 한계
- 이 참고선은 **순수 시각 정보**다 — GPS 추적, 음성안내, 구간 색칠(zone) 대상은 여전히 "지금 안내 중인 도보 구간"뿐이다.
- 도보 구간이 아예 없는 순수 버스/지하철 경로(스텁 케이스)는 `coordinates`가 비어있어 지도 자체가 안 뜨고 스테퍼 텍스트로만 안내된다 — 구조적으로 어쩔 수 없음.
- "탑승 구간까지 지도에서 진짜로 함께 그리고 싶다"면 옵션 A(설계 변경)가 필요하다 — 지금은 절충안(참고선)까지만 반영.

### 상태
**절충 수정 완료.** 재테스트 필요. 완전한 해결(옵션 A)을 원하면 별도 논의 필요.

---

## 3. 안내 화면 퍼센트(%) 버튼 — on/off 아이콘 구분

### 요청 내용
아이콘 자체는 켜짐/꺼짐 둘 다 살리되, 버튼 색으로만 구분해서 더 알아보기 편하게.

### 확인 결과
`NavigationScreen.tsx`에 이미 이 방식으로 구현되어 있음(아이콘은 항상 `%`, 색만 전환):

```tsx
<TouchableOpacity style={[ss.voiceBtn, showSlopeMarkers && ss.slopeBtnActive]} onPress={...}>
  <Text style={[ss.voiceIcon, showSlopeMarkers && ss.slopeIconActive]}>%</Text>
</TouchableOpacity>
```
```ts
slopeBtnActive:  { backgroundColor: C.primary },   // 켜짐: 보라 배경
slopeIconActive: { color: "#FFFFFF", fontWeight: "800" }, // 켜짐: 흰 글씨, 굵게
// 꺼짐: 기본 흰 배경 + 어두운 글씨
```
`RouteMapView.tsx`(미리보기 지도의 % 버튼)도 동일 패턴(`mapControlBtnActive`/`mapControlIconActive`).

### 상태
**요청하신 방식대로 이미 구현되어 있음.** 실기기에서 색 대비가 부족해 보이면 알려주시면 대비를 더 키우겠습니다.

---

## 4. 버스 번호 표시

### 요청 내용
탑승 구간에 버스 번호도 보여줬으면 좋겠음.

### 확인 결과
이미 여러 곳에 표시되고 있음:
- **여정 스테퍼**(`NavigationScreen` 상단): `${busNo} ${duration}분` 형식 (예: "163번 8분")
- **경로 상세 스텝 목록**(`TransitContent.tsx`): 버스 배지로 `step.busNo` 표시
- **저상버스 알림**: `${busNo} 저상버스 운행 확인됨` 형식

```ts
// TransitContent.tsx — journeySteps 생성부
else if (seg.type === 'bus' && step?.busNo) label = `${step.busNo} ${seg.duration}분`;
```

### 상태
**이미 구현되어 있음.** 원하시는 위치(예: 지도 위 오버레이 등)가 따로 있다면 말씀해 주세요.

---

## 요약

| # | 이슈 | 상태 |
|---|---|---|
| 1 | 지도 줌인 안 됨 | 근본 원인 확정(`tilesloaded` 리스너 무한 재실행) + 수정 완료 |
| 2 | 대중교통 안내 화면 부분 표시 | 절충 수정 완료(옅은 전체 경로 참고선 추가). 완전 해결은 별도 설계 필요 |
| 3 | % 버튼 색 구분 | 이미 구현되어 있음 (확인만) |
| 4 | 버스 번호 표시 | 이미 구현되어 있음 (확인만) |

전체 재기동 후 렌더 에러 없는 것까지 확인했습니다. 실기기 재테스트 부탁드립니다.
