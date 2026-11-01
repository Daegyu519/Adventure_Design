import { act } from 'react';
import { Platform } from 'react-native';
import { createRoot, type TestNode } from 'test-renderer';

import Room from '../app/room/[id]/index';
import { rt } from '../test-utils/realtime';

// 대화방 화면 + 진짜 훅(useRoomMessages·useReactions·useMembers·useTyping) + realtime-js처럼 움직이는 공용 채널 가짜.
jest.mock('lucide-react-native/icons/arrow-left', () => () => null);
jest.mock('lucide-react-native/icons/info', () => () => null);
jest.mock('lucide-react-native/icons/send', () => () => null);
jest.mock('lucide-react-native/icons/arrow-up', () => () => null);
jest.mock('lucide-react-native/icons/plus', () => () => null);
jest.mock('lucide-react-native/icons/chevron-left', () => () => null);
jest.mock('lucide-react-native/icons/ellipsis', () => () => null);
jest.mock('lucide-react-native/icons/x', () => () => null);
jest.mock('lucide-react-native/icons/check', () => () => null);
jest.mock('lucide-react-native/icons/image-plus', () => () => null);
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }), useLocalSearchParams: () => ({ id: 'r1' }), useIsFocused: () => true }));
jest.mock('../lib/session', () => ({ useSession: () => ({ userId: 'me' }) }));
jest.mock('../lib/rooms', () => ({
  ...jest.requireActual('../lib/rooms'),
  fetchRoom: () =>
    Promise.resolve({
      room: { id: 'r1', kind: 'group', title: '팀플', relation: '팀원', created_at: '', created_by: null },
      members: [
        { user_id: 'me', name: '나', last_read_at: null, muted: false },
        { user_id: 'u2', name: '민수', last_read_at: null, muted: false },
      ],
    }),
  markRead: () => Promise.resolve(),
}));
jest.mock('../lib/useToneHint', () => ({ useToneHint: () => ({ hint: null, input: jest.fn(), dismiss: jest.fn(), sent: jest.fn() }) }));
jest.mock('../lib/images', () => ({ pickAndSendImage: jest.fn(), useSignedUrl: () => ({ url: null, failed: false, retry: jest.fn() }) }));
jest.mock('../lib/toneEvents', () => ({ logToneEvent: jest.fn() }));
const mockRows: Record<string, unknown[]> = {};
function mockQuery(table: string) {
  const q: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'gt', 'lt', 'in', 'order', 'limit']) q[k] = () => q;
  q.single = () => Promise.resolve({ data: null, error: { message: 'x' } });
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: mockRows[table] ?? [], error: null, status: 200 }).then(res, rej);
  return q;
}
jest.mock('../lib/supabase', () => ({ supabase: { ...jest.requireActual('../test-utils/realtime').realtime, from: (t: string) => mockQuery(t) } }));

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const msg = (id: number, sender: string) => ({ id, room_id: 'r1', sender_id: sender, text: `m${id}`, image_path: null, reply_to: null, mentions: [], created_at: '2026-10-27 01:32:17.123456+00' });

let mounted: ReturnType<typeof createRoot>[] = [];
async function setup() {
  const root = createRoot();
  mounted.push(root);
  await act(async () => root.render(<Room />));
  for (const n of ['room:r1', 'reactions:r1', 'members:r1', 'typing:r1']) await act(async () => rt.status(n, 'SUBSCRIBED'));
  const press = (label: string) =>
    act(async () => root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label)[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  return { root, press, texts: () => textOf(root.container as unknown as TestNode) };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'android');
  rt.reset();
  mockRows.messages = [msg(1, 'u2'), msg(2, 'me')];
  mockRows.reactions = [];
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  for (const r of mounted) await act(async () => r.unmount()); // 목록(VirtualizedList)의 지연 갱신 타이머가 테스트 뒤에 남지 않게
  mounted = [];
  warn.mockRestore();
});

test('채널 넷(메시지·공감·멤버·입력 중)을 하나씩 열고, 화면을 닫으면 모두 닫는다', async () => {
  const { root, texts } = await setup();
  expect(texts()).toContain('m1');
  for (const n of ['room:r1', 'reactions:r1', 'members:r1', 'typing:r1']) expect(rt.find(n)).toHaveLength(1);
  await act(async () => root.unmount());
  mounted = [];
  expect(rt.open).toHaveLength(0);
  expect(warn).not.toHaveBeenCalled(); // 내가 닫아서 오는 CLOSED는 오류가 아니다
});

test.each(['room:r1', 'reactions:r1', 'members:r1'])('%s 채널이 끊기면 다시 불러오기 줄, 누르면 끊긴 채널을 새로 열고 다시 연결되면 줄이 사라진다', async (name) => {
  const { press, texts } = await setup();
  const old = rt.one(name);
  await act(async () => rt.status(name, 'CHANNEL_ERROR'));
  expect(texts()).toContain('연결이 불안정할 수도 있어요');
  await press('다시 불러오기');
  expect(rt.removed).toContain(old);
  await act(async () => rt.status(name, 'SUBSCRIBED'));
  expect(rt.one(name)).not.toBe(old);
  expect(texts()).not.toContain('연결이 불안정할 수도 있어요');
  expect(texts()).toContain('m2');
});
