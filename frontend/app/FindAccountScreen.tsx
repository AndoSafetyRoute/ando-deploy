import React, { useState } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { getAuth, sendPasswordResetEmail } from '@react-native-firebase/auth';

// LoginScreen / SignupScreen 과 짝을 맞춘 배색
const NAVY        = '#1B0F4A';
const LIGHT_GRAY  = '#F1F2F6';
const BORDER_GRAY = '#E4E5EA';
const TEXT_GRAY   = '#666666';

// 대충 형태만 확인 — 실제 존재 여부는 Firebase 가 판정한다.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function messageForCode(code: string, fallback: string): string {
  switch (code) {
    case 'auth/invalid-email':
      return '이메일 형식이 올바르지 않습니다.';
    case 'auth/user-not-found':
      return '가입되지 않은 이메일입니다.';
    case 'auth/too-many-requests':
      return '요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해주세요.';
    case 'auth/network-request-failed':
      return '네트워크 연결을 확인해주세요.';
    default:
      return fallback;
  }
}

// 비밀번호 재설정 전용 화면.
//  - 이메일·비밀번호로 가입한 계정: Firebase 가 재설정 링크(oobCode)를 메일로 보낸다.
//  - Google 로그인으로만 가입한 계정: 비밀번호 자체가 없어 재설정 대상이 아니며,
//    이 경우 Google 로그인을 쓰라고 안내한다.
export default function FindAccountScreen() {
  const [email, setEmail]     = useState('');
  const [loading, setLoading] = useState(false);

  const handleResetPassword = async () => {
    const target = email.trim().toLowerCase();
    if (!EMAIL_RE.test(target)) {
      Alert.alert('입력 오류', '이메일 주소를 정확히 입력해주세요.');
      return;
    }
    setLoading(true);
    try {
      await sendPasswordResetEmail(getAuth(), target);
      Alert.alert(
        '메일을 보냈습니다',
        `${target} 으로 비밀번호 재설정 링크를 보냈습니다.\n메일함(스팸함 포함)을 확인해 새 비밀번호를 설정해주세요.`,
        [{ text: '로그인으로', onPress: () => router.replace('/LoginScreen') }],
      );
    } catch (e: any) {
      const code = e?.code ?? '';
      // Google 로그인 전용 계정은 비밀번호가 없어 재설정 대상이 아니다.
      if (code === 'auth/user-not-found') {
        Alert.alert(
          '재설정할 수 없음',
          '가입되지 않았거나, 비밀번호 없이 Google 로그인으로만 가입된 이메일입니다.\n'
          + 'Google 로그인으로 가입하셨다면 로그인 화면에서 "Google로 계속하기"를 이용해주세요.',
        );
      } else {
        Alert.alert('전송 실패', messageForCode(code, e?.message ?? '알 수 없는 오류'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* 헤더 (전역 headerShown:false 라 직접 그린다) */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={26} color={NAVY} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>비밀번호 재설정</Text>
          <View style={styles.backBtn} />
        </View>

        <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
          <Text style={styles.desc}>
            가입한 이메일로 비밀번호 재설정 링크를 보내드립니다. 링크에서 새 비밀번호를
            입력하면 즉시 반영됩니다.
          </Text>

          <TextInput
            style={styles.input}
            placeholder="이메일"
            placeholderTextColor="#999999"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={handleResetPassword}
            returnKeyType="send"
          />

          <TouchableOpacity
            style={[styles.btn, loading && { opacity: 0.7 }]}
            onPress={handleResetPassword}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={styles.btnText}>재설정 메일 보내기</Text>}
          </TouchableOpacity>

          <Text style={styles.hint}>
            Google 로그인으로만 가입한 계정은 비밀번호가 없어 재설정이 필요 없습니다 —
            로그인 화면에서 "Google로 계속하기"를 이용해주세요.
          </Text>

          <TouchableOpacity style={styles.backLink} onPress={() => router.replace('/LoginScreen')}>
            <Text style={styles.backText}>
              <Text style={{ fontWeight: 'bold', textDecorationLine: 'underline' }}>로그인</Text>
              {' '}으로 돌아가기
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    height: 52,
  },
  backBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: NAVY,
  },
  inner: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 40,
  },
  desc: {
    fontSize: 14,
    color: TEXT_GRAY,
    lineHeight: 20,
    marginBottom: 16,
  },
  input: {
    height: 54,
    backgroundColor: LIGHT_GRAY,
    borderRadius: 14,
    paddingHorizontal: 18,
    fontSize: 16,
    color: '#111111',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
  },
  btn: {
    height: 54,
    backgroundColor: NAVY,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  btnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  hint: {
    marginTop: 18,
    fontSize: 13,
    color: TEXT_GRAY,
    lineHeight: 19,
  },
  backLink: {
    marginTop: 28,
    alignItems: 'center',
  },
  backText: {
    color: TEXT_GRAY,
    fontSize: 15,
  },
});
