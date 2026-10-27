import { iosWebInstallState } from '../iosWeb';

// 실제 UA 문자열
const IPHONE_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPHONE_16_3 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1';
const IPHONE_16_4 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_17 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAC_SAFARI = IPAD_DESKTOP_17;
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

test('iPhone iOS 17 Safari, not standalone → needs-install', () =>
  expect(iosWebInstallState(IPHONE_17, 5, false)).toBe('needs-install'));
test('iPhone iOS 16.3 → too-old', () => expect(iosWebInstallState(IPHONE_16_3, 5, false)).toBe('too-old'));
test('iPhone iOS 16.4 standalone → installed', () => expect(iosWebInstallState(IPHONE_16_4, 5, true)).toBe('installed'));
test('iPadOS desktop UA (Macintosh + touch points 5, Version/17.0) → needs-install', () =>
  expect(iosWebInstallState(IPAD_DESKTOP_17, 5, false)).toBe('needs-install'));
test('Mac Safari (touch points 0) → not-ios', () => expect(iosWebInstallState(MAC_SAFARI, 0, false)).toBe('not-ios'));
test('Android Chrome → not-ios', () => expect(iosWebInstallState(ANDROID_CHROME, 5, false)).toBe('not-ios'));
