/**
 * @format
 */

import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';
import {
  getMessaging,
  setBackgroundMessageHandler,
} from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import App from './App';
import { applyNotificationCounters } from './src/utils/notificationCounters';
import { name as appName } from './app.json';

setBackgroundMessageHandler(getMessaging(), async remoteMessage => {
  await applyNotificationCounters(remoteMessage, { chatOpen: false });
  console.log(
    'Background message received:',
    remoteMessage?.messageId || 'unknown',
  );
});

notifee.onBackgroundEvent(async ({ type, detail }) => {
  if (type === EventType.PRESS || type === EventType.ACTION_PRESS) {
    console.log(
      'Notifee background interaction:',
      detail?.notification?.id || 'unknown',
    );
  }
});

AppRegistry.registerComponent(appName, () => App);
