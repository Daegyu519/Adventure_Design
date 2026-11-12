import { isNewer, signature } from '../webUpdate';

const HTML = (h: string) => `<html><script src="/_expo/static/js/web/__expo-metro-runtime-aaa.js"></script><script src="/_expo/static/js/web/__common-${h}.js" defer></script><script src="/_expo/static/js/web/entry-zzz.js"></script></html>`;

test('signature: 번들 주소만 모아 정렬한다(순서·중복 무관), 없으면 빈 문자열', () => {
  expect(signature(HTML('v1'))).toBe(signature(HTML('v1') + HTML('v1')));
  expect(signature(HTML('v1'))).toContain('__common-v1.js');
  expect(signature('<html>개발 서버</html>')).toBe('');
});

test('isNewer: 둘 다 있고 서로 다를 때만 새 버전(개발·오프라인 빈 값은 아님)', () => {
  expect(isNewer(signature(HTML('v1')), signature(HTML('v2')))).toBe(true);
  expect(isNewer(signature(HTML('v1')), signature(HTML('v1')))).toBe(false);
  expect(isNewer('', signature(HTML('v2')))).toBe(false);
  expect(isNewer(signature(HTML('v1')), '')).toBe(false);
});
