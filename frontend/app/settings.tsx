import React, { useState, useEffect } from "react";
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Platform,
  Alert,
  Switch,
} from "react-native";
import { Ionicons, Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  saveUserType, getUserType, toApiUserType, clearLocalUserData,
  getShowSlopeMarkers, setShowSlopeMarkers,
} from "../src/utils/storage";
import { getAuthToken, updateUserTypeOnServer, deleteAccount } from "../src/api";
import { getAuth, signOut } from "@react-native-firebase/auth";
import { GoogleSignin } from "@react-native-google-signin/google-signin";

const NAVY = "#1B0F4A";
const LIGHT_GRAY = "#F1F2F6";
const BORDER_GRAY = "#E4E5EA";
const TEXT_GRAY = "#666666";

export default function SettingScreen() {
  const insets = useSafeAreaInsets();
  const [selectedType, setSelectedType] = useState("수동");
  const [slopeMarkersOn, setSlopeMarkersOn] = useState(true);

  useEffect(() => {
    getUserType().then(setSelectedType);
    getShowSlopeMarkers().then(setSlopeMarkersOn);
  }, []);

  const handleToggleSlopeMarkers = async (value: boolean) => {
    setSlopeMarkersOn(value);
    await setShowSlopeMarkers(value);
  };

  const handleSelectType = async (typeId: string) => {
    setSelectedType(typeId);
    await saveUserType(typeId);
    // 서버 동기화 (best-effort)
    getAuthToken().then(token => {
      if (token) updateUserTypeOnServer(toApiUserType(typeId), token);
    }).catch(() => {});
  };

  const handleLogout = () => {
    Alert.alert("로그아웃", "로그아웃 하시겠습니까?", [
      { text: "취소", style: "cancel" },
      {
        text: "로그아웃",
        style: "destructive",
        onPress: async () => {
          try {
            await GoogleSignin.signOut();
          } catch {
            // 구글 로그인 세션이 없었던 경우 무시
          }
          try {
            await signOut(getAuth());
          } catch (e) {
            Alert.alert("로그아웃 실패", "잠시 후 다시 시도해주세요.");
            return;
          }
          await clearLocalUserData();
          router.replace("/LoginScreen");
        },
      },
    ]);
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      "회원 탈퇴",
      "탈퇴하면 저장된 경로 기록, 북마크, 계정 정보가 모두 삭제되며 되돌릴 수 없습니다. 계속하시겠습니까?",
      [
        { text: "취소", style: "cancel" },
        {
          text: "탈퇴",
          style: "destructive",
          onPress: () => {
            // 되돌릴 수 없는 작업이라 한 번 더 확인
            Alert.alert("정말 탈퇴하시겠습니까?", "이 작업은 취소할 수 없습니다.", [
              { text: "취소", style: "cancel" },
              {
                text: "탈퇴하기",
                style: "destructive",
                onPress: async () => {
                  try {
                    const token = await getAuthToken();
                    if (!token) throw new Error("로그인 정보를 확인할 수 없습니다");
                    await deleteAccount(token);
                  } catch (e) {
                    Alert.alert("탈퇴 실패", "잠시 후 다시 시도해주세요.");
                    return;
                  }
                  try {
                    await GoogleSignin.signOut();
                  } catch {
                    // 구글 로그인 세션이 없었던 경우 무시
                  }
                  try {
                    await signOut(getAuth());
                  } catch {
                    // 서버에서 Firebase 계정이 이미 삭제됐으면 로컬 세션만 정리하면 됨
                  }
                  await clearLocalUserData();
                  router.replace("/LoginScreen");
                },
              },
            ]);
          },
        },
      ]
    );
  };

  const userTypes = [
    { id: "전동", label: "전동", icon: "wheelchair-accessibility" },
    { id: "수동", label: "수동", icon: "wheelchair" },
    { id: "보행기", label: "보행기", icon: "walk" },
    { id: "지팡이", label: "지팡이", icon: "hiking" },
    { id: "고령자", label: "고령자", icon: "human-male" },
    { id: "다리부상", label: "다리부상", icon: "bandage" },
  ];

  return (
    <SafeAreaView style={styles.container}>
      {/* 상단 헤더 */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={() => router.back()}
        >
          <Ionicons name="chevron-back" size={28} color={NAVY} />
        </TouchableOpacity>

        <Text style={styles.headerTitle}>설정</Text>

        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={() => router.replace("/")}
        >
          <Ionicons name="home-outline" size={26} color={NAVY} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* 사용자 유형 선택 + 현재 선택 상태를 하나의 진한 바운더리 카드로 묶는다 */}
        <View style={styles.typeSectionCard}>
          <Text style={styles.sectionTitle}>사용자 유형 선택</Text>
          <Text style={styles.sectionDescription}>
            이동 방식에 맞는 경로 안내를 위해 유형을 선택해 주세요.
          </Text>

          <View style={styles.grid}>
            {userTypes.map((type) => {
              const isSelected = selectedType === type.id;

              return (
                <TouchableOpacity
                  key={type.id}
                  style={[styles.typeBox, isSelected && styles.selectedTypeBox]}
                  activeOpacity={0.85}
                  onPress={() => handleSelectType(type.id)}
                >
                  <View
                    style={[
                      styles.typeIconBox,
                      isSelected && styles.selectedTypeIconBox,
                    ]}
                  >
                    <MaterialCommunityIcons
                      name={type.icon as any}
                      size={34}
                      color={isSelected ? "#FFFFFF" : NAVY}
                    />
                  </View>

                  <Text
                    style={[
                      styles.typeLabel,
                      isSelected && styles.selectedTypeText,
                    ]}
                  >
                    {type.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* 현재 선택 상태 — 유형 선택 영역 안쪽에 표시 */}
          <View style={styles.selectedInfoRow}>
            <View style={styles.selectedInfoIcon}>
              <Ionicons name="checkmark" size={22} color="#FFFFFF" />
            </View>

            <View style={{ flex: 1 }}>
              <Text style={styles.selectedInfoTitle}>현재 선택된 유형</Text>
              <Text style={styles.selectedInfoText}>{selectedType}</Text>
            </View>
          </View>
        </View>

        {/* 나머지 설정 — 연한 색 영역 하나로 묶는다 */}
        <View style={styles.settingsBodyCard}>
          <Text style={styles.subSectionTitle}>지도 표시</Text>
          <View style={styles.menuButton}>
            <View style={styles.menuLeft}>
              <Ionicons name="trending-up-outline" size={23} color={NAVY} />
              <Text style={styles.menuText}>경사도 퍼센트 마커 표시</Text>
            </View>
            <Switch
              value={slopeMarkersOn}
              onValueChange={handleToggleSlopeMarkers}
              trackColor={{ false: BORDER_GRAY, true: NAVY }}
              thumbColor="#FFFFFF"
            />
          </View>

          <Text style={[styles.subSectionTitle, { marginTop: 20 }]}>메뉴</Text>
          <TouchableOpacity
            style={styles.menuButton}
            activeOpacity={0.85}
            onPress={() => router.push("/mypage")}
          >
            <View style={styles.menuLeft}>
              <Ionicons name="bar-chart-outline" size={23} color={NAVY} />
              <Text style={styles.menuText}>마이페이지 (기록 / 통계)</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={25} color="#B8B8B8" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuButton}
            activeOpacity={0.85}
            onPress={() => Alert.alert("개인정보처리방침", "서비스 준비 중입니다.")}
          >
            <View style={styles.menuLeft}>
              <Ionicons name="shield-checkmark-outline" size={23} color={NAVY} />
              <Text style={styles.menuText}>개인정보처리방침</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={25} color="#B8B8B8" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuButton}
            activeOpacity={0.85}
            onPress={() => Alert.alert("오픈소스 라이선스", "서비스 준비 중입니다.")}
          >
            <View style={styles.menuLeft}>
              <Ionicons name="document-text-outline" size={23} color={NAVY} />
              <Text style={styles.menuText}>오픈소스 라이선스</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={25} color="#B8B8B8" />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.menuButton}
            activeOpacity={0.85}
            onPress={handleLogout}
          >
            <View style={styles.menuLeft}>
              <Ionicons name="log-out-outline" size={23} color="#E14B4B" />
              <Text style={[styles.menuText, { color: "#E14B4B" }]}>로그아웃</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.menuButton, { marginBottom: 0 }]}
            activeOpacity={0.85}
            onPress={handleDeleteAccount}
          >
            <View style={styles.menuLeft}>
              <Ionicons name="person-remove-outline" size={23} color="#999999" />
              <Text style={[styles.menuText, { color: "#999999" }]}>회원 탈퇴</Text>
            </View>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* 하단 네비게이션 */}
      <View style={[styles.bottomNav, { bottom: 14 + insets.bottom }]}>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => router.replace("/")}
        >
          <Ionicons name="home-outline" size={30} color={NAVY} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={() => router.push("/bookmark")}
        >
          <Feather name="bookmark" size={29} color={NAVY} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={() => router.replace("/")}
        >
          <MaterialCommunityIcons name="crosshairs-gps" size={32} color={NAVY} />
        </TouchableOpacity>

        <TouchableOpacity style={[styles.navButton, styles.activeNavButton]}>
          <Ionicons name="settings" size={31} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const shadowStyle = Platform.select({
  ios: {
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  android: {
    elevation: 4,
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 20,
  },

  header: {
    height: 62,
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
  },

  headerIconButton: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: LIGHT_GRAY,
    justifyContent: "center",
    alignItems: "center",
  },

  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 21,
    fontWeight: "800",
    color: "#111111",
  },

  scrollContent: {
    paddingTop: 18,
    paddingBottom: 120,
  },

  sectionTitle: {
    fontSize: 23,
    fontWeight: "800",
    color: "#111111",
  },

  sectionDescription: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 20,
    color: TEXT_GRAY,
  },

  // 유형 선택 + 현재 선택 상태를 하나로 묶는 카드 — 짙은 바운더리로 강조.
  typeSectionCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 26,
    padding: 18,
    borderWidth: 2,
    borderColor: NAVY,
    ...shadowStyle,
  },

  grid: {
    marginTop: 18,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },

  typeBox: {
    width: "31%",
    aspectRatio: 0.82,
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
  },

  selectedTypeBox: {
    backgroundColor: NAVY,
    borderColor: NAVY,
  },

  typeIconBox: {
    width: 48,
    height: 48,
    borderRadius: 17,
    backgroundColor: LIGHT_GRAY,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },

  selectedTypeIconBox: {
    backgroundColor: "rgba(255,255,255,0.18)",
  },

  typeLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: "#333333",
  },

  selectedTypeText: {
    color: "#FFFFFF",
  },

  // typeSectionCard 안쪽에 자리하는 행 — 카드 자체 배경/테두리는 이미 부모가
  // 갖고 있으니, 위쪽 구분선만 넣어 유형 그리드와 시각적으로 나눈다.
  selectedInfoRow: {
    marginTop: 18,
    paddingTop: 18,
    borderTopWidth: 1,
    borderTopColor: BORDER_GRAY,
    flexDirection: "row",
    alignItems: "center",
  },

  selectedInfoIcon: {
    width: 42,
    height: 42,
    borderRadius: 15,
    backgroundColor: NAVY,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },

  selectedInfoTitle: {
    fontSize: 13,
    color: TEXT_GRAY,
    fontWeight: "600",
  },

  selectedInfoText: {
    marginTop: 4,
    fontSize: 18,
    color: "#111111",
    fontWeight: "800",
  },

  // 유형 선택 카드 아래, 나머지 설정 전체를 감싸는 연한 색 영역.
  settingsBodyCard: {
    marginTop: 18,
    backgroundColor: LIGHT_GRAY,
    borderRadius: 26,
    padding: 16,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
  },

  subSectionTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#111111",
    marginBottom: 10,
  },

  menuButton: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    paddingVertical: 18,
    paddingHorizontal: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    ...shadowStyle,
  },

  menuLeft: {
    flexDirection: "row",
    alignItems: "center",
  },

  menuText: {
    marginLeft: 10,
    fontSize: 16,
    color: "#333333",
    fontWeight: "700",
  },

  bottomNav: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 14,
    height: 82,
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    ...shadowStyle,
  },

  navButton: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: "#F6F6F8",
    justifyContent: "center",
    alignItems: "center",
  },

  activeNavButton: {
    backgroundColor: NAVY,
  },
});