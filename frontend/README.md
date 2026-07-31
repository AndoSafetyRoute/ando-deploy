# Ando 프론트엔드 (Expo / React Native)

## 요구사항

- Node.js 18+ / npm
- Android Studio (에뮬레이터 또는 실기기 USB 디버깅용 adb)
- 실기기 테스트 시 PC와 같은 Wi-Fi 네트워크

## 1. 의존성 설치

```bash
npm install
```

## 2. 환경변수 설정

```bash
cp .env.example .env
```

`.env`에 채워야 하는 값:

| 변수 | 어디서 얻나 |
|---|---|
| `EXPO_PUBLIC_KAKAO_JAVASCRIPT_KEY` | [카카오 개발자 콘솔](https://developers.kakao.com) → 내 애플리케이션 → 앱 키 → JavaScript 키 |
| `EXPO_PUBLIC_KAKAO_REST_API_KEY` | 같은 페이지 → REST API 키 |
| `EXPO_PUBLIC_ROUTE_API_URL` | 백엔드(`ando-BE`) 서버 주소. 실기기 테스트 시 에뮬레이터가 아니라 PC의 사설 IP를 써야 함 (예: `http://192.168.0.10:5000`). PC IP는 `ipconfig`로 확인 |
| `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase 프로젝트 → Settings → API |

카카오 앱 키는 카카오 개발자 콘솔에서 **플랫폼 등록**(Android 패키지명 `com.ando.front` + 키 해시)이
되어 있어야 실기기에서 지도/검색이 정상 동작합니다.

## 3. Firebase 설정 파일 (google-services.json)

Firebase 콘솔에서 이 프로젝트의 Android 앱(`com.ando.front`)에 대한 `google-services.json`을
다운로드해서 레포 루트(`frontend/google-services.json`, `app.json`이 있는 위치)에 넣어주세요.
이 파일은 git에 포함되어 있지 않습니다.

Google 로그인을 쓰려면 Firebase 콘솔의 Authentication → Sign-in method → Google이 활성화되어
있어야 하고, 실기기로 서명한 키의 SHA-1/SHA-256 지문이 Firebase 프로젝트 설정에 등록되어 있어야
합니다 (등록 안 돼 있으면 Google 로그인만 실패하고 나머지 기능은 정상 동작).

## 4. 실행

```bash
# 최초 1회 (android/ 폴더가 없으면) 네이티브 프로젝트 생성 + 실기기/에뮬레이터에 설치
npx expo run:android

# 이후에는 Metro만 다시 띄우면 됨
npx expo start --dev-client
```

실기기 USB 연결 시 PC와 폰이 다른 네트워크에 있어도 되도록 하려면:

```bash
adb reverse tcp:8081 tcp:8081   # Metro 번들러
adb reverse tcp:5000 tcp:5000   # 백엔드가 로컬(PC)에서 돌고 있다면
```

이 경우 `.env`의 `EXPO_PUBLIC_ROUTE_API_URL`을 `http://localhost:5000`으로 바꿔도 됩니다.

## 프로젝트 구조 메모

- `app/` — expo-router 기반 화면 라우트. 각 파일이 `navigation`/`route` props를 손수 만들어
  `src/screens/`의 실제 화면 컴포넌트에 넘겨주는 어댑터 역할도 겸합니다 (예: `app/navigation.tsx`,
  `app/route.tsx`). 새 파라미터를 화면 간에 넘길 때 이 어댑터에서 빠뜨리기 쉬우니 주의하세요.
- `src/screens/` — 실제 화면 UI/로직
- `src/screens/route/` — 경로 탐색 관련 화면(도보/대중교통/자동차 탭, 지도 미리보기)
- `src/api/` — 백엔드·카카오 API 호출
- `src/constants/colors.ts` — 앱 전역 색상 팔레트. `NAVY`/`LIGHT_GRAY` 계열이 홈/설정/검색 등
  대부분 화면의 기준 배색이고, 경로/안내 화면은 이 파일의 `C` 팔레트를 씁니다.

## 알려진 제한사항

루트 `README.md`의 "알려진 제한사항" 참고 (서울역 인근 도보 경로 우회 문제).
