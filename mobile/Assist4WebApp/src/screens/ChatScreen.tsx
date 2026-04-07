import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  FlatList,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Text,
  TouchableOpacity,
  DeviceEventEmitter,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import io from 'socket.io-client';
import notifee from '@notifee/react-native';
import { Button, IconButton } from 'react-native-paper';
import LinearGradient from 'react-native-linear-gradient';
import { ASSIST4WEB_GRADIENT } from '../theme/branding';
import {
  API_BASE_URL,
  socketAuthOptions,
  withApiHeaders,
  withJsonApiHeaders,
} from '../config/network';
import { decryptE2EE, encryptE2EE } from '../utils/e2ee';

const E2EE_KEY_STORAGE_PREFIX = 'chatE2EEKey:';

type Message = {
  id: number;
  text: string;
  fromMe: boolean;
  timestamp: number;
};

type ChatListItem =
  | {
      type: 'separator';
      id: string;
      label: string;
    }
  | {
      type: 'message';
      id: string;
      message: Message;
    };

const getDayKey = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const getDateSeparatorLabel = (timestamp: number) => {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (getDayKey(timestamp) === getDayKey(today.getTime())) {
    return 'Today';
  }

  if (getDayKey(timestamp) === getDayKey(yesterday.getTime())) {
    return 'Yesterday';
  }

  return date.toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

const getCompletedTaskNumber = (text: string) => {
  if (!/^completed task/i.test(text)) {
    return null;
  }

  const match = text.match(/(?:Num|Number|Task\s*#):\s*(\d+)/i);
  if (!match) {
    return null;
  }

  return Number(match[1]);
};

const ChatScreen = ({ navigation }: any) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [e2eePassphrase, setE2eePassphrase] = useState('');
  const [e2eeDraft, setE2eeDraft] = useState('');
  const socketRef = useRef<any>(null);
  const e2eeKeyRef = useRef('');
  const flatListRef = useRef<FlatList>(null);

  React.useEffect(() => {
    e2eeKeyRef.current = e2eePassphrase;
  }, [e2eePassphrase]);

  const loadHistory = React.useCallback(async (uid: string | null, keyOverride = '') => {
    if (!uid) {
      setMessages([]);
      return;
    }

    try {
      const res = await fetch(`${API_BASE_URL}/messages/history/${uid}`, {
        headers: withApiHeaders(),
      });
      if (res.ok) {
        const history = await res.json();
        const activeKey = keyOverride || e2eeKeyRef.current;
        setMessages(
          history.map((m: any) => ({
            id: m.id,
            text: decryptE2EE(m.message, activeKey, uid),
            fromMe: m.fromUserId !== 0,
            timestamp: m.timestamp,
          })),
        );
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    let socket: any;
    const init = async () => {
      const uid = await AsyncStorage.getItem('userId');
      setUserId(uid);
      await AsyncStorage.setItem('chatOpen', 'true');

      const keyStorageName = `${E2EE_KEY_STORAGE_PREFIX}${uid || 'default'}`;
      const storedPassphrase = (await AsyncStorage.getItem(keyStorageName)) || '';
      setE2eePassphrase(storedPassphrase);
      setE2eeDraft(storedPassphrase);

      // Load history
      await loadHistory(uid, storedPassphrase);

      // Connect socket
      socket = io(API_BASE_URL, socketAuthOptions());
      socketRef.current = socket;
      // Re-join room on every (re)connect so room membership survives server restarts
      socket.on('connect', () => {
        socket.emit('userJoin', uid);
      });
      socket.on('receiveFromAdmin', ({ message, timestamp }: any) => {
        const decryptedMessage = decryptE2EE(
          message,
          e2eeKeyRef.current,
          uid || 'default',
        );
        setMessages(prev => [
          ...prev,
          { id: Date.now(), text: decryptedMessage, fromMe: false, timestamp },
        ]);

        if (uid) {
          fetch(`${API_BASE_URL}/messages/read/${uid}`, {
            method: 'POST',
            headers: withJsonApiHeaders(),
          }).catch(() => {});
        }
        AsyncStorage.setItem('unreadMessagesCount', '0');
        DeviceEventEmitter.emit('unreadCountUpdated', 0);
      });

      socket.on('taskCompletedGroupingUpdated', async () => {
        await loadHistory(uid, e2eeKeyRef.current);
      });

      if (uid) {
        fetch(`${API_BASE_URL}/messages/read/${uid}`, {
          method: 'POST',
          headers: withJsonApiHeaders(),
        }).catch(() => {});
      }
      await AsyncStorage.setItem('unreadMessagesCount', '0');
      DeviceEventEmitter.emit('unreadCountUpdated', 0);
      await notifee.setBadgeCount(0);
      await notifee.cancelAllNotifications();
    };

    init();
    return () => {
      AsyncStorage.setItem('chatOpen', 'false');
      socket?.disconnect();
    };
  }, []);

  const sendMessage = () => {
    const text = inputText.trim();
    if (!text || !userId) return;
    const timestamp = Date.now();
    const outboundMessage = encryptE2EE(text, e2eeKeyRef.current, userId);
    socketRef.current?.emit('sendToAdmin', {
      message: outboundMessage,
      timestamp,
      userId: Number(userId),
    });
    setMessages(prev => [...prev, { id: timestamp, text, fromMe: true, timestamp }]);
    setInputText('');
  };

  const saveE2EEKey = async () => {
    if (!userId) {
      return;
    }

    const storageKey = `${E2EE_KEY_STORAGE_PREFIX}${userId}`;
    const normalized = e2eeDraft.trim();

    if (!normalized) {
      await AsyncStorage.removeItem(storageKey);
      setE2eePassphrase('');
      await loadHistory(userId, '');
      return;
    }

    await AsyncStorage.setItem(storageKey, normalized);
    setE2eePassphrase(normalized);
    await loadHistory(userId, normalized);
  };

  const formatMessageTimestamp = (timestamp: number) =>
    new Date(timestamp).toLocaleString([], {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

  const orderedMessages = React.useMemo(
    () =>
      [...messages].sort((a, b) => {
        if (a.timestamp === b.timestamp) {
          return a.id - b.id;
        }
        return a.timestamp - b.timestamp;
      }),
    [messages],
  );

  let previousDayKey: string | null = null;
  const listItems: ChatListItem[] = orderedMessages.reduce<ChatListItem[]>((accumulator, message, index) => {
    const currentDayKey = getDayKey(message.timestamp);

    if (currentDayKey !== previousDayKey) {
      accumulator.push({
        type: 'separator',
        id: `separator-${currentDayKey}-${index}`,
        label: getDateSeparatorLabel(message.timestamp),
      });
      previousDayKey = currentDayKey;
    }

    accumulator.push({
      type: 'message',
      id: `message-${message.id}`,
      message,
    });

    return accumulator;
  }, []);

  const renderItem = ({ item }: { item: ChatListItem }) => {
    if (item.type === 'separator') {
      return (
        <View style={styles.separatorWrap}>
          <Text style={styles.separatorText}>{`---- ${item.label} ----`}</Text>
        </View>
      );
    }

    const completedTaskNumber = getCompletedTaskNumber(item.message.text);

    return (
      <View
        style={[
          styles.bubble,
          item.message.fromMe ? styles.bubbleRight : styles.bubbleLeft,
        ]}>
        {completedTaskNumber ? (
          <View style={styles.completedTaskWrap}>
            <Text
              style={[
                styles.bubbleText,
                item.message.fromMe ? styles.bubbleTextRight : styles.bubbleTextLeft,
              ]}>
              COMPLETED TASK
            </Text>
            <View style={styles.completedTaskNumberRow}>
              <Text
                style={[
                  styles.bubbleText,
                  item.message.fromMe ? styles.bubbleTextRight : styles.bubbleTextLeft,
                ]}>
                Task #:
              </Text>
              <View style={styles.completedTaskNumberCircle}>
                <Text style={styles.completedTaskNumberText}>{completedTaskNumber}</Text>
              </View>
            </View>
          </View>
        ) : (
          <Text
            style={[
              styles.bubbleText,
              item.message.fromMe ? styles.bubbleTextRight : styles.bubbleTextLeft,
            ]}>
            {item.message.text}
          </Text>
        )}
        <Text style={styles.timestamp}>{formatMessageTimestamp(item.message.timestamp)}</Text>
      </View>
    );
  };

  return (
    <LinearGradient colors={ASSIST4WEB_GRADIENT} style={styles.container}>
      <KeyboardAvoidingView
        style={styles.chatContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
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
          onPress={() => navigation.navigate('Main')}>
          Back to Main
        </Button>
      </View>
      <FlatList
        ref={flatListRef}
        data={listItems}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No messages yet. Say hello! 👋</Text>
        }
      />
      <View style={styles.e2eeRow}>
        <TextInput
          style={styles.e2eeInput}
          value={e2eeDraft}
          onChangeText={setE2eeDraft}
          placeholder="E2EE shared key (optional)"
          placeholderTextColor="#888"
          secureTextEntry
        />
        <TouchableOpacity style={styles.e2eeSaveBtn} onPress={saveE2EEKey}>
          <Text style={styles.sendText}>Save Key</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Type a message..."
          placeholderTextColor="#999"
          multiline
          returnKeyType="send"
          onSubmitEditing={sendMessage}
        />
        <TouchableOpacity style={styles.sendBtn} onPress={sendMessage}>
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  chatContainer: { flex: 1 },
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
  messageList: { padding: 12, paddingTop: 64, paddingBottom: 8, flexGrow: 1, justifyContent: 'flex-end' },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 40, fontSize: 15 },
  separatorWrap: { alignItems: 'center', marginVertical: 10 },
  separatorText: { color: '#6b7280', fontSize: 12, fontWeight: '700' },
  bubble: {
    maxWidth: '75%',
    borderRadius: 16,
    padding: 10,
    marginBottom: 8,
  },
  bubbleRight: {
    alignSelf: 'flex-end',
    backgroundColor: '#3b5998',
    borderBottomRightRadius: 4,
  },
  bubbleLeft: {
    alignSelf: 'flex-start',
    backgroundColor: '#fff',
    borderBottomLeftRadius: 4,
    elevation: 1,
  },
  bubbleText: { fontSize: 15 },
  bubbleTextRight: { color: '#fff' },
  bubbleTextLeft: { color: '#222' },
  completedTaskWrap: { gap: 6 },
  completedTaskNumberRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  completedTaskNumberCircle: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'yellowgreen',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  completedTaskNumberText: { color: '#ffffff', fontWeight: '900', fontSize: 9 },
  timestamp: { fontSize: 10, color: '#aaa', marginTop: 4, alignSelf: 'flex-end' },
  e2eeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f3f6fb',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  e2eeInput: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: '#222',
  },
  e2eeSaveBtn: {
    marginLeft: 8,
    backgroundColor: '#607d8b',
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: '#fff',
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  input: {
    flex: 1,
    backgroundColor: '#f0f2f5',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 15,
    maxHeight: 100,
    color: '#222',
  },
  sendBtn: {
    marginLeft: 8,
    backgroundColor: '#3b5998',
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  sendText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },
});

export default ChatScreen;
