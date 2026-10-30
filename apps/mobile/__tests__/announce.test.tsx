import { act } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { createRoot, type TestNode } from 'test-renderer';

import { useAnnounce } from '../lib/announce';

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
let say: (t: string) => void = () => {};
function Probe() {
  const a = useAnnounce();
  say = a.say;
  return a.region;
}
const orig = Platform.OS;
afterEach(() => {
  Platform.OS = orig;
  jest.restoreAllMocks();
});

async function mount(os: 'ios' | 'web' | 'android') {
  Platform.OS = os;
  const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  spy.mockClear();
  const root = createRoot();
  await act(async () => root.render(<Probe />));
  const live = () => root.container.queryAll((n) => n.props['aria-live'] === 'polite');
  return { spy, live, root };
}

test('iOS: announceForAccessibility 한 번, 영역은 그리지 않는다', async () => {
  const { spy, live } = await mount('ios');
  await act(async () => say('안녕'));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith('안녕');
  expect(live()).toHaveLength(0);
});

test.each(['web', 'android'] as const)('%s: 처음부터 있는 polite 영역의 글이 바뀌고 announce는 부르지 않는다', async (os) => {
  const { spy, live } = await mount(os);
  expect(live()).toHaveLength(1);
  await act(async () => say('안녕'));
  expect(textOf(live()[0] as unknown as TestNode)).toContain('안녕');
  expect(spy).not.toHaveBeenCalled();
});

test('같은 말을 또 하면 글이 달라진다(다시 읽힘)', async () => {
  const { live } = await mount('web');
  await act(async () => say('안녕'));
  const a = textOf(live()[0] as unknown as TestNode);
  await act(async () => say('안녕'));
  const b = textOf(live()[0] as unknown as TestNode);
  expect(b).not.toBe(a);
  await act(async () => say('안녕'));
  expect(textOf(live()[0] as unknown as TestNode)).toBe(a);
});
