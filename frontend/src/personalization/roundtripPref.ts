// ⑮ 왕복·방향 안내 — 파일럿 테스트 기간에만 쓰는 개인 설정 (이슈: 강제 불가 + R1 불일치).
//
// 예전엔 config.ts 플래그 하나로 항상 켜져 있었다. 지금은:
//   - config.ts::ROUNDTRIP_HINT_ENABLED : 이 기능 자체가 빌드에 존재하는지(개발자 스위치).
//     파일럿이 끝나면 이거 하나만 false 로 내려서 설정 화면 섹션 + 배너를 통째로 숨긴다.
//   - 여기(roundtripPref)                : 테스터 개인이 켰는지(기본 꺼짐, 설정에서 토글).
// 둘 다 켜져 있을 때만 RoundtripHintBanner 가 뜬다.

import AsyncStorage from "@react-native-async-storage/async-storage";

const PREF_KEY = "@ando/roundtrip_pref_v1";

export async function getRoundtripPref(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PREF_KEY)) === "on";
  } catch {
    return false;
  }
}

export async function setRoundtripPref(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* 저장 실패해도 이번 세션 상태는 호출부(useState)가 들고 있으니 무방 */
  }
}
