import { act } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { createRoot, type TestNode } from 'test-renderer';

import { FocusBox } from '../components/mirror/parts';
import { TextField } from '../components/TextField';

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
// useAnnounce의 화면 밖 영역(opacity 0)만. TextField 오류 글자 자신의 live 속성은 제외한다.
const isRegion = (n: { props: Record<string, any> }) => n.props.accessibilityLiveRegion === 'polite' && n.props.style?.opacity === 0;
const region = (root: ReturnType<typeof createRoot>) => root.container.queryAll((n) => isRegion(n as never)).map((n) => textOf(n as unknown as TestNode)).join('|');

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('TextField 오류 안내: 보이는 alert 글자가 웹·안드로이드의 안내, say는 iOS만(두 번 읽히지 않게)', () => {
  const render = (error: string | null) => <TextField label="코드" error={error} />;
  test.each(['android', 'web'] as const)('%s: 오류 글자는 alert이고 별도 region 글은 없다', async (os) => {
    jest.replaceProperty(Platform, 'OS', os);
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const root = createRoot();
    await act(async () => root.render(render(null)));
    await act(async () => root.render(render('없는 코드예요')));
    expect(region(root)).toBe('');
    expect(spy).not.toHaveBeenCalled();
    expect(root.container.queryAll((n) => n.props.accessibilityRole === 'alert' && textOf(n as unknown as TestNode) === '없는 코드예요')).toHaveLength(1);
  });
  test('ios: announceForAccessibility 한 번, 영역 없음', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const root = createRoot();
    await act(async () => root.render(render('없는 코드예요')));
    await act(async () => root.render(render('없는 코드예요')));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(root.container.queryAll((n) => isRegion(n as never))).toHaveLength(0);
  });
});

describe('FocusBox 라벨 안내는 네이티브에서 say로(웹은 포커스가 이름을 읽는다)', () => {
  test('android: 라벨이 영역에 들어간다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const root = createRoot();
    await act(async () => root.render(<FocusBox label="역할극 결과">x</FocusBox>));
    expect(region(root)).toContain('역할극 결과');
  });
  test('ios: announceForAccessibility로 한 번', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const root = createRoot();
    await act(async () => root.render(<FocusBox label="역할극 결과">x</FocusBox>));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('역할극 결과');
  });
  test('web: 포커스만(영역에 같은 글을 또 넣지 않는다)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const root = createRoot();
    await act(async () => root.render(<FocusBox label="역할극 결과">x</FocusBox>));
    expect(region(root)).not.toContain('역할극 결과');
  });
});
