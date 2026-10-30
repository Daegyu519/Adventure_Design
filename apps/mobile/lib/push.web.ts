import { currentIosWebState } from './iosWeb';
import { forgetToken, releaseToken, saveToken, storedToken, type PushResult } from './pushToken';
import { urlBase64ToUint8Array } from './vapid';

export type { PushResult };

const hasPushApi = () =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in globalThis && typeof Notification !== 'undefined';

// 서비스 워커가 준비되지 않으면 영원히 기다리지 않는다.
const READY_MS = 10_000;
function swReady(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('sw timeout')), READY_MS))),
  ]).finally(() => clearTimeout(timer)); // 준비되면 경주 타이머를 남기지 않는다
}

// 스위치는 브라우저 상태를 따른다: 기억한 토큰 + 허용됨 + 살아 있는 구독이 모두 있어야 켜짐.
export async function pushEnabled(): Promise<boolean> {
  if (!(await storedToken()) || !hasPushApi() || Notification.permission !== 'granted') return false;
  try {
    return (await (await swReady()).pushManager.getSubscription()) !== null;
  } catch {
    return false;
  }
}

export const pushDenied = async (): Promise<boolean> => hasPushApi() && Notification.permission === 'denied';

// 권한 요청은 반드시 사용자가 누른 안에서 불러야 한다(브라우저·iOS가 막는다). 앱 시작 때는 부르지 않는다.
export async function enablePush(userId: string): Promise<PushResult> {
  const key = process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key || !hasPushApi()) {
    if (__DEV__ && !key) console.warn('[push] EXPO_PUBLIC_VAPID_PUBLIC_KEY가 비어 있어 웹 푸시를 켜지 않습니다.');
    return currentIosWebState() === 'needs-install' ? 'needs-install' : 'unsupported';
  }
  try {
    if ((await Notification.requestPermission()) !== 'granted') return 'denied';
    await navigator.serviceWorker.register('/sw.js');
    const reg = await swReady();
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource }));
    await saveToken(userId, JSON.stringify(sub.toJSON()), 'web');
    return 'enabled';
  } catch {
    return 'error';
  }
}

// 행 삭제가 실패해도 구독은 끊는다(엔진이 죽은 구독을 410으로 알고 지운다). 실패는 호출한 쪽이 알 수 있게 던진다.
export async function disablePush(userId: string): Promise<void> {
  try {
    await releaseToken(userId);
  } finally {
    try {
      const reg = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? await swReady() : null;
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    } catch {
      // 구독을 못 끊어도 계속한다.
    }
    await forgetToken();
  }
}

export function usePushTaps(): void {} // 웹은 서비스 워커가 처리한다
