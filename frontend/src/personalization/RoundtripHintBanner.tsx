// ⑮ 왕복·방향 안내 배너 — 데이터 수집 파일럿 "테스트 기간에만" 쓰는 화면 요소.
//
// 예전엔 세션마다 "정방향/역방향"을 임의로 배정해 문구에 표시했는데, 실제 안내
// 경로(orientEndpoints)는 적용돼 있지 않아 배너 문구와 실제 안내 방향이 어긋났다
// (이슈 R1). 지금은 이번 세션의 실제 방향(from→to)만 사실대로 말하고, "반대로도
// 걸어보면 좋다"는 권유만 한다 — 방향 배정/카운터 로직 제거.
//
// 두 단계로 켜진다(파일럿 종료 후 정리 흐름):
//   1) config.ts::ROUNDTRIP_HINT_ENABLED — 개발자 스위치. 파일럿이 끝나면 이거
//      하나만 false 로 내려 설정 화면 섹션 + 이 배너를 통째로 숨긴다.
//   2) roundtripPref (설정 > 파일럿 테스트) — 테스터 개인이 켰는지, 기본 꺼짐.
// 배너의 "그만 보기"를 누르면 그 자리에서 roundtripPref 를 꺼서, 설정 화면까지
// 가지 않고도 바로 끌 수 있다(테스트 기간 편의).

import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { C } from "../constants/colors";
import { ROUNDTRIP_HINT_ENABLED } from "./config";
import { getRoundtripPref, setRoundtripPref } from "./roundtripPref";

function hintText(from?: string, to?: string) {
  const a = from || "출발지";
  const b = to || "도착지";
  return (
    `이번엔 ${a} → ${b} 로 안내합니다.\n` +
    `다음엔 반대로(${b} → ${a}) 걸어보시면, 오르막이 내리막으로 바뀌어 경사 데이터가 더 고르게 쌓여요.`
  );
}

export default function RoundtripHintBanner({ from, to }: { from?: string; to?: string }) {
  const [enabled, setEnabled] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!ROUNDTRIP_HINT_ENABLED) return;
    let alive = true;
    getRoundtripPref().then((on) => { if (alive) setEnabled(on); });
    return () => { alive = false; };
  }, []);

  if (!ROUNDTRIP_HINT_ENABLED || !enabled || dismissed) return null;

  return (
    <View style={ss.wrap} pointerEvents="box-none">
      <View style={ss.card}>
        <Text style={ss.text}>{hintText(from, to)}</Text>
        <View style={ss.row}>
          <TouchableOpacity
            onPress={() => { setEnabled(false); void setRoundtripPref(false); }}
            hitSlop={10}
          >
            <Text style={ss.stop}>그만 보기</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setDismissed(true)} hitSlop={10}>
            <Text style={ss.close}>확인</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const ss = StyleSheet.create({
  wrap: { position: "absolute", left: 12, right: 12, top: 96, alignItems: "center", zIndex: 50 },
  card: { backgroundColor: "rgba(27,15,74,0.94)", borderRadius: 14, padding: 14, width: "100%" },
  text: { color: C.white, fontSize: 12.5, lineHeight: 18 },
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  stop: { color: "rgba(255,255,255,0.6)", fontWeight: "600", fontSize: 12.5 },
  close: { color: C.primaryLight, fontWeight: "700", fontSize: 13 },
});
