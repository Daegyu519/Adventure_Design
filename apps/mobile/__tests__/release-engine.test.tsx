// 배포 빌드 흉내: 엔진 모듈을 불러오기 전에 __DEV__를 끈다(import는 끌어올려지므로 아래에서 require로 불러온다).
// URL이 빈 배포 빌드에서도 대화방은 그려지고 보내기가 되며(규칙 11), 힌트는 조용히 없다.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import type { TestNode } from 'test-renderer';

jest.mock('lucide-react-native/icons/arrow-left', () => () => null);
jest.mock('lucide-react-native/icons/info', () => () => null);
jest.mock('lucide-react-native/icons/send', () => () => null);
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
      room: { id: 'r1', kind: 'direct', title: null, relation: '친구', created_at: '', created_by: null },
      members: [
        { user_id: 'me', name: '나', last_read_at: null, muted: false },
        { user_id: 'u2', name: '민수', last_read_at: null, muted: false },
      ],
    }),
  markRead: () => Promise.resolve(),
}));
jest.mock('../lib/images', () => ({ pickAndSendImage: jest.fn(), useSignedUrl: () => ({ url: null, failed: false, retry: jest.fn() }) }));
const mockInserted: unknown[] = [];
function mockQuery(table: string) {
  let row: Record<string, unknown> | null = null;
  const q: Record<string, unknown> = {};
  for (const k of ['select', 'eq', 'gt', 'lt', 'in', 'order', 'limit']) q[k] = () => q;
  q.insert = (r: Record<string, unknown>) => ((row = r), mockInserted.push({ table, ...r }), q);
  q.single = () => Promise.resolve(row ? { data: { id: 9, image_path: null, reply_to: null, mentions: [], created_at: '2026-10-31 01:00:00.000000+00', ...row }, error: null, status: 201 } : { data: null, error: { message: 'x' } });
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: table === 'messages' ? [{ id: 1, room_id: 'r1', sender_id: 'u2', text: '안녕', image_path: null, reply_to: null, mentions: [], created_at: '2026-10-31 00:00:00.000000+00' }] : [], error: null, status: 200 }).then(res, rej);
  return q;
}
jest.mock('../lib/supabase', () => ({ supabase: { ...jest.requireActual('../test-utils/realtime').realtime, from: (t: string) => mockQuery(t), auth: { getSession: async () => ({ data: { session: { access_token: 't', user: { id: 'me' } } } }) } } }));

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));

test('배포 빌드 + 빈 엔진 URL: mock도 던짐도 없이 대화방이 그려지고 보내기가 된다, 힌트는 조용히 없다', async () => {
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { act } = require('react') as typeof import('react');
  const { createRoot } = require('test-renderer') as typeof import('test-renderer');
  const { engine } = require('../lib/engine') as typeof import('../lib/engine');
  const Room = (require('../app/room/[id]/index') as typeof import('../app/room/[id]/index')).default;
  expect(engine.isMock).toBe(false);
  expect(err).toHaveBeenCalledWith(expect.stringContaining('EXPO_PUBLIC_ENGINE_URL'));
  const root = createRoot();
  await act(async () => root.render(<Room />));
  const texts = () => textOf(root.container as unknown as TestNode);
  expect(texts()).toContain('안녕');
  const input = () => root.container.queryAll((n) => String(n.props.accessibilityLabel).startsWith('메시지 입력') && typeof n.props.onChangeText === 'function')[0];
  await act(async () => input().props.onChangeText('안 돼요.'));
  await act(async () => new Promise((r) => setTimeout(r, 700))); // 힌트 요청(0.5초 뒤)이 엔진 꺼짐으로 끝날 때까지
  expect(texts()).not.toContain('살펴보기'); // 힌트 막대 없음
  await act(async () => root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === '보내기')[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  expect(mockInserted).toContainEqual(expect.objectContaining({ table: 'messages', text: '안 돼요.', room_id: 'r1', sender_id: 'me' }));
  expect(texts()).not.toContain('보내지 못했어요');
  await act(async () => root.unmount());
  err.mockRestore();
});
