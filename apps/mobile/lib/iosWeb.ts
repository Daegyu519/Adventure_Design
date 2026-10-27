import { Platform } from 'react-native';

// iOS 웹 푸시는 iOS 16.4 이상에서 "홈 화면에 추가"로 연 앱에서만 온다.
export type IosWebState = 'not-ios' | 'too-old' | 'needs-install' | 'installed';

export function iosWebInstallState(ua: string, maxTouchPoints: number, standalone: boolean): IosWebState {
  // iPadOS는 데스크톱 Safari로 위장(Macintosh)하지만 터치 지점이 있다.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  if (!ios) return 'not-ios';
  const m = /OS (\d+)_(\d+)/.exec(ua) ?? /Version\/(\d+)\.(\d+)/.exec(ua);
  if (m) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major < 16 || (major === 16 && minor < 4)) return 'too-old';
  }
  return standalone ? 'installed' : 'needs-install';
}

export function currentIosWebState(): IosWebState {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return 'not-ios';
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
  return iosWebInstallState(navigator.userAgent, navigator.maxTouchPoints ?? 0, standalone);
}
