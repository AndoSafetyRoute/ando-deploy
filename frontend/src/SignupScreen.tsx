import React, { useState } from 'react';
import {
  StyleSheet, View, Text, TextInput, TouchableOpacity,
  Alert, ScrollView, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import auth from '@react-native-firebase/auth';
import { loginToBackend } from './api';

const SignupScreen = ({ navigation }: any) => {
  const [email,           setEmail]           = useState('');
  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading,         setLoading]         = useState(false);

  const handleSignup = async () => {
    if (!email || !password || !confirmPassword) {
      Alert.alert('오류', '모든 항목을 입력해주세요');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('오류', '비밀번호가 일치하지 않습니다');
      return;
    }
    if (password.length < 6) {
      Alert.alert('오류', '비밀번호는 6자 이상이어야 합니다');
      return;
    }

    setLoading(true);
    try {
      const userCredential = await auth().createUserWithEmailAndPassword(email, password);
      const firebaseToken  = await userCredential.user.getIdToken();
      await loginToBackend(firebaseToken);
      navigation.replace('Main');
    } catch (e: any) {
      const msg: Record<string, string> = {
        'auth/email-already-in-use': '이미 사용 중인 이메일입니다',
        'auth/invalid-email':        '이메일 형식이 올바르지 않습니다',
        'auth/weak-password':        '비밀번호가 너무 약합니다',
      };
      Alert.alert('회원가입 실패', msg[e.code] ?? e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.innerContainer}>
        <Text style={styles.title}>Join Ando</Text>

        <TextInput
          style={styles.input}
          placeholder="Email Address"
          placeholderTextColor="#A9A9A9"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          editable={!loading}
        />

        <TextInput
          style={styles.input}
          placeholder="Password (6자 이상)"
          placeholderTextColor="#A9A9A9"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          editable={!loading}
        />

        <TextInput
          style={styles.input}
          placeholder="Confirm Password"
          placeholderTextColor="#A9A9A9"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
          editable={!loading}
        />

        <TouchableOpacity
          style={[styles.button, loading && styles.disabled]}
          onPress={handleSignup}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#8E82F5" />
            : <Text style={styles.buttonText}>Sign Up</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()} disabled={loading}>
          <Text style={styles.backText}>Already have an account? Login</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#8E82F5' },
  innerContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 },
  title:          { fontSize: 32, fontWeight: 'bold', color: '#FFF', marginBottom: 40 },
  input: {
    width: '100%', height: 55, backgroundColor: '#FFF', borderRadius: 10,
    paddingHorizontal: 15, marginBottom: 15, color: '#000',
  },
  button: {
    width: '100%', height: 60, backgroundColor: '#FFF', borderRadius: 30,
    justifyContent: 'center', alignItems: 'center', marginTop: 20,
  },
  disabled:    { opacity: 0.6 },
  buttonText:  { color: '#8E82F5', fontSize: 18, fontWeight: 'bold' },
  backText:    { color: '#FFF', marginTop: 20, textDecorationLine: 'underline' },
});

export default SignupScreen;
