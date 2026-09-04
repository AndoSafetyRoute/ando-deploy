// 개인화 설정 — 메인 설정 화면(app/settings.tsx)에서 "개인화 설정" 한 줄로 들어오는
// 전용 화면. 예전엔 데이터 수집 토글 두 줄이 지도표시/메뉴 사이에 끼어 있었는데,
// (1) 뭘 위한 수집인지 설명이 없고 (2) 진행 상황을 보려면 마이페이지로 또 가야 했다.
// 여기 한 화면에 설명 → 토글 → 진행 상황을 순서대로 모아 바로 확인할 수 있게 한다.
// 시각 스타일은 app/settings.tsx 를 그대로 따른다(NAVY/카드 패턴 재사용 — 화면마다
// 스타일이 다르면 그 자체로 사용성이 떨어진다).
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, Alert, Switch } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { goHome } from "../src/utils/navigation";
import { getAuthToken, getPersonalizationStatus, type PersonalizationStatus } from "../src/api";
import {
  getCollectConsent, setCollectConsent, CONSENT_TITLE, CONSENT_BODY,
} from "../src/personalization/collectConsent";
import { getRoundtripPref, setRoundtripPref } from "../src/personalization/roundtripPref";
import { ROUNDTRIP_HINT_ENABLED } from "../src/personalization/config";

const NAVY = "#1B0F4A";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT_GRAY = "#666666";

export default function PersonalizationSettingsScreen() {
  const insets = useSafeAreaInsets();
  const [collectOn, setCollectOn] = useState(false);
  const [roundtripOn, setRoundtripOn] = useState(false);
  const [status, setStatus] = useState<PersonalizationStatus | null>(null);

  useEffect(() => {
    getCollectConsent().then((s) => setCollectOn(s === "granted"));
    getRoundtripPref().then(setRoundtripOn);
    getAuthToken().then((token) => {
      if (!token) return;
      getPersonalizationStatus(token).then(setStatus).catch(() => {});
    }).catch(() => {});
  }, []);

  const handleToggleCollect = async (value: boolean) => {
    setCollectOn(value);
    await setCollectConsent(value);
  };

  const handleToggleRoundtrip = async (value: boolean) => {
    setRoundtripOn(value);
    await setRoundtripPref(value);
  };

  const showProgress = collectOn && status && status.total_samples > 0;
  const progressPct = showProgress
    ? Math.min(100, Math.round((100 * status!.flat_progress_m) / Math.max(1, status!.flat_target_m)))
    : 0;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerIconButton} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={NAVY} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>개인화 설정</Text>
        <TouchableOpacity style={styles.headerIconButton} onPress={goHome}>
          <Ionicons name="home-outline" size={26} color={NAVY} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* 설명 카드 — 토글을 보기 전에 "왜"부터 */}
        <View style={styles.introCard}>
          <View style={styles.introIcon}>
            <Ionicons name="walk" size={26} color="#FFFFFF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.introTitle}>나에게 맞는 경로, 나에게 맞는 시간</Text>
            <Text style={styles.introDesc}>
              걷는 동안 구간별 경사·속도를 모아, 소요시간 예측과 경로 추천을 내 걸음에 맞춥니다.
            </Text>
          </View>
        </View>

        {/* 데이터 수집 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>데이터 수집</Text>

          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="analytics-outline" size={22} color={NAVY} />
              <Text style={styles.rowText}>맞춤 경로 데이터 수집</Text>
            </View>
            <Switch
              value={collectOn}
              onValueChange={handleToggleCollect}
              trackColor={{ false: BORDER_GRAY, true: NAVY }}
              thumbColor="#FFFFFF"
            />
          </View>

          <TouchableOpacity
            style={[styles.row, styles.rowButton]}
            activeOpacity={0.85}
            onPress={() => Alert.alert(CONSENT_TITLE, CONSENT_BODY)}
          >
            <View style={styles.rowLeft}>
              <Ionicons name="information-circle-outline" size={22} color={NAVY} />
              <Text style={styles.rowText}>수집 항목 안내</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color="#B8B8B8" />
          </TouchableOpacity>

          {!collectOn && (
            <Text style={styles.helperText}>
              꺼두면 개인화 데이터는 전혀 모이지 않고, 길안내 기능은 그대로 사용할 수 있습니다.
            </Text>
          )}

          {showProgress && (
            <View style={styles.progressBox}>
              <View style={styles.progressHeaderRow}>
                <Text style={styles.progressLabel}>
                  {status!.calibrated ? "맞춤 적용 중" : "학습 중"}
                </Text>
                {status!.calibrated && (
                  <View style={styles.badgeOn}><Text style={styles.badgeOnText}>적용됨</Text></View>
                )}
              </View>
              <Text style={styles.progressDesc}>
                {status!.calibrated
                  ? "평지 속도 학습이 끝나 소요시간이 내 걸음에 맞춰집니다."
                  : `평지를 ${Math.round(status!.flat_progress_m)} / ${Math.round(status!.flat_target_m)}m 걸으면 소요시간이 내 걸음에 맞춰집니다.`}
              </Text>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
              </View>
              <Text style={styles.progressMeta}>
                수집 세션 {status!.session_count}회 · 구간 관측 {status!.total_samples}건
              </Text>
            </View>
          )}
        </View>

        {/* 파일럿 테스트 — 기간 한정. ROUNDTRIP_HINT_ENABLED 가 꺼지면 섹션째 사라진다. */}
        {ROUNDTRIP_HINT_ENABLED && (
          <View style={[styles.card, styles.pilotCard]}>
            <View style={styles.pilotHeaderRow}>
              <Text style={styles.cardTitle}>파일럿 테스트</Text>
              <View style={styles.pilotBadge}><Text style={styles.pilotBadgeText}>기간 한정</Text></View>
            </View>
            <Text style={styles.helperText}>
              데이터 수집 기간에만 보이는 테스트 기능입니다. 기간이 끝나면 이 섹션은 사라집니다.
            </Text>

            <View style={[styles.row, { marginTop: 12 }]}>
              <View style={styles.rowLeft}>
                <Ionicons name="repeat-outline" size={22} color={NAVY} />
                <Text style={styles.rowText}>왕복 걷기 안내</Text>
              </View>
              <Switch
                value={roundtripOn}
                onValueChange={handleToggleRoundtrip}
                trackColor={{ false: BORDER_GRAY, true: NAVY }}
                thumbColor="#FFFFFF"
              />
            </View>
            {roundtripOn && (
              <Text style={styles.helperText}>
                도보 안내를 시작하면, 반대 방향으로도 걸어보길 권하는 안내가 한 번 뜹니다.
              </Text>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const shadowStyle = Platform.select({
  ios: { shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  android: { elevation: 4 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF", paddingHorizontal: 20 },

  header: { height: 62, marginTop: 18, flexDirection: "row", alignItems: "center" },
  headerIconButton: {
    width: 44, height: 44, borderRadius: 15, backgroundColor: LIGHT_GRAY,
    justifyContent: "center", alignItems: "center",
  },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 21, fontWeight: "800", color: "#111111" },

  scrollContent: { paddingTop: 18, paddingBottom: 40 },

  introCard: {
    flexDirection: "row", gap: 14, alignItems: "flex-start",
    backgroundColor: NAVY, borderRadius: 24, padding: 18,
  },
  introIcon: {
    width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.16)",
    justifyContent: "center", alignItems: "center",
  },
  introTitle: { fontSize: 16, fontWeight: "800", color: "#FFFFFF" },
  introDesc: { marginTop: 6, fontSize: 13, lineHeight: 19, color: "rgba(255,255,255,0.78)" },

  card: {
    marginTop: 16, backgroundColor: LIGHT_GRAY, borderRadius: 24, padding: 16,
    borderWidth: 1, borderColor: BORDER_GRAY,
  },
  cardTitle: { fontSize: 16, fontWeight: "800", color: "#111111", marginBottom: 12 },

  row: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    backgroundColor: "#FFFFFF", borderRadius: 18, paddingVertical: 16, paddingHorizontal: 16,
    marginBottom: 10, borderWidth: 1, borderColor: BORDER_GRAY, ...shadowStyle,
  },
  rowButton: {},
  rowLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowText: { fontSize: 15, fontWeight: "700", color: "#333333" },

  helperText: { fontSize: 12.5, color: TEXT_GRAY, lineHeight: 18, paddingHorizontal: 4 },

  progressBox: {
    marginTop: 10, backgroundColor: "#FFFFFF", borderRadius: 18, padding: 16,
    borderWidth: 1, borderColor: BORDER_GRAY,
  },
  progressHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  progressLabel: { fontSize: 14, fontWeight: "800", color: "#111111" },
  // 앱 전역 success 톤(C.success #3DBFA8)과 같은 계열의 배경 짝(lowFloorBg 와 동일 관계) —
  // 이 화면만의 새 초록을 만들지 않는다.
  badgeOn: { backgroundColor: "#E0F7F4", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  badgeOnText: { fontSize: 11, fontWeight: "800", color: "#3DBFA8" },
  progressDesc: { marginTop: 6, fontSize: 12.5, color: TEXT_GRAY, lineHeight: 18 },
  progressTrack: { marginTop: 10, height: 8, borderRadius: 4, backgroundColor: BORDER_GRAY, overflow: "hidden" },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: NAVY },
  progressMeta: { marginTop: 10, fontSize: 12, color: TEXT_GRAY },

  // 새 색 계열을 들이지 않고 화면 전체 강조색(NAVY)을 옅게 우려서 "기간 한정" 임을 표시.
  pilotCard: { borderColor: "rgba(27,15,74,0.16)", backgroundColor: "rgba(27,15,74,0.04)" },
  pilotHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pilotBadge: { backgroundColor: NAVY, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  pilotBadgeText: { fontSize: 11, fontWeight: "800", color: "#FFFFFF" },
});
