import React, { useState } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { getAuth, sendPasswordResetEmail } from '@react-native-firebase/auth';
import { checkEmailRegistered } from '../src/api/accountLookup';

// LoginScreen / SignupScreen 과 짝을 맞춘 배색
const NAVY        = '#1B0F4A';
const LIGHT_GRAY  = '#F1F2F6';
const BORDER_GRAY = '#E4E5EA';
const TEXT_GRAY   = '#666666';

type Mode = 'id' | 'password';

// 대충 형태만 확인 — 실제 존재 여부는 Firebase 가 판정한다.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Firebase 오류코드 → 사용자 문구. 두 기능이 공유한다.
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

export default function FindAccountScreen() {
  const [mode, setMode]       = useState<Mode>('id');
  const [email, setEmail]     = useState('');
  const [loading, setLoading] = useState(false);
  // 아이디 확인 결과 — null 이면 아직 조회 안 함
  const [idResult, setIdResult] = useState<
    | null
    | { exists: false }
    | { exists: true; google: boolean; password: boolean }
  >(null);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setIdResult(null);
  };

  // ── 아이디(가입 여부) 확인 ────────────────────────────────
  // 이 프로젝트는 Firebase 이메일 열거 방지가 켜져 있어 클라이언트
  // fetchSignInMethodsForEmail() 이 항상 빈 배열을 준다. 그래서 서버(방식 B)
  // GET /auth/check-email(Admin SDK) 로 조회한다 — ando-BE/account_lookup.py.
  // 서버 엔드포인트가 아직 배선되지 않았으면 안내 문구만 띄운다.
  const handleCheckId = async () => {
    const target = email.trim().toLowerCase();
    if (!EMAIL_RE.test(target)) {
      Alert.alert('입력 오류', '이메일 주소를 정확히 입력해주세요.');
      return;
    }
    setLoading(true);
    setIdResult(null);
    try {
      const r = await checkEmailRegistered(target);
      if (!r.exists) {
        setIdResult({ exists: false });
      } else {
        setIdResult({
          exists: true,
          google:   r.providers.includes('google.com'),
          password: r.providers.includes('password'),
        });
      }
    } catch (e: any) {
      if (e?.message === 'NOT_DEPLOYED') {
        Alert.alert(
          '준비 중',
          '아이디 확인 기능은 아직 서버에 배포되지 않았습니다.\n비밀번호 재설정은 정상 이용 가능합니다.',
        );
      } else {
        Alert.alert('조회 실패', e?.message ?? '알 수 없는 오류');
      }
    } finally {
      setLoading(false);
    }
  };

  // ── 비밀번호 재설정 메일 ──────────────────────────────────
  // Firebase 가 재설정 링크(oobCode 포함)를 이메일로 보낸다. 링크에서
  // 새 비밀번호를 입력하면 즉시 반영된다 — 앱에서 따로 처리할 것 없음.
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
          '가입되지 않았거나, 비밀번호 없이 Google 로그인으로만 가입된 이메일입니다.',
        );
      } else {
        Alert.alert('전송 실패', messageForCode(code, e?.message ?? '알 수 없는 오류'));
      }
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = mode === 'id' ? handleCheckId : handleResetPassword;

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
          <Text style={styles.headerTitle}>계정 찾기</Text>
          <View style={styles.backBtn} />
        </View>

        <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
          {/* 모드 전환 */}
          <View style={styles.segment}>
            <TouchableOpacity
              style={[styles.segBtn, mode === 'id' && styles.segBtnActive]}
              onPress={() => switchMode('id')}
              activeOpacity={0.85}
            >
              <Text style={[styles.segText, mode === 'id' && styles.segTextActive]}>
                아이디 확인
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segBtn, mode === 'password' && styles.segBtnActive]}
              onPress={() => switchMode('password')}
              activeOpacity={0.85}
            >
              <Text style={[styles.segText, mode === 'password' && styles.segTextActive]}>
                비밀번호 재설정
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.desc}>
            {mode === 'id'
              ? '가입할 때 사용한 이메일을 입력하면 가입 여부와 로그인 방식을 알려드립니다.'
              : '가입한 이메일로 비밀번호 재설정 링크를 보내드립니다.'}
          </Text>

          <TextInput
            style={styles.input}
            placeholder="이메일"
            placeholderTextColor="#999999"
            value={email}
            onChangeText={(t) => { setEmail(t); setIdResult(null); }}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={onSubmit}
            returnKeyType={mode === 'id' ? 'search' : 'send'}
          />

          <TouchableOpacity
            style={[styles.btn, loading && { opacity: 0.7 }]}
            onPress={onSubmit}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={styles.btnText}>
                  {mode === 'id' ? '가입 여부 확인' : '재설정 메일 보내기'}
                </Text>}
          </TouchableOpacity>

          {/* 아이디 확인 결과 */}
          {mode === 'id' && idResult && (
            <View style={styles.resultBox}>
              {!idResult.exists ? (
                <Text style={styles.resultText}>
                  이 이메일로 가입된 계정이 없습니다. 회원가입을 진행해주세요.
                </Text>
              ) : (
                <>
                  <Text style={[styles.resultText, { fontWeight: '800', color: NAVY }]}>
                    가입된 계정입니다.
                  </Text>
                  <Text style={styles.resultText}>
                    로그인 방식:{' '}
                    {[
                      idResult.password && '이메일 · 비밀번호',
                      idResult.google && 'Google 로그인',
                    ].filter(Boolean).join(' / ') || '알 수 없음'}
                  </Text>
                  {idResult.google && !idResult.password && (
                    <Text style={[styles.resultText, { marginTop: 4 }]}>
                      비밀번호 없이 Google 로그인으로만 가입된 계정이라, 비밀번호 재설정 대신
                      Google로 로그인해주세요.
                    </Text>
                  )}
                  {idResult.password && (
                    <TouchableOpacity
                      style={styles.inlineLink}
                      onPress={() => switchMode('password')}
                    >
                      <Text style={styles.inlineLinkText}>비밀번호 재설정하기 →</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          )}

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
  segment: {
    flexDirection: 'row',
    backgroundColor: LIGHT_GRAY,
    borderRadius: 14,
    padding: 4,
    marginBottom: 20,
  },
  segBtn: {
    flex: 1,
    height: 42,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  segBtnActive: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: BORDER_GRAY,
  },
  segText: {
    fontSize: 14,
    fontWeight: '700',
    color: TEXT_GRAY,
  },
  segTextActive: {
    color: NAVY,
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
  resultBox: {
    marginTop: 20,
    padding: 16,
    borderRadius: 14,
    backgroundColor: LIGHT_GRAY,
    borderWidth: 1,
    borderColor: BORDER_GRAY,
  },
  resultText: {
    fontSize: 14,
    color: '#333333',
    lineHeight: 20,
  },
  inlineLink: {
    marginTop: 12,
  },
  inlineLinkText: {
    fontSize: 14,
    fontWeight: '800',
    color: NAVY,
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
