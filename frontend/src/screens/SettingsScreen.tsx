import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform,
} from 'react-native';
import { C } from '../constants/colors';

interface SettingItem {
  icon:    string;
  label:   string;
  desc?:   string;
  onPress: () => void;
  accent?: boolean;
}

interface SettingSection {
  title: string;
  items: SettingItem[];
}

interface Props { navigation: any }

export default function SettingsScreen({ navigation }: Props) {
  const sections: SettingSection[] = [
    {
      title: '내 정보',
      items: [
        {
          icon: '👤',
          label: '마이페이지',
          desc: '지난 경로 · 만족도 별점 관리',
          onPress: () => navigation.navigate('MyPage'),
          accent: true,
        },
      ],
    },
    {
      title: '앱 설정',
      items: [
        {
          icon: '♿',
          label: '이동 유형 설정',
          desc: '기본 이동 방식을 변경합니다',
          onPress: () => {},
        },
        {
          icon: '🔔',
          label: '알림 설정',
          desc: '경로 안내 알림을 관리합니다',
          onPress: () => {},
        },
        {
          icon: '🗺',
          label: '지도 설정',
          desc: '지도 스타일 및 레이어를 설정합니다',
          onPress: () => {},
        },
      ],
    },
    {
      title: '정보',
      items: [
        {
          icon: 'ℹ️',
          label: '앱 정보',
          desc: '버전 · 개인정보처리방침 · 이용약관',
          onPress: () => {},
        },
      ],
    },
  ];

  return (
    <View style={ss.screen}>
      <View style={ss.header}>
        <TouchableOpacity style={ss.backBtn} onPress={() => navigation.goBack()}>
          <Text style={ss.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={ss.headerTitle}>설정</Text>
      </View>

      <ScrollView
        style={ss.scroll}
        contentContainerStyle={ss.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {sections.map(section => (
          <View key={section.title} style={ss.section}>
            <Text style={ss.sectionTitle}>{section.title}</Text>
            <View style={ss.card}>
              {section.items.map((item, idx) => (
                <React.Fragment key={item.label}>
                  <TouchableOpacity
                    style={ss.row}
                    onPress={item.onPress}
                    activeOpacity={0.7}
                  >
                    <View style={[ss.iconWrap, item.accent && ss.iconWrapAccent]}>
                      <Text style={ss.rowIcon}>{item.icon}</Text>
                    </View>
                    <View style={ss.rowText}>
                      <Text style={[ss.rowLabel, item.accent && ss.rowLabelAccent]}>
                        {item.label}
                      </Text>
                      {item.desc && (
                        <Text style={ss.rowDesc}>{item.desc}</Text>
                      )}
                    </View>
                    <Text style={ss.rowArrow}>›</Text>
                  </TouchableOpacity>
                  {idx < section.items.length - 1 && <View style={ss.divider} />}
                </React.Fragment>
              ))}
            </View>
          </View>
        ))}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const ss = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.white,
    paddingTop: Platform.OS === 'ios' ? 52 : 16,
    paddingBottom: 14, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: C.border,
    elevation: 2, gap: 12,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: C.primaryBg, alignItems: 'center', justifyContent: 'center',
  },
  backIcon: { fontSize: 18, color: C.primary },
  headerTitle: { fontSize: 17, fontWeight: '700', color: C.text },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 8 },

  section: { marginBottom: 8 },
  sectionTitle: {
    fontSize: 12, fontWeight: '700', color: C.textMute,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 8, marginLeft: 4,
  },
  card: {
    backgroundColor: C.white, borderRadius: 16,
    borderWidth: 1, borderColor: C.border,
    overflow: 'hidden',
    elevation: 1, shadowColor: C.shadow,
    shadowOffset: { width: 0, height: 1 }, shadowOpacity: 1, shadowRadius: 4,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14, gap: 14,
  },
  iconWrap: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center',
  },
  iconWrapAccent: { backgroundColor: C.primaryBg },
  rowIcon: { fontSize: 20 },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, fontWeight: '600', color: C.text },
  rowLabelAccent: { color: C.primary },
  rowDesc: { fontSize: 12, color: C.textSub, marginTop: 2 },
  rowArrow: { fontSize: 20, color: C.textMute, marginLeft: 4 },
  divider: { height: 1, backgroundColor: C.border, marginHorizontal: 16 },
});