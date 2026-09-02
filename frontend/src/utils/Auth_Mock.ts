export async function getAuthToken(): Promise<string> {
  return "mock-firebase-token-juyeong-12345";
}

export async function loginToBackend(idToken: string) {
  return {
    uid: "user_juyeong_999",
    email: "juyeong@ando.com",
    display_name: "주영",
    user_type: "manual_wheelchair",
  };
}