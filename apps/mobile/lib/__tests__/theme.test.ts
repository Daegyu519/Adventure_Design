import { FONT_STACK_WEB, resolveScheme } from '../theme';

test('system follows OS', () => expect(resolveScheme('system', 'dark')).toBe('dark'));
test('system with unknown OS → light', () => {
  expect(resolveScheme('system', null)).toBe('light');
  expect(resolveScheme('system', undefined)).toBe('light');
});
test('explicit pref wins', () => {
  expect(resolveScheme('light', 'dark')).toBe('light');
  expect(resolveScheme('dark', 'light')).toBe('dark');
});

// MASTER 3장 대체 글꼴. 웹에서 Pretendard를 못 불러와도 한글이 시스템 글꼴로 나온다.
test('web font stack starts with Pretendard and falls back to the MASTER §3 system fonts', () => {
  expect(FONT_STACK_WEB.split(',').map((s) => s.trim())).toEqual(['Pretendard', '-apple-system', '"Apple SD Gothic Neo"', '"Noto Sans KR"', 'sans-serif']);
});

// OOPS 글로우: 색은 토큰에서만(코드에 색 리터럴이 없다), 투명도는 #RRGGBBAA. 라이트는 번짐 대신 옅은 중립 그림자.
import { fxFor } from '../theme';
import tokens from '../tokens.json';

test('fxFor: 다크 글로우는 토큰 색 + 투명도 16진 두 자리, 라이트는 글자색 그림자', () => {
  const d = fxFor(tokens.dark, 'dark');
  expect(d.soft).toBe(`3px 5px 12px ${tokens.dark.glowSoft}73`);
  expect(d.bar('to bottom')).toBe(`linear-gradient(to bottom, ${tokens.dark.primary} 0%, ${tokens.dark.glowLight} 55%, ${tokens.dark.glowSoft} 100%)`);
  const l = fxFor(tokens.light, 'light');
  expect(l.soft).toContain(tokens.light.text);
  expect(l.glowText).toEqual({});
});
