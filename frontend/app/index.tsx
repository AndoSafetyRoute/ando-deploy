import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { getAuth, onAuthStateChanged } from '@react-native-firebase/auth';
import HomeScreen from './HomeScreen';

export default function Index() {
  const [checking, setChecking] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getAuth(), (user) => {
      setLoggedIn(!!user);
      setChecking(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!checking && !loggedIn) {
      router.replace('/LoginScreen');
    }
  }, [checking, loggedIn]);

  if (checking || !loggedIn) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#7C6FF7' }}>
        <ActivityIndicator size="large" color="#FFF" />
      </View>
    );
  }

  return <HomeScreen />;
}
