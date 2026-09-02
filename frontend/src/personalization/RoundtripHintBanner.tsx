// ⑮ 왕복·방향 교대 안내 배너 — 안내 시작 화면 위에 얹는다.
// PENDING_WIRE(nav-roundtrip): NavigationScreen 최상단 오버레이에
//   `<RoundtripHintBanner from={from} to={finalDestinationName} />` 한 줄.
// ROUNDTRIP_HINT_ENABLED 가 false 면 아무것도 렌더하지 않는다.

import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { C } from "../constants/colors";
import { ROUNDTRIP_HINT_ENABLED } from "./config";
import { nextRoundtripDirection } from "./entry";
import { roundtripHintText, type WalkDirection } from "../utils/roundtripHint";

export default function RoundtripHintBanner({ from, to }: { from?: string; to?: string }) {
  const [dir, setDir] = useState<WalkDirection | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!ROUNDTRIP_HINT_ENABLED) return;
    let alive = true;
    nextRoundtripDirection().then((d) => { if (alive) setDir(d); });
    return () => { alive = false; };
  }, []);

  if (!ROUNDTRIP_HINT_ENABLED || dismissed || !dir) return null;

  return (
    <View style={ss.wrap} pointerEvents="box-none">
      <View style={ss.card}>
        <Text style={ss.text}>{roundtripHintText(dir, from, to)}</Text>
        <TouchableOpacity onPress={() => setDismissed(true)} hitSlop={10}>
          <Text style={ss.close}>확인</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const ss = StyleSheet.create({
  wrap: { position: "absolute", left: 12, right: 12, top: 96, alignItems: "center", zIndex: 50 },
  card: { backgroundColor: "rgba(27,15,74,0.94)", borderRadius: 14, padding: 14, width: "100%" },
  text: { color: C.white, fontSize: 12.5, lineHeight: 18 },
  close: { color: C.primaryLight, fontWeight: "700", fontSize: 13, alignSelf: "flex-end", marginTop: 8 },
});
