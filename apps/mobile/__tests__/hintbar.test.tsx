import { act } from 'react';
import { createRoot as create } from 'test-renderer';

const roots: ReturnType<typeof create>[] = [];
const createRoot = () => {
  const r = create();
  roots.push(r);
  return r;
};
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((r) => r.unmount()));
});

type TestNode = Parameters<Parameters<ReturnType<typeof createRoot>['container']['queryAll']>[0]>[0] | string;
const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf as never).join(''));
const btn = (r: ReturnType<typeof createRoot>, l: string) => r.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === l);

import { HintBar } from '../components/HintBar';

jest.mock('lucide-react-native/icons/x', () => () => null);
jest.mock('../lib/motion', () => ({ MOTION_MS: 200, useReducedMotion: () => true }));

const H = { title: '차갑게 느껴질 수도 있어요', detail: 'd' };
const mount = async (el: React.ReactElement) => {
  const root = createRoot();
  await act(async () => void root.render(el));
  return root;
};

test('renders nothing without a hint', async () => {
  const root = await mount(<HintBar hint={null} onDismiss={() => {}} />);
  expect(textOf(root.container)).toBe('');
});
test('shows title, a named close button, and no detail button unless onOpenDetail', async () => {
  const onDismiss = jest.fn();
  const root = await mount(<HintBar hint={H} onDismiss={onDismiss} />);
  expect(textOf(root.container)).toContain(H.title);
  expect(btn(root, '힌트 닫기')).toHaveLength(1);
  expect(btn(root, '살펴보기')).toHaveLength(0);
  await act(async () => btn(root, '힌트 닫기')[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(onDismiss).toHaveBeenCalled();
});
test('onOpenDetail adds a named button', async () => {
  const root = await mount(<HintBar hint={H} onDismiss={() => {}} onOpenDetail={() => {}} />);
  expect(btn(root, '살펴보기')).toHaveLength(1);
});
