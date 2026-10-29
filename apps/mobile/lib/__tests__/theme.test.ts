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
