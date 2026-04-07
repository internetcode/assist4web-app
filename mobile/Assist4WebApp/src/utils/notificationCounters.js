import AsyncStorage from '@react-native-async-storage/async-storage';

const UNREAD_MESSAGES_KEY = 'unreadMessagesCount';
const NEW_POSTS_KEY = 'newPostsCount';
const PROCESSED_IDS_KEY = 'processedNotificationIds';
const MAX_PROCESSED_IDS = 100;

const toNumber = value => Number(value || '0');

const getProcessedIds = async () => {
  try {
    const raw = await AsyncStorage.getItem(PROCESSED_IDS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
};

const normalizeMessageId = remoteMessage => {
  const directId =
    typeof remoteMessage?.messageId === 'string' ? remoteMessage.messageId : '';
  if (directId) {
    return directId;
  }

  const type = String(remoteMessage?.data?.type || 'unknown');
  const postId = String(remoteMessage?.data?.postId || '');
  const sentTime = String(remoteMessage?.sentTime || '');
  return `${type}:${postId}:${sentTime}`;
};

const markProcessed = async messageId => {
  if (!messageId) {
    return;
  }

  const existing = await getProcessedIds();
  if (existing.includes(messageId)) {
    return;
  }

  const updated = [...existing, messageId].slice(-MAX_PROCESSED_IDS);
  await AsyncStorage.setItem(PROCESSED_IDS_KEY, JSON.stringify(updated));
};

export const getNotificationCounters = async () => {
  const unreadMessagesCount = toNumber(
    await AsyncStorage.getItem(UNREAD_MESSAGES_KEY),
  );
  const newPostsCount = toNumber(await AsyncStorage.getItem(NEW_POSTS_KEY));

  return { unreadMessagesCount, newPostsCount };
};

export const applyNotificationCounters = async (
  remoteMessage,
  options = {},
) => {
  const { chatOpen = false } = options;
  const messageType = String(remoteMessage?.data?.type || '');

  const counters = await getNotificationCounters();

  if (!messageType) {
    return {
      messageType,
      unreadMessagesCount: counters.unreadMessagesCount,
      newPostsCount: counters.newPostsCount,
      unreadCountChanged: false,
      newPostsCountChanged: false,
    };
  }

  if (messageType === 'chat_message' && chatOpen) {
    return {
      messageType,
      unreadMessagesCount: counters.unreadMessagesCount,
      newPostsCount: counters.newPostsCount,
      unreadCountChanged: false,
      newPostsCountChanged: false,
    };
  }

  const messageId = normalizeMessageId(remoteMessage);
  const processedIds = await getProcessedIds();
  if (messageId && processedIds.includes(messageId)) {
    return {
      messageType,
      unreadMessagesCount: counters.unreadMessagesCount,
      newPostsCount: counters.newPostsCount,
      unreadCountChanged: false,
      newPostsCountChanged: false,
    };
  }

  let unreadMessagesCount = counters.unreadMessagesCount;
  let newPostsCount = counters.newPostsCount;
  let unreadCountChanged = false;
  let newPostsCountChanged = false;

  if (messageType === 'chat_message') {
    unreadMessagesCount += 1;
    unreadCountChanged = true;
    await AsyncStorage.setItem(
      UNREAD_MESSAGES_KEY,
      String(unreadMessagesCount),
    );
  }

  if (messageType === 'new_post') {
    newPostsCount += 1;
    newPostsCountChanged = true;
    await AsyncStorage.setItem(NEW_POSTS_KEY, String(newPostsCount));
  }

  await markProcessed(messageId);

  return {
    messageType,
    unreadMessagesCount,
    newPostsCount,
    unreadCountChanged,
    newPostsCountChanged,
  };
};
