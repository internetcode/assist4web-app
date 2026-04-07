import React, { useEffect, useState } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { Provider as PaperProvider } from 'react-native-paper';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps } from '@react-native-firebase/app';
import {
  AuthorizationStatus,
  getMessaging,
  getInitialNotification,
  getToken,
  onMessage,
  onNotificationOpenedApp,
  onTokenRefresh,
  requestPermission,
} from '@react-native-firebase/messaging';
import { StatusBar, LogBox, DeviceEventEmitter, View } from 'react-native';
import notifee, { AndroidImportance } from '@notifee/react-native';

LogBox.ignoreLogs(['InteractionManager has been deprecated']);

// Screens
import AuthScreen from './src/screens/AuthScreen';
import MainScreen from './src/screens/MainScreen';
import ChatScreen from './src/screens/ChatScreen';
import PostsScreen from './src/screens/PostsScreen';
import PostDetailsScreen from './src/screens/PostDetailsScreen';
import RegistrationScreen from './src/screens/RegistrationScreen';
import { applyNotificationCounters } from './src/utils/notificationCounters';

const Stack = createStackNavigator();
const API_BASE_URL = 'http://10.0.2.2:3000';
const navigationRef = createNavigationContainerRef<any>();

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isNavigationReady, setIsNavigationReady] = useState(false);
  const [pendingPostId, setPendingPostId] = useState<string | null>(null);

  const openPostDetailsFromNotification = (postId: string) => {
    if (!postId) {
      return;
    }

    if (isLoggedIn && isNavigationReady && navigationRef.isReady()) {
      navigationRef.navigate('PostDetails', { postId });
      return;
    }

    setPendingPostId(postId);
  };

  const getMessagingInstance = () => {
    try {
      if (getApps().length === 0) {
        console.warn(
          'Firebase is not initialized. Add google-services.json (Android) and/or GoogleService-Info.plist (iOS). Skipping FCM setup.',
        );
        return null;
      }

      return getMessaging(getApp());
    } catch (error) {
      console.warn('Unable to initialize Firebase messaging:', error);
      return null;
    }
  };

  useEffect(() => {
    checkRegistrationStatus();
    requestUserPermission();
    setupNotifeeChannel();
    AsyncStorage.setItem('chatOpen', 'false');
  }, []);

  const setupNotifeeChannel = async () => {
    await notifee.createChannel({
      id: 'chat_messages',
      name: 'Chat Messages',
      importance: AndroidImportance.HIGH,
      badge: true,
      vibration: true,
      vibrationPattern: [300, 500],
      sound: 'default',
    });
  };

  useEffect(() => {
    let unsubscribeTokenRefresh: (() => void) | undefined;

    const syncToken = async () => {
      if (!isLoggedIn) {
        return;
      }

      const token = await getFCMToken();
      if (token) {
        await registerTokenForUser(token);
      }

      const messagingInstance = getMessagingInstance();
      if (!messagingInstance) {
        return;
      }

      unsubscribeTokenRefresh = onTokenRefresh(messagingInstance, async (refreshedToken) => {
        await registerTokenForUser(refreshedToken);
      });
    };

    syncToken();

    return () => {
      unsubscribeTokenRefresh?.();
    };
  }, [isLoggedIn]);

  useEffect(() => {
    let unsubscribeForegroundMessage: (() => void) | undefined;

    const setupForegroundMessaging = () => {
      const messagingInstance = getMessagingInstance();
      if (!messagingInstance || !isLoggedIn) {
        return;
      }

      unsubscribeForegroundMessage = onMessage(messagingInstance, async (remoteMessage) => {
        const chatOpen = await AsyncStorage.getItem('chatOpen');
        const result = await applyNotificationCounters(remoteMessage, {
          chatOpen: chatOpen === 'true',
        });

        if (result.unreadCountChanged) {
          DeviceEventEmitter.emit('unreadCountUpdated', result.unreadMessagesCount);
        }

        if (result.newPostsCountChanged) {
          DeviceEventEmitter.emit('newPostsCountUpdated', result.newPostsCount);
        }

        const messageType = result.messageType;
        const badgeCount = result.unreadMessagesCount;

        const body =
          String(remoteMessage?.notification?.body || '') ||
          String(remoteMessage?.data?.message || '') ||
          (messageType === 'new_post'
            ? 'A new post is available.'
            : 'You have a new message from admin.');

        const title =
          remoteMessage?.notification?.title ||
          (messageType === 'new_post' ? 'New post available' : 'New message');

        await notifee.setBadgeCount(badgeCount);
        await notifee.displayNotification({
          title,
          body,
          android: {
            channelId: 'chat_messages',
            smallIcon: 'ic_launcher',
            pressAction: { id: 'default' },
            badgeCount,
            importance: AndroidImportance.HIGH,
            vibrationPattern: [300, 500],
          },
          ios: {
            badgeCount,
            sound: 'default',
          },
        });
      });
    };

    setupForegroundMessaging();

    return () => {
      unsubscribeForegroundMessage?.();
    };
  }, [isLoggedIn]);

  useEffect(() => {
    let unsubscribeNotificationOpen: (() => void) | undefined;

    const setupNotificationOpenHandling = () => {
      const messagingInstance = getMessagingInstance();
      if (!messagingInstance || !isLoggedIn) {
        return;
      }

      const handleNotificationOpen = async (remoteMessage: any) => {
        if (!remoteMessage) {
          return;
        }

        const result = await applyNotificationCounters(remoteMessage, { chatOpen: false });

        if (result.unreadCountChanged) {
          DeviceEventEmitter.emit('unreadCountUpdated', result.unreadMessagesCount);
        }

        if (result.newPostsCountChanged) {
          DeviceEventEmitter.emit('newPostsCountUpdated', result.newPostsCount);
        }

        if (result.messageType === 'new_post') {
          const postId = String(remoteMessage?.data?.postId || '');
          openPostDetailsFromNotification(postId);
        }
      };

      unsubscribeNotificationOpen = onNotificationOpenedApp(messagingInstance, handleNotificationOpen);

      getInitialNotification(messagingInstance)
        .then(handleNotificationOpen)
        .catch((error) => {
          console.warn('Failed to handle initial notification:', error);
        });
    };

    setupNotificationOpenHandling();

    return () => {
      unsubscribeNotificationOpen?.();
    };
  }, [isLoggedIn]);

  useEffect(() => {
    if (!pendingPostId) {
      return;
    }

    if (!isLoggedIn || !isNavigationReady || !navigationRef.isReady()) {
      return;
    }

    navigationRef.navigate('PostDetails', { postId: pendingPostId });
    setPendingPostId(null);
  }, [pendingPostId, isLoggedIn, isNavigationReady]);

  const checkRegistrationStatus = async () => {
    try {
      const [loggedIn, userId, registered] = await Promise.all([
        AsyncStorage.getItem('isLoggedIn'),
        AsyncStorage.getItem('userId'),
        AsyncStorage.getItem('isRegistered'),
      ]);

      // Treat session as valid only when login flag is true and a user id exists.
      setIsLoggedIn(loggedIn === 'true' && Boolean(userId));
      setIsRegistered(registered === 'true');
    } finally {
      setIsAuthReady(true);
    }
  };

  const requestUserPermission = async () => {
    await notifee.requestPermission();

    const messagingInstance = getMessagingInstance();

    if (!messagingInstance) {
      return;
    }

    const authStatus = await requestPermission(messagingInstance);
    const enabled =
      authStatus === AuthorizationStatus.AUTHORIZED ||
      authStatus === AuthorizationStatus.PROVISIONAL;

    if (enabled) {
      console.log('Authorization status:', authStatus);
    }
  };

  const getFCMToken = async (): Promise<string | null> => {
    const messagingInstance = getMessagingInstance();

    if (!messagingInstance) {
      return null;
    }

    const fcmToken = await getToken(messagingInstance);
    if (fcmToken) {
      console.log('FCM Token:', fcmToken);
      return fcmToken;
    }

    return null;
  };

  const registerTokenForUser = async (token: string) => {
    const userId = await AsyncStorage.getItem('userId');

    if (!userId || !token) {
      return;
    }

    try {
      await fetch(`${API_BASE_URL}/token/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: Number(userId), token }),
      });
    } catch (error) {
      console.warn('Failed to register push token:', error);
    }
  };

  if (!isAuthReady) {
    return <View style={{ flex: 1, backgroundColor: '#5FAE3E' }} />;
  }

  return (
    <PaperProvider>
      <NavigationContainer ref={navigationRef} onReady={() => setIsNavigationReady(true)}>
        <StatusBar barStyle="light-content" />
        <Stack.Navigator
          screenOptions={{
            headerShown: true,
            headerTintColor: '#1c2f57',
            headerTitleStyle: { fontWeight: '600' },
          }}
        >
          {!isLoggedIn ? (
            <Stack.Group>
              {!isRegistered && (
                <Stack.Screen name="Registration" options={{ title: 'Create Account' }}>
                  {(props) => (
                    <RegistrationScreen
                      {...props}
                      onRegistered={() => {
                        setIsRegistered(true);
                        setIsLoggedIn(true);
                      }}
                    />
                  )}
                </Stack.Screen>
              )}
              <Stack.Screen name="Auth" options={{ title: 'Login' }}>
                {(props) => (
                  <AuthScreen
                    {...props}
                    isLoggedIn={isLoggedIn}
                    onLoggedIn={() => setIsLoggedIn(true)}
                    onLoggedOut={() => setIsLoggedIn(false)}
                  />
                )}
              </Stack.Screen>
            </Stack.Group>
          ) : (
            <>
              <Stack.Screen name="Main" component={MainScreen} options={{ title: 'Main' }} />
              <Stack.Screen name="Posts" component={PostsScreen} options={{ title: 'Latest News' }} />
              <Stack.Screen name="PostDetails" component={PostDetailsScreen} options={{ title: 'News Details' }} />
              <Stack.Screen name="Chat" component={ChatScreen} options={{ title: 'Chat' }} />
              <Stack.Screen name="Auth" options={{ title: 'Account' }}>
                {(props) => (
                  <AuthScreen
                    {...props}
                    isLoggedIn={isLoggedIn}
                    onLoggedIn={() => setIsLoggedIn(true)}
                    onLoggedOut={() => setIsLoggedIn(false)}
                  />
                )}
              </Stack.Screen>
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </PaperProvider>
  );
}
