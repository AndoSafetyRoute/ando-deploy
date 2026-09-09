// 아이디(이메일) 존재 확인 — 준비 코드 (서버 엔드포인트 배선 전)
//
// 원래 계정 찾기 화면은 클라이언트에서 fetchSignInMethodsForEmail() 로 가입
// 여부를 조회했으나, 이 Firebase 프로젝트(ando-auth-db)는 이메일 열거 방지가
// 켜져 있어 항상 빈 배열이 온다 → 가입된 계정도 "없음"으로 표시됨.
//
// 방식 B: 서버가 Admin SDK auth.get_user_by_email() 로 조회한다(열거 방지 무관).
// 대응 백엔드: ando-BE/account_lookup.py 의 GET /auth/check-email
// (app.py 에 include_router 로 배선되면 활성화됨)
//
// 엔드포인트가 아직 없으면 fetch 가 실패/404 → 호출부에서 graceful 하게 처리할 것.

import { BASE_URL } from "../api";

export interface EmailCheckResult {
  email:     string;
  exists:    boolean;
  providers: string[];   // 'password' | 'google.com' | ...
  disabled?: boolean;
}

/** 이메일 가입 여부 + 로그인 제공자 조회. 실패 시 throw (호출부에서 fallback). */
export async function checkEmailRegistered(email: string): Promise<EmailCheckResult> {
  const url = `${BASE_URL}/auth/check-email?email=${encodeURIComponent(email.trim().toLowerCase())}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) {
      // 엔드포인트 미배선 — 준비 코드 상태
      throw new Error("NOT_DEPLOYED");
    }
    if (res.status === 429) {
      throw new Error("요청이 많습니다. 잠시 후 다시 시도해주세요.");
    }
    if (!res.ok) {
      throw new Error(`이메일 확인 실패 (${res.status})`);
    }
    return (await res.json()) as EmailCheckResult;
  } finally {
    clearTimeout(timer);
  }
}
