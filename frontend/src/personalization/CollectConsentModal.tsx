// 개인화 데이터 수집 동의 모달 (이슈 #1)
//
// 안내 화면에서 아직 동의/거부를 결정하지 않은 사용자(mode="walk")에게 1회 띄운다.
// 결정 후에는 다시 뜨지 않는다(설정에서만 변경). 결과는 onDecide 로 전달.

import React from "react";
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { C } from "../constants/colors";
import { CONSENT_TITLE, CONSENT_BODY } from "./collectConsent";

export default function CollectConsentModal({
  visible,
  onDecide,
}: {
  visible: boolean;
  onDecide: (granted: boolean) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => onDecide(false)}>
      <View style={ss.backdrop}>
        <View style={ss.card}>
          <Text style={ss.title}>{CONSENT_TITLE}</Text>
          <ScrollView style={ss.bodyBox} contentContainerStyle={{ paddingBottom: 4 }}>
            <Text style={ss.body}>{CONSENT_BODY}</Text>
          </ScrollView>
          <TouchableOpacity style={ss.primary} activeOpacity={0.85} onPress={() => onDecide(true)}>
            <Text style={ss.primaryText}>동의하고 계속</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={ss.ghost}
            activeOpacity={0.7}
            onPress={() => onDecide(false)}
            hitSlop={{ top: 10, bottom: 10, left: 15, right: 15 }}
          >
            <Text style={ss.ghostText}>동의 안 함 (안내는 그대로 사용)</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const ss = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 22 },
  card: { backgroundColor: C.white, borderRadius: 18, padding: 20, maxHeight: "82%" },
  title: { fontSize: 17, fontWeight: "800", color: C.text, marginBottom: 12 },
  bodyBox: { flexGrow: 0, marginBottom: 16 },
  body: { fontSize: 13, lineHeight: 20, color: C.textSub },
  // paddingVertical 16 + 텍스트 ≈ 52dp — 접근성 최소 터치 타겟 확보.
  primary: { backgroundColor: C.primary, borderRadius: 12, paddingVertical: 16, alignItems: "center" },
  primaryText: { color: C.white, fontSize: 15, fontWeight: "700" },
  ghost: { paddingVertical: 12, alignItems: "center", marginTop: 4 },
  ghostText: { color: C.textMute, fontSize: 13, fontWeight: "600" },
});
