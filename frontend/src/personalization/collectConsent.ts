// 개인화 데이터 수집 동의 (이슈 #1)
//
// 신호 A~D 수집은 안내 중 GPS 궤적·속도·이동 패턴을 서버에 저장한다. 사용자가
// 명시적으로 동의하기 전에는 CollectSession 을 만들지 않는다(수집 0). 결정은
// AsyncStorage 에 저장하고, 설정에서 언제든 바꿀 수 있다.
//
// 순수 저장 로직만 — UI 는 CollectConsentModal.tsx, 설정 항목은 app/settings.tsx.

import AsyncStorage from "@react-native-async-storage/async-storage";

// 고지 문구가 실질적으로 바뀌면 버전을 올린다 → 기존 사용자에게 다시 물어봄.
const CONSENT_KEY = "@ando/collect_consent_v1";

export type ConsentState = "unknown" | "granted" | "denied";

export async function getCollectConsent(): Promise<ConsentState> {
  try {
    const v = await AsyncStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

export async function setCollectConsent(granted: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied");
  } catch {
    /* 저장 실패 시 다음 기회에 다시 물어봄 */
  }
}

export const CONSENT_TITLE = "개인 맞춤 경로를 위한 데이터 수집";

export const CONSENT_BODY =
  "걷기 편한 경로를 학습하기 위해, 길안내 중 아래 정보를 수집·저장합니다.\n\n" +
  "• 구간별 경사도와 통과 시간·속도 (GPS 기반)\n" +
  "• 경로 선택 결과, 구간에 대한 '편함/불편함' 평가\n" +
  "• 이동 경로의 형태(좌표)\n\n" +
  "수집한 데이터는 개인 맞춤 경사 비용곡선 학습에만 사용합니다. " +
  "회원 탈퇴 시 계정 식별 정보는 삭제되며, 경로·경사 데이터는 " +
  "개인을 특정할 수 없는 형태로 남아 모델 학습에 계속 사용될 수 있습니다.\n\n" +
  "동의하지 않아도 길안내 기능은 그대로 사용할 수 있습니다. " +
  "이 설정은 [설정 > 개인화 데이터 수집]에서 언제든 바꿀 수 있습니다.";
