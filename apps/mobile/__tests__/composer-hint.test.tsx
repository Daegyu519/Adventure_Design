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

import { Composer } from '../components/Composer';

jest.mock('lucide-react-native/icons/send', () => () => null);
jest.mock('lucide-react-native/icons/arrow-up', () => () => null);
jest.mock('lucide-react-native/icons/plus', () => () => null);
jest.mock('lucide-react-native/icons/image', () => () => null);
jest.mock('lucide-react-native/icons/paperclip', () => () => null);
jest.mock('lucide-react-native/icons/file-text', () => () => null);
jest.mock('lucide-react-native/icons/chevron-left', () => () => null);
jest.mock('lucide-react-native/icons/x', () => () => null);
jest.mock('lucide-react-native/icons/image-plus', () => () => null);
jest.mock('../lib/motion', () => ({ MOTION_MS: 200, useReducedMotion: () => true }));

const A = { title: '차갑게 느껴질 수도 있어요', detail: '' };
const B = { title: '조금 딱딱해요', detail: '' };

test('hint is announced once per title, not per re-render; dismiss keeps focus on the input', async () => {
  const say = jest.fn();
  const onDismissHint = jest.fn();
  const focus = jest.fn();
  const ref = { current: null as null | { focus(): void } };
  const root = createRoot();
  const render = (hint: typeof A | null, value = 'a') =>
    act(async () => void root.render(<Composer value={value} onChangeText={() => {}} onSend={() => {}} replyTo={null} onCancelReply={() => {}} say={say} hint={hint} onDismissHint={onDismissHint} inputRef={ref as never} />));
  await render(A);
  ref.current!.focus = focus;
  await render(A, 'ab');
  await render(A, 'abc');
  expect(say.mock.calls.filter(([t]) => t.includes('힌트'))).toEqual([[`힌트: ${A.title}`]]);
  await render(B);
  expect(say).toHaveBeenLastCalledWith(`힌트: ${B.title}`);
  const close = root.container.queryAll((n) => n.props.accessibilityLabel === '힌트 닫기' && n.props.accessibilityRole === 'button')[0];
  await act(async () => close.props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(onDismissHint).toHaveBeenCalled();
  expect(focus).toHaveBeenCalled();
  await render(null);
  expect(root.container.queryAll((n) => n.props.accessibilityLabel === '힌트 닫기')).toHaveLength(0);
});

const byLabel = (root: ReturnType<typeof createRoot>, l: string) => root.container.queryAll((n) => n.props.accessibilityLabel === l && n.props.accessibilityRole === 'button');
const input = (root: ReturnType<typeof createRoot>) => root.container.queryAll((n) => typeof n.props.onChangeText === 'function' && 'placeholder' in n.props)[0];
const click = (n: { props: Record<string, (e: unknown) => void> }) => act(async () => n.props.onClick({ stopPropagation() {}, nativeEvent: {} }));
const base = { value: 'a', onChangeText: () => {}, onSend: () => {}, replyTo: null, onCancelReply: () => {} };

test('input points at the hint (aria-describedby on web, accessibilityHint on native) only while shown', async () => {
  const root = createRoot();
  await act(async () => void root.render(<Composer {...base} hint={A} />));
  expect(input(root).props.accessibilityHint).toBe(A.title);
  expect(root.container.queryAll((n) => n.props.nativeID === 'tone-hint')).not.toHaveLength(0);
  await act(async () => void root.render(<Composer {...base} hint={null} />));
  expect(input(root).props.accessibilityHint).toBeUndefined();
});

test('no hint announcement while the mention picker is open; announced once after it closes', async () => {
  const say = jest.fn();
  const root = createRoot();
  const members = [{ user_id: 'u2', name: '민수' }];
  await act(async () => void root.render(<Composer {...base} say={say} hint={A} mentionCandidates={members} onSelectMention={() => {}} />));
  expect(say.mock.calls.map(([t]) => t).filter((t) => t.startsWith('힌트'))).toEqual([]);
  expect(say.mock.calls.some(([t]) => t.startsWith('멘션 후보'))).toBe(true);
  await act(async () => void root.render(<Composer {...base} say={say} hint={A} mentionCandidates={null} />));
  await act(async () => void root.render(<Composer {...base} say={say} hint={A} mentionCandidates={members} onSelectMention={() => {}} />));
  await act(async () => void root.render(<Composer {...base} say={say} hint={A} mentionCandidates={null} />));
  expect(say.mock.calls.filter(([t]) => t.startsWith('힌트'))).toEqual([[`힌트: ${A.title}`]]);
});

test('hint bar renders above the mention picker', async () => {
  const root = createRoot();
  await act(async () => void root.render(<Composer {...base} hint={A} mentionCandidates={[{ user_id: 'u2', name: '민수' }]} onSelectMention={() => {}} />));
  const all = root.container.queryAll(() => true);
  const hintIdx = all.findIndex((n) => n.props.nativeID === 'tone-hint');
  const txt = (n: unknown): string => (typeof n === 'string' ? n : (n as { children: unknown[] }).children.map(txt).join(''));
  const pickIdx = all.findIndex((n) => n.props.accessibilityRole === 'button' && txt(n).includes('민수'));
  expect(hintIdx).toBeGreaterThan(-1);
  expect(pickIdx).toBeGreaterThan(hintIdx);
});

test('focus that was in the hint bar returns to the input when the hint goes away', async () => {
  const focus = jest.fn();
  const ref = { current: null as null | { focus(): void } };
  const root = createRoot();
  const r = (hint: typeof A | null) => act(async () => void root.render(<Composer {...base} hint={hint} inputRef={ref as never} />));
  await r(A);
  ref.current!.focus = focus;
  await act(async () => byLabel(root, '힌트 닫기')[0].props.onFocus());
  await r(null);
  expect(focus).toHaveBeenCalledTimes(1);
  await r(A);
  await r(null); // 포커스가 막대 밖이면 건드리지 않는다
  expect(focus).toHaveBeenCalledTimes(1);
});

test('살펴보기 is a 44pt-wide named button', async () => {
  const root = createRoot();
  await act(async () => void root.render(<Composer {...base} hint={A} onOpenHintDetail={() => {}} />));
  const b = byLabel(root, '살펴보기')[0];
  expect(b.props.style.minWidth).toBe(44);
  void click;
});
