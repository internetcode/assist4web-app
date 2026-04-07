import React, { useMemo, useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { TextInput, Button, Text, SegmentedButtons, IconButton } from 'react-native-paper';
import LinearGradient from 'react-native-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ASSIST4WEB_GRADIENT } from '../theme/branding';
import { API_BASE_URL, withJsonApiHeaders } from '../config/network';

type AuthMode = 'login' | 'register';

type AuthScreenProps = {
  isLoggedIn: boolean;
  onLoggedIn: () => void;
  onLoggedOut: () => void;
};

const AuthScreen = ({ isLoggedIn, onLoggedIn, onLoggedOut, navigation }: any) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [shouldAutoRedirect, setShouldAutoRedirect] = useState(false);

  const [identifier, setIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');

  const title = useMemo(() => {
    if (isLoggedIn) {
      return 'Account';
    }

    return mode === 'login' ? 'Login' : 'Register';
  }, [isLoggedIn, mode]);

  React.useEffect(() => {
    if (!isLoggedIn || !shouldAutoRedirect) {
      return;
    }

    const timer = setTimeout(() => {
      setShouldAutoRedirect(false);
      navigation.navigate('Main');
    }, 1500);

    return () => clearTimeout(timer);
  }, [isLoggedIn, shouldAutoRedirect, navigation]);

  const generatePassword = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';

    for (let i = 0; i < 12; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    setRegisterPassword(result);
    return result;
  };

  const handleLogin = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/login`, {
        method: 'POST',
        headers: withJsonApiHeaders(),
        body: JSON.stringify({ identifier, password: loginPassword }),
      });

      if (!response.ok) {
        Alert.alert('Error', 'Invalid credentials');
        return;
      }

      const data = await response.json();
      await AsyncStorage.setItem('isLoggedIn', 'true');
      await AsyncStorage.setItem('isRegistered', 'true');
      await AsyncStorage.setItem('userId', data.user.id.toString());
      setShouldAutoRedirect(true);
      onLoggedIn();
    } catch (error) {
      Alert.alert('Error', 'Network error while logging in.');
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
      setLoginPassword(data.temporaryPassword || '');
    } catch (error) {
      Alert.alert('Forgot Password', 'Network error. Please try again.');
    }
  };

  const handleRegister = async () => {
    if (!name || !company || !email) {
      Alert.alert('Error', 'Name, Company, and Email are required');
      return;
    }

    const finalPassword = registerPassword || generatePassword();

    try {
      const response = await fetch(`${API_BASE_URL}/register`, {
        method: 'POST',
        headers: withJsonApiHeaders(),
        body: JSON.stringify({ name, company, email, password: finalPassword }),
      });

      if (!response.ok) {
        Alert.alert('Error', 'Registration failed');
        return;
      }

      const data = await response.json();
      await AsyncStorage.setItem('isRegistered', 'true');
      await AsyncStorage.setItem('isLoggedIn', 'true');
      await AsyncStorage.setItem('userName', name);
      await AsyncStorage.setItem('userId', data.id.toString());

      Alert.alert('Success', `Registration complete. Your password is: ${finalPassword}`);
      setShouldAutoRedirect(true);
      onLoggedIn();
    } catch (error) {
      Alert.alert('Error', 'Network error while registering.');
    }
  };

  const handleLogout = async () => {
    await AsyncStorage.multiRemove([
      'isLoggedIn',
      'userId',
      'userName',
      'processedNotificationIds',
    ]);
    onLoggedOut();
  };

  return (
    <LinearGradient colors={ASSIST4WEB_GRADIENT} style={styles.container}>
      {isLoggedIn ? (
        <View style={styles.backToMainWrapScreen}>
          <IconButton
            icon={() => <Text style={styles.backEmoji}>🏠</Text>}
            iconColor="#ffffff"
            containerColor="rgba(0,0,0,0.22)"
            size={22}
            style={styles.backToMainBtn}
            onPress={() => navigation.navigate('Main')}
          />
          <Button
            mode="text"
            compact
            style={styles.backToMainTextBtn}
            labelStyle={styles.backToMainTextLabel}
            onPress={() => navigation.navigate('Main')}
          >
            Back to Main screen
          </Button>
        </View>
      ) : null}

      <View style={styles.form}>
        <Text style={styles.title}>{title}</Text>

        {isLoggedIn ? (
          <>
            <Text style={styles.loggedInfo}>You are logged in.</Text>
            <Button mode="contained" onPress={handleLogout} style={styles.button}>
              Logout
            </Button>
          </>
        ) : (
          <>
            <SegmentedButtons
              value={mode}
              onValueChange={(value) => setMode(value as AuthMode)}
              buttons={[
                { label: 'Login', value: 'login' },
                { label: 'Register', value: 'register' },
              ]}
              style={styles.segmented}
            />

            {mode === 'login' ? (
              <>
                <TextInput
                  label="Name or Email"
                  value={identifier}
                  onChangeText={setIdentifier}
                  style={styles.input}
                />
                <TextInput
                  label="Password"
                  value={loginPassword}
                  onChangeText={setLoginPassword}
                  style={styles.input}
                  secureTextEntry
                />
                <Button mode="contained" onPress={handleLogin} style={styles.button}>
                  Login
                </Button>
                <Button onPress={handleForgotPassword} style={styles.button}>
                  Forgot Password
                </Button>
              </>
            ) : (
              <>
                <TextInput label="Name" value={name} onChangeText={setName} style={styles.input} />
                <TextInput label="Company" value={company} onChangeText={setCompany} style={styles.input} />
                <TextInput
                  label="Email"
                  value={email}
                  onChangeText={setEmail}
                  style={styles.input}
                  keyboardType="email-address"
                />
                <TextInput
                  label="Password (leave blank to generate)"
                  value={registerPassword}
                  onChangeText={setRegisterPassword}
                  style={styles.input}
                  secureTextEntry
                />
                <Button mode="contained" onPress={handleRegister} style={styles.button}>
                  Register
                </Button>
              </>
            )}
          </>
        )}
      </View>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 20 },
  form: { backgroundColor: 'rgba(255,255,255,0.9)', padding: 20, borderRadius: 10 },
  backToMainWrapScreen: {
    position: 'absolute',
    top: 10,
    right: 10,
    zIndex: 3,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)',
    borderRadius: 999,
    paddingRight: 8,
  },
  backToMainBtn: { margin: 0, borderRadius: 999, width: 36, height: 36 },
  backToMainTextBtn: { marginLeft: 2 },
  backToMainTextLabel: { color: '#ffffff', fontWeight: '700', fontSize: 13, marginHorizontal: 0 },
  backEmoji: { fontSize: 20, lineHeight: 20, textAlign: 'center' },
  title: { fontSize: 24, textAlign: 'center', marginBottom: 20 },
  loggedInfo: { textAlign: 'center', marginBottom: 12, color: '#333' },
  segmented: { marginBottom: 14 },
  input: { marginBottom: 10 },
  button: { marginTop: 10 },
});

export default AuthScreen;