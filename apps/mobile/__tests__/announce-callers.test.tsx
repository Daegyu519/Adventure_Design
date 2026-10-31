import { act } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { createRoot, type TestNode } from 'test-renderer';

import { FocusBox } from '../components/mirror/parts';
import { Sheet } from '../components/Sheet';
import { TextField } from '../components/TextField';
import { useAnnounce } from '../lib/announce';

jest.mock('../lib/motion', () => ({ MOTION_MS: 200, useReducedMotion: () => true }));

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
// useAnnounce의 화면 밖 영역(opacity 0.01: TalkBack이 0을 건너뛸 수 있어서)만. TextField 오류 글자 자신의 live 속성은 제외한다.
const isRegion = (n: { props: Record<string, any> }) => n.props.accessibilityLiveRegion === 'polite' && n.props.style?.opacity === 0.01;
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

// 화면의 영역 하나 + 그 say를 받는 FocusBox(FocusBox는 영역을 그리지 않는다)
function Box({ label }: { label: string }) {
  const { say, region } = useAnnounce();
  return (
    <>
      {region}
      <FocusBox label={label} say={say}>
        x
      </FocusBox>
    </>
  );
}
describe('FocusBox 라벨 안내는 네이티브에서 화면의 say로(웹은 포커스가 이름을 읽는다)', () => {
  test('android: 라벨이 영역에 들어간다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const root = createRoot();
    await act(async () => root.render(<Box label="역할극 결과" />));
    expect(region(root)).toContain('역할극 결과');
  });
  test('ios: announceForAccessibility로 한 번', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const root = createRoot();
    await act(async () => root.render(<Box label="역할극 결과" />));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('역할극 결과');
  });
  test('web: 포커스만(영역에 같은 글을 또 넣지 않는다)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const root = createRoot();
    await act(async () => root.render(<Box label="역할극 결과" />));
    expect(region(root)).not.toContain('역할극 결과');
  });
});

// 웹 Modal(aria-modal)이 열리면 화면 쪽 live 영역은 화면 읽기 프로그램에서 가려진다. 시트 안 안내는 dialog 안의 시트 영역으로(AI-2).
describe('Sheet: 열린 시트마다 자기 안내 영역이 dialog 안에 있다', () => {
  let say: (t: string) => void = () => {};
  const render = () => (
    <Sheet visible onClose={() => {}} title="살펴보기">
      {(s) => {
        say = s;
        return null;
      }}
    </Sheet>
  );
  test.each(['android', 'web'] as const)('%s: say는 dialog 안의 영역에 들어간다', async (os) => {
    jest.replaceProperty(Platform, 'OS', os);
    const root = createRoot();
    await act(async () => root.render(render()));
    await act(async () => say('살펴보는 중'));
    const dialog = root.container.queryAll((n) => n.props.role === 'dialog')[0];
    expect(dialog.queryAll((n) => isRegion(n as never)).map((n) => textOf(n as unknown as TestNode))).toEqual(['살펴보는 중']);
  });
  test('ios: announceForAccessibility, 영역 없음', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const root = createRoot();
    await act(async () => root.render(render()));
    await act(async () => say('살펴보는 중'));
    expect(spy).toHaveBeenCalledWith('살펴보는 중');
    expect(root.container.queryAll((n) => isRegion(n as never))).toHaveLength(0);
  });
});
