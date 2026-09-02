import React from 'react';
import {
  StyleSheet, View, Text, TouchableOpacity,
  Image, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import auth from '@react-native-firebase/auth';
import { loginToBackend } from './api';

const WEB_CLIENT_ID = '139320931299-jc0pbgegf8eqeg11096bc4i6ad0ak7rj.apps.googleusercontent.com';

GoogleSignin.configure({ webClientId: WEB_CLIENT_ID });

const LoginScreen = ({ navigation }: any) => {
  const [loading, setLoading] = React.useState(false);

  const handleGoogleLogin = async () => {
    setLoading(true);
    try {
      await GoogleSignin.hasPlayServices();
      const signInResult = await GoogleSignin.signIn();
      const idToken = signInResult.data?.idToken;
      if (!idToken) throw new Error('Google 토큰을 받지 못했습니다');
      const credential     = auth.GoogleAuthProvider.credential(idToken);
      const userCredential = await auth().signInWithCredential(credential);
      const firebaseToken  = await userCredential.user.getIdToken();
      await loginToBackend(firebaseToken);
      navigation.replace('Main');
    } catch (e: any) {
      Alert.alert('Google 로그인 실패', e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.innerContainer}>
        <Text style={styles.logoText}>Ando</Text>
        <Text style={styles.subText}>Safe Route Guide</Text>

        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[styles.googleButton, loading && styles.disabled]}
            disabled={loading}
            onPress={handleGoogleLogin}
          >
            {loading ? (
              <ActivityIndicator color="#555" />
            ) : (
              <>
                <Image
                  source={{ uri: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/1200px-Google_%22G%22_logo.svg.png' }}
                  style={styles.googleIcon}
                />
                <Text style={styles.googleButtonText}>Continue with Google</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.signupLink}
            onPress={() => navigation.navigate('Signup')}
          >
            <Text style={styles.signupLinkText}>Don't have an account? Sign Up</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#8E82F5' },
  innerContainer:  { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 },
  logoText:        { fontSize: 60, fontWeight: 'bold', color: '#FFF', fontStyle: 'italic' },
  subText:         { fontSize: 18, color: '#FFF', marginBottom: 100, opacity: 0.8 },
  buttonContainer: { width: '100%' },
  googleButton: {
    width: '100%', height: 60, backgroundColor: '#FFF', borderRadius: 30,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', elevation: 5,
  },
  disabled:        { opacity: 0.6 },
  googleIcon:      { width: 24, height: 24, marginRight: 15 },
  googleButtonText:{ color: '#555', fontSize: 18, fontWeight: 'bold' },
  signupLink:      { marginTop: 20, alignItems: 'center' },
  signupLinkText:  { color: '#FFF', textDecorationLine: 'underline' },
});

export default LoginScreen;
