import { router, type Href } from 'expo-router';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { releaseToken, saveToken, storedToken, type PushResult } from './pushToken';

export type { PushResult };

// 앞에 떠 있을 때는 배너 없이 목록만(대화방 안에서 같은 말이 두 번 보이지 않게).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export const pushEnabled = async (): Promise<boolean> => (await storedToken()) !== null;

// 아이폰은 웹 푸시로 쓰므로 네이티브 iOS는 지원하지 않는다. projectId·FCM이 아직 없으면 조용히 'unsupported'(개발 중에만 경고).
export async function enablePush(userId: string): Promise<PushResult> {
  if (Platform.OS !== 'android' || !Device.isDevice) return 'unsupported';
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId) {
    if (__DEV__) console.warn('[push] EAS projectId가 없어 푸시를 등록하지 않습니다(eas init 필요).');
    return 'unsupported';
  }
  let token: string;
  try {
    await Notifications.setNotificationChannelAsync('messages', { name: '새 메시지', importance: Notifications.AndroidImportance.HIGH });
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return 'denied';
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    if (__DEV__) console.warn('[push] Expo 푸시 토큰을 받지 못했습니다(google-services.json·FCM 설정 확인).');
    return 'unsupported';
  }
  try {
    await saveToken(userId, token, 'android');
    return 'enabled';
  } catch {
    return 'error';
  }
}

export const disablePush = (userId: string): Promise<void> => releaseToken(userId);

// 알림 data.url은 서버가 넣지만 앱 안 대화방 경로만 따라간다(다른 경로·바깥 주소는 무시).
export function tapUrl(data: unknown): string | null {
  const url = (data as { url?: unknown } | null)?.url;
  return typeof url === 'string' && /^\/room\/[A-Za-z0-9-]+$/.test(url) ? url : null;
}

// 알림을 누르면 그 대화방으로. 앱이 꺼져 있다가 열린 경우도 마지막 응답으로 처리한다.
export function usePushTaps(): void {
  const last = Notifications.useLastNotificationResponse();
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!last) return;
    const id = last.notification.request.identifier;
    if (done.current === id) return;
    done.current = id;
    const url = tapUrl(last.notification.request.content.data);
    if (url) router.push(url as Href);
  }, [last]);
}
