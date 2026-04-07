import React, { useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { TextInput, Button, Text } from 'react-native-paper';
import LinearGradient from 'react-native-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TouchableOpacity } from 'react-native';
import { ASSIST4WEB_GRADIENT } from '../theme/branding';
import { API_BASE_URL, withJsonApiHeaders } from '../config/network';

type RegistrationScreenProps = {
  navigation: any;
  onRegistered: () => void;
};

const RegistrationScreen = ({ navigation, onRegistered }: RegistrationScreenProps) => {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const generatePassword = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 12; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setPassword(result);
    return result;
  };

  const handleRegister = async () => {
    if (!name || !company || !email) {
      Alert.alert('Error', 'Name, Company, and Email are required');
      return;
    }

    const finalPassword = password || generatePassword();

    // TODO: Send to backend
    const response = await fetch(`${API_BASE_URL}/register`, {
      method: 'POST',
      headers: withJsonApiHeaders(),
      body: JSON.stringify({ name, company, email, password: finalPassword }),
    });

    if (response.ok) {
      const data = await response.json();
      await AsyncStorage.setItem('isRegistered', 'true');
      await AsyncStorage.setItem('userName', name);
      await AsyncStorage.setItem('isLoggedIn', 'true');
      await AsyncStorage.setItem('userId', data.id.toString());
      Alert.alert('Success', 'Registration complete. Your password is: ' + finalPassword, [
        { text: 'OK', onPress: () => onRegistered() },
      ]);
    } else {
      Alert.alert('Error', 'Registration failed');
    }
  };

  return (
    <LinearGradient colors={ASSIST4WEB_GRADIENT} style={styles.container}>
      <View style={styles.form}>
        <Text style={styles.title}>Register</Text>
        <TextInput label="Name" value={name} onChangeText={setName} style={styles.input} />
        <TextInput label="Company" value={company} onChangeText={setCompany} style={styles.input} />
        <TextInput label="Email" value={email} onChangeText={setEmail} style={styles.input} keyboardType="email-address" />
        <TextInput label="Password (leave blank to generate)" value={password} onChangeText={setPassword} style={styles.input} secureTextEntry />
        <Button mode="contained" onPress={handleRegister} style={styles.button}>
          Register
        </Button>
        <TouchableOpacity onPress={() => navigation.navigate('Auth')} style={styles.loginLink}>
          <Text style={styles.loginLinkText}>Already have an account? Login</Text>
        </TouchableOpacity>
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
  loginLink: { marginTop: 16, alignItems: 'center' },
  loginLinkText: { color: '#1565c0', fontSize: 14, fontWeight: '600' },
});

export default RegistrationScreen;