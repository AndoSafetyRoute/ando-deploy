import React, { useState } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { loginToBackend } from '../src/api';
import { clearLocalUserData } from '../src/utils/storage';

let _getApp: any = null;
let _getAuth: any = null;
let _createUserWithEmailAndPassword: any = null;
let _getIdToken: any = null;
try {
  const firebaseApp  = require('@react-native-firebase/app');
  const firebaseAuth = require('@react-native-firebase/auth');
  _getApp                         = firebaseApp.getApp;
  _getAuth                        = firebaseAuth.getAuth;
  _createUserWithEmailAndPassword = firebaseAuth.createUserWithEmailAndPassword;
  _getIdToken                     = firebaseAuth.getIdToken;
} catch {}

// 나머지 화면과 같은 배색 — 로그인 화면과 짝을 맞춘다.
const NAVY       = '#1B0F4A';
const LIGHT_GRAY = '#F1F2F6';
const BORDER_GRAY = '#E4E5EA';
const TEXT_GRAY  = '#666666';

export default function SignupScreen() {
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading]         = useState(false);

  const handleSignup = async () => {
    if (!email.trim() || !password || !confirmPassword) {
      Alert.alert('입력 오류', '모든 항목을 입력해주세요.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('입력 오류', '비밀번호가 일치하지 않습니다.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('입력 오류', '비밀번호는 6자 이상이어야 합니다.');
      return;
    }
    if (!_getAuth || !_createUserWithEmailAndPassword) {
      Alert.alert('오류', 'Firebase가 초기화되지 않았습니다.');
      return;
    }
    try {
      setLoading(true);
      const cred = await _createUserWithEmailAndPassword(_getAuth(_getApp()), email.trim(), password);
      try {
        const token = await _getIdToken(cred.user);
        await loginToBackend(token);
      } catch { /* 서버 등록 실패해도 로컬 가입은 완료 */ }
      // 같은 기기의 이전 계정이 남긴 경로 기록·즐겨찾기가 새 계정에 그대로
      // 보이는 문제 방지 — 새 계정은 항상 깨끗한 상태로 시작해야 한다.
      await clearLocalUserData();
      Alert.alert('가입 완료', '회원가입이 완료되었습니다!', [
        { text: '확인', onPress: () => router.replace('/') },
      ]);
    } catch (e: any) {
      const code = e?.code ?? '';
      if (code === 'auth/email-already-in-use') {
        Alert.alert('가입 실패', '이미 사용 중인 이메일입니다.');
      } else if (code === 'auth/invalid-email') {
        Alert.alert('가입 실패', '유효하지 않은 이메일 형식입니다.');
      } else {
        Alert.alert('가입 실패', e?.message ?? '알 수 없는 오류가 발생했습니다.');
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
        <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>회원가입</Text>
          <Text style={styles.sub}>Ando에 오신 것을 환영합니다</Text>

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
            placeholder="비밀번호 (6자 이상)"
            placeholderTextColor="#999999"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
          <TextInput
            style={styles.input}
            placeholder="비밀번호 확인"
            placeholderTextColor="#999999"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.btn, loading && { opacity: 0.7 }]}
            onPress={handleSignup}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color={NAVY} />
              : <Text style={styles.btnText}>가입하기</Text>
            }
          </TouchableOpacity>

          <TouchableOpacity style={styles.backLink} onPress={() => router.back()}>
            <Text style={styles.backText}>이미 계정이 있으신가요? <Text style={{ fontWeight: 'bold', textDecorationLine: 'underline' }}>로그인</Text></Text>
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
  inner: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 40,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: NAVY,
    marginBottom: 8,
    textAlign: 'center',
  },
  sub: {
    fontSize: 15,
    color: TEXT_GRAY,
    textAlign: 'center',
    marginBottom: 36,
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
    marginTop: 8,
  },
  btnText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
  },
  backLink: {
    marginTop: 24,
    alignItems: 'center',
  },
  backText: {
    color: TEXT_GRAY,
    fontSize: 15,
  },
});