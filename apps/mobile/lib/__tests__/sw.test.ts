import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// public/sw.js를 가짜 서비스 워커 전역에서 실행해 핸들러를 직접 부른다.
function load() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: Array<[string, Record<string, unknown>]> = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const win = { focus: async () => {}, navigate: async (u: string) => void navigated.push(u) };
  let wins: unknown[] = [];
  const self = {
    addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = h),
    registration: { showNotification: async (t: string, o: Record<string, unknown>) => void shown.push([t, o]) },
    location: { origin: 'https://app.example' },
    clients: { matchAll: async () => wins, openWindow: async (u: string) => void opened.push(u) },
  };
  vm.runInNewContext(readFileSync(join(__dirname, '../../public/sw.js'), 'utf8'), { self, URL, console });
  const click = async (url: unknown) => {
    let p: Promise<unknown> = Promise.resolve();
    handlers.notificationclick({ notification: { close() {}, data: { url } }, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  return { handlers, shown, opened, navigated, win, click, setWins: (w: unknown[]) => (wins = w) };
}

test('click: same-origin room path opens in a new window when none is open', async () => {
  const sw = load();
  await sw.click('/room/abc-1');
  expect(sw.opened).toEqual(['/room/abc-1']);
});

test.each(['/\\evil.com', '//evil.com', 'https://evil.com/x', '/\\/evil.com', 'javascript:alert(1)', 5, undefined])('click: %p falls back to /', async (bad) => {
  const sw = load();
  await sw.click(bad);
  expect(sw.opened).toEqual(['/']);
});

test('click: an open window is focused and navigated', async () => {
  const sw = load();
  sw.setWins([sw.win]);
  await sw.click('/room/abc-1');
  expect(sw.navigated).toEqual(['/room/abc-1']);
  expect(sw.opened).toEqual([]);
});

test('push: shows a Korean-language notification with a default title', async () => {
  const sw = load();
  let p: Promise<unknown> = Promise.resolve();
  sw.handlers.push({ data: { json: () => ({ body: 'hi', url: '/room/x' }) }, waitUntil: (x: Promise<unknown>) => (p = x) });
  await p;
  expect(sw.shown[0][0]).toBe('새 메시지');
  expect(sw.shown[0][1]).toMatchObject({ body: 'hi', lang: 'ko', data: { url: '/room/x' } });
});
