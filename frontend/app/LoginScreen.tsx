import React, { useState } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity,
  Image, ActivityIndicator, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { getAuth, signInWithCredential, signInWithEmailAndPassword, GoogleAuthProvider } from '@react-native-firebase/auth';
import { loginToBackend } from '../src/api';
import { saveUserType, USER_TYPE_MAP } from '../src/utils/storage';

// 서버 API 유형 → 한국어 역매핑
const API_TO_KOREAN: Record<string, string> = Object.fromEntries(
  Object.entries(USER_TYPE_MAP).map(([k, v]) => [v, k])
);

const WEB_CLIENT_ID = '139320931299-jc0pbgegf8eqeg11096bc4i6ad0ak7rj.apps.googleusercontent.com';
GoogleSignin.configure({ webClientId: WEB_CLIENT_ID });

// 나머지 화면(홈/설정/즐겨찾기/검색)과 같은 배색 — 예전엔 이 화면만 보라색
// 전체배경 스플래시 스타일이라 톤이 확 달라 보였다.
const NAVY       = '#1B0F4A';
const LIGHT_GRAY = '#F1F2F6';
const BORDER_GRAY = '#E4E5EA';
const TEXT_GRAY  = '#666666';

export default function LoginScreen() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading]   = useState(false);

  // ── 구글 로그인 ──────────────────────────────────────────
  const handleGoogleLogin = async () => {
    setLoading(true);
    try {
      await GoogleSignin.hasPlayServices();
      const signInResult   = await GoogleSignin.signIn();
      const idToken        = signInResult.data?.idToken;
      if (!idToken) throw new Error('Google 토큰을 받지 못했습니다');
      const credential     = GoogleAuthProvider.credential(idToken);
      const userCredential = await signInWithCredential(getAuth(), credential);
      const firebaseToken  = await userCredential.user.getIdToken();
      const userInfo       = await loginToBackend(firebaseToken);
      const korean = API_TO_KOREAN[userInfo.user_type];
      if (korean) await saveUserType(korean);
      router.replace('/');
    } catch (e: any) {
      Alert.alert('Google 로그인 실패', e.message ?? '알 수 없는 오류');
    } finally {
      setLoading(false);
    }
  };

  // ── 이메일 로그인 ─────────────────────────────────────────
  const handleEmailLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert('입력 오류', '이메일과 비밀번호를 입력해주세요.');
      return;
    }
    setLoading(true);
    try {
      const userCredential = await signInWithEmailAndPassword(getAuth(), email.trim(), password);
      const firebaseToken  = await userCredential.user.getIdToken();
      const userInfo       = await loginToBackend(firebaseToken);
      const korean = API_TO_KOREAN[userInfo.user_type];
      if (korean) await saveUserType(korean);
      router.replace('/');
    } catch (e: any) {
      const code = e?.code ?? '';
      if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        Alert.alert('로그인 실패', '이메일 또는 비밀번호가 올바르지 않습니다.');
      } else {
        Alert.alert('로그인 실패', e?.message ?? '알 수 없는 오류');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.inner}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* 로고 */}
        <View style={styles.logoArea}>
          <Text style={styles.logoText}>Ando</Text>
          <Text style={styles.subText}>접근성 경로 안내 서비스</Text>
        </View>

        {/* 구글 로그인 */}
        <TouchableOpacity
          style={[styles.googleBtn, loading && { opacity: 0.6 }]}
          onPress={handleGoogleLogin}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#555" />
          ) : (
            <>
              <Image
                source={{ uri: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/1200px-Google_%22G%22_logo.svg.png' }}
                style={styles.googleIcon}
              />
              <Text style={styles.googleBtnText}>Google로 로그인</Text>
            </>
          )}
        </TouchableOpacity>

        {/* 구분선 */}
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>또는</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* 이메일 로그인 */}
        <TextInput
          style={styles.input}
          placeholder="이메일"
          placeholderTextColor="#999999"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="비밀번호"
          placeholderTextColor="#999999"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />

        <TouchableOpacity
          style={[styles.loginBtn, loading && { opacity: 0.7 }]}
          onPress={handleEmailLogin}
          disabled={loading}
          activeOpacity={0.85}
        >
          <Text style={styles.loginBtnText}>이메일로 로그인</Text>
        </TouchableOpacity>

        {/* 회원가입 링크 */}
        <TouchableOpacity
          style={styles.signupLink}
          onPress={() => router.push('/SignupScreen')}
        >
          <Text style={styles.signupLinkText}>
            계정이 없으신가요?{' '}
            <Text style={{ fontWeight: 'bold', textDecorationLine: 'underline' }}>회원가입</Text>
          </Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  logoArea: {
    alignItems: 'center',
    marginBottom: 36,
  },
  logoText: {
    fontSize: 44,
    fontWeight: 'bold',
    color: NAVY,
    fontStyle: 'italic',
    letterSpacing: 2,
  },
  subText: {
    fontSize: 15,
    color: TEXT_GRAY,
    marginTop: 8,
  },
  googleBtn: {
    height: 54,
    backgroundColor: '#FFF',
    borderRadius: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: BORDER_GRAY,
    marginBottom: 20,
  },
  googleIcon: {
    width: 22,
    height: 22,
    marginRight: 12,
  },
  googleBtnText: {
    color: '#444',
    fontSize: 16,
    fontWeight: '700',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: BORDER_GRAY,
  },
  dividerText: {
    color: TEXT_GRAY,
    marginHorizontal: 12,
    fontSize: 14,
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
  loginBtn: {
    height: 54,
    backgroundColor: NAVY,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  loginBtnText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  signupLink: {
    marginTop: 24,
    alignItems: 'center',
  },
  signupLinkText: {
    color: TEXT_GRAY,
    fontSize: 15,
  },
});