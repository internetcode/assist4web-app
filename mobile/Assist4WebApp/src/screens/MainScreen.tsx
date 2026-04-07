import React from 'react';
import { StyleSheet, View, Text, DeviceEventEmitter, Dimensions, Pressable } from 'react-native';
import { FAB, IconButton } from 'react-native-paper';
import LinearGradient from 'react-native-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import { ASSIST4WEB_GRADIENT, ASSIST4WEB_TEXT_SHADOW } from '../theme/branding';
import { API_BASE_URL, withApiHeaders } from '../config/network';

const MainScreen = ({ navigation }: any) => {
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [newPostsCount, setNewPostsCount] = React.useState(0);
  const [simulatedPostNotifications, setSimulatedPostNotifications] = React.useState<string[]>([]);

  const ensureNewPostMessageVisible = React.useCallback(() => {
    const message = 'New post is available';
    setSimulatedPostNotifications(prev => (prev.includes(message) ? prev : [message, ...prev].slice(0, 4)));
  }, []);

  const loadUnreadCount = React.useCallback(async () => {
    const userId = await AsyncStorage.getItem('userId');
    if (!userId) {
      setUnreadCount(0);
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/messages/unread/${userId}`, {
        headers: withApiHeaders(),
      });
      if (response.ok) {
        const data = await response.json();
        const count = Number(data.count || 0);
        setUnreadCount(count);
        await AsyncStorage.setItem('unreadMessagesCount', String(count));
        return;
      }
    } catch (error) {}

    const cachedCount = await AsyncStorage.getItem('unreadMessagesCount');
    setUnreadCount(Number(cachedCount || '0'));
  }, []);

  const loadNewPostsCount = React.useCallback(async () => {
    const cachedCount = await AsyncStorage.getItem('newPostsCount');
    const count = Number(cachedCount || '0');
    setNewPostsCount(count);
    if (count > 0) {
      ensureNewPostMessageVisible();
    }
  }, [ensureNewPostMessageVisible]);

  React.useEffect(() => {
    loadUnreadCount();
    loadNewPostsCount();

    const unreadSubscription = DeviceEventEmitter.addListener('unreadCountUpdated', (value: number) => {
      setUnreadCount(Number(value || 0));
    });

    const newPostsSubscription = DeviceEventEmitter.addListener('newPostsCountUpdated', (value: number) => {
      const count = Number(value || 0);
      setNewPostsCount(count);
      if (count > 0) {
        ensureNewPostMessageVisible();
      }
    });

    return () => {
      unreadSubscription.remove();
      newPostsSubscription.remove();
    };
  }, [loadUnreadCount, loadNewPostsCount, ensureNewPostMessageVisible]);

  useFocusEffect(
    React.useCallback(() => {
      loadUnreadCount();
      loadNewPostsCount();
    }, [loadUnreadCount, loadNewPostsCount]),
  );

  const openPosts = async () => {
    await AsyncStorage.setItem('newPostsCount', '0');
    setNewPostsCount(0);
    setSimulatedPostNotifications([]);
    DeviceEventEmitter.emit('newPostsCountUpdated', 0);
    navigation.navigate('Posts');
  };

  const gotoAccount = () => {
    console.log('gotoAccount called, navigation:', navigation);
    if (navigation) {
      navigation.navigate('Auth');
    }
  };

  const openChat = () => {
    navigation.navigate('Chat');
  };

  return (
    <LinearGradient colors={ASSIST4WEB_GRADIENT} style={styles.container}>
      <Pressable style={styles.accountWrap} onPress={gotoAccount}>
        <IconButton
          icon={() => <Text style={styles.iconEmoji}>👤</Text>}
          iconColor="#ffffff"
          containerColor="rgba(0,0,0,0.25)"
          size={24}
          style={styles.accountIconBtn}
        />
        <Text style={styles.iconLabelText}>My profile</Text>
      </Pressable>
      <View style={styles.homeTopWrap} pointerEvents="none">
        <View style={styles.homePill}>
          <IconButton
            icon={() => <Text style={styles.homeEmoji}>🏠</Text>}
            iconColor="#ffffff"
            containerColor="rgba(0,0,0,0.22)"
            size={22}
            style={styles.homeIconBtn}
          />
          <Text style={styles.homeLabel}>Main</Text>
        </View>
      </View>
      <Pressable style={styles.chatBadgeWrap} onPress={openChat}>
        <View style={styles.iconWithBadge}>
          <IconButton
            icon={() => <Text style={styles.iconEmoji}>💬</Text>}
            iconColor="#ffffff"
            containerColor="rgba(0,0,0,0.25)"
            size={24}
            style={styles.chatTopButton}
          />
          {unreadCount > 0 ? (
            <View style={styles.badgeSquare}>
              <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.iconLabelText}>Support Chat</Text>
      </Pressable>
      <View style={styles.centerContent}>
        <Text style={[styles.subHintText, { marginTop: Dimensions.get('window').height * 0.2 }]}>Open latest News &&</Text>
        <Text style={styles.subHintText}>Tasks Done</Text>
        {simulatedPostNotifications.length > 0 ? (
          <View style={styles.simulationListWrap}>
            {simulatedPostNotifications.map((item, index) => (
              <Text key={`${item}-${index}`} style={styles.simulationListItem}>
                • {item}
              </Text>
            ))}
          </View>
        ) : null}
        <View style={styles.newsFabWrap}>
          <FAB
            icon={() => <Text style={styles.fabEmoji}>✏️</Text>}
            label="Show News"
            uppercase={false}
            onPress={openPosts}
            style={styles.newsFab}
          />
          {newPostsCount > 0 ? (
            <View style={styles.newsBadgeSquare}>
              <Text style={styles.badgeText}>{newPostsCount > 99 ? '99+' : newPostsCount}</Text>
            </View>
          ) : null}
        </View>
      </View>
      <Text style={styles.teamHintText}>by assist4web team</Text>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  centerContent: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, paddingBottom: Dimensions.get('window').height * 0.2 },
  homeTopWrap: { position: 'absolute', top: 16, left: 0, right: 0, zIndex: 2, alignItems: 'center' },
  homePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)',
    borderRadius: 999,
    paddingRight: 8,
    paddingLeft: 0,
    marginBottom: 4,
  },
  homeIconBtn: { margin: 0, borderRadius: 999, width: 36, height: 36 },
  homeEmoji: { fontSize: 20, lineHeight: 20, textAlign: 'center' },
  homeLabel: { color: '#ffffff', fontWeight: '700', fontSize: 13, marginLeft: 2, marginRight: 4, ...ASSIST4WEB_TEXT_SHADOW },
  subHintText: { color: '#e9eef8', fontSize: 16, textAlign: 'center', marginTop: 6, ...ASSIST4WEB_TEXT_SHADOW },
  teamHintText: {
    color: '#d8e1f2',
    fontSize: 12,
    textAlign: 'center',
    position: 'absolute',
    alignSelf: 'center',
    bottom: 22,
    ...ASSIST4WEB_TEXT_SHADOW,
  },
  iconEmoji: { fontSize: 20, lineHeight: 20 },
  fabEmoji: { fontSize: 22, lineHeight: 22 },
  accountWrap: { position: 'absolute', top: 16, right: 16, zIndex: 2, alignItems: 'center', width: 96 },
  accountIconBtn: { margin: 0 },
  chatBadgeWrap: { position: 'absolute', top: 16, left: 16, zIndex: 2, alignItems: 'center', width: 96 },
  iconWithBadge: { position: 'relative' },
  chatTopButton: { margin: 0 },
  iconLabelText: { color: '#d8e1f2', fontSize: 12, textAlign: 'center', marginTop: 2, ...ASSIST4WEB_TEXT_SHADOW },
  simulationListWrap: {
    marginTop: 14,
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    width: '100%',
    maxWidth: 320,
  },
  simulationListItem: { color: '#f1f5ff', fontSize: 13, marginVertical: 2, textAlign: 'center', ...ASSIST4WEB_TEXT_SHADOW },
  newsFabWrap: { marginTop: 24 },
  badgeSquare: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 22,
    height: 22,
    backgroundColor: '#d90429',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800', ...ASSIST4WEB_TEXT_SHADOW },
  newsFab: { backgroundColor: 'yellowgreen' },
  newsBadgeSquare: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 22,
    height: 22,
    backgroundColor: '#d90429',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
});

export default MainScreen;