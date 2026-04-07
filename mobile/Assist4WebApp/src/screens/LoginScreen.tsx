import React, { useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { TextInput, Button, Text } from 'react-native-paper';
import LinearGradient from 'react-native-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ASSIST4WEB_GRADIENT } from '../theme/branding';
import { API_BASE_URL, withJsonApiHeaders } from '../config/network';

type LoginScreenProps = {
  onLoggedIn: () => void;
};

const LoginScreen = ({ onLoggedIn }: LoginScreenProps) => {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = async () => {
    // TODO: Send to backend
    const response = await fetch(`${API_BASE_URL}/login`, {
      method: 'POST',
      headers: withJsonApiHeaders(),
      body: JSON.stringify({ identifier, password }),
    });

    if (response.ok) {
      const data = await response.json();
      await AsyncStorage.setItem('isLoggedIn', 'true');
      await AsyncStorage.setItem('userId', data.user.id.toString());
      onLoggedIn();
    } else {
      Alert.alert('Error', 'Invalid credentials');
    }
  };

  const handleForgotPassword = async () => {
    const trimmedIdentifier = identifier.trim();

    if (!trimmedIdentifier) {
      Alert.alert('Forgot Password', 'Enter your name or email first.');
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/forgot-password`, {
        method: 'POST',
        headers: withJsonApiHeaders(),
        body: JSON.stringify({ identifier: trimmedIdentifier }),
      });

      const data = await response.json();

      if (!response.ok) {
        Alert.alert('Forgot Password', data.error || 'Unable to reset password.');
        return;
      }

      Alert.alert('Temporary Password', `Your new password is: ${data.temporaryPassword}`);
      setPassword(data.temporaryPassword || '');
    } catch (error) {
      Alert.alert('Forgot Password', 'Network error. Please try again.');
    }
  };

  return (
    <LinearGradient colors={ASSIST4WEB_GRADIENT} style={styles.container}>
      <View style={styles.form}>
        <Text style={styles.title}>Login</Text>
        <TextInput label="Name or Email" value={identifier} onChangeText={setIdentifier} style={styles.input} />
        <TextInput label="Password" value={password} onChangeText={setPassword} style={styles.input} secureTextEntry />
        <Button mode="contained" onPress={handleLogin} style={styles.button}>
          Login
        </Button>
        <Button onPress={handleForgotPassword} style={styles.button}>
          Forgot Password
        </Button>
      </View>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 20 },
  form: { backgroundColor: 'rgba(255,255,255,0.9)', padding: 20, borderRadius: 10 },
  title: { fontSize: 24, textAlign: 'center', marginBottom: 20 },
  input: { marginBottom: 10 },
  button: { marginTop: 10 },
});

export default LoginScreen;