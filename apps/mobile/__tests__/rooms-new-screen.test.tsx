import { act } from 'react';
import { Share } from 'react-native';
import { createRoot, type TestInstance, type TestNode } from 'test-renderer';

import RoomsNew from '../app/rooms/new';

jest.mock('lucide-react-native/icons/arrow-left', () => () => null); // jest가 lucide의 ESM 파일을 읽지 못해서 가짜로 바꾼다
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));

const mockRouter = { replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: { tab?: string } = {};
jest.mock('expo-router', () => {
  const { View } = jest.requireActual('react-native');
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams,
    Redirect: ({ href }: { href: string }) => <View testID={`redirect:${href}`} />,
  };
});

let mockSession = { status: 'in', profileStatus: 'ok' };
jest.mock('../lib/session', () => ({ useSession: () => mockSession }));

const mockRpc = jest.fn();
let mockSupabase: unknown;
jest.mock('../lib/supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

const textOf = (n: TestNode): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const CODE = 'AB3X9K7Q';
const ROOM = '11111111-2222-3333-4444-555555555555';
const ok = (data: string) => Promise.resolve({ data, error: null, status: 200 });
const fail = (message: string, status = 400) => Promise.resolve({ data: null, error: { message }, status });

async function setup(tab?: string) {
  mockParams = tab ? { tab } : {};
  const root = createRoot();
  await act(async () => {
    root.render(<RoomsNew />);
  });
  const find = (pred: (n: TestInstance) => boolean) => root.container.queryAll(pred);
  const field = (label: string) => find((n) => n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function')[0];
  const type = (label: string, text: string) => act(async () => field(label).props.onChangeText(text));
  const buttons = () => find((n) => n.props.accessibilityRole === 'button').map((n) => n.props.accessibilityLabel as string);
  const press = (label: string, role: 'button' | 'radio' = 'button') =>
    act(async () => find((n) => n.props.accessibilityRole === role && n.props.accessibilityLabel === label)[0].props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  const texts = () => textOf(root.container as unknown as TestNode);
  const codeNode = () => find((n) => n.props.selectable === true)[0];
  const radioState = (label: string) => find((n) => n.props.accessibilityRole === 'radio' && n.props.accessibilityLabel === label)[0].props.accessibilityState.checked;
  return { root, find, field, type, buttons, press, texts, codeNode, radioState };
}

const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m as 'log').mockImplementation(() => {}));
let shareSpy: jest.SpyInstance;

beforeEach(() => {
  mockRpc.mockReset();
  mockSupabase = { rpc: mockRpc };
  mockSession = { status: 'in', profileStatus: 'ok' };
  mockParams = {};
  mockRouter.replace.mockReset();
  mockRouter.back.mockReset();
  mockRouter.canGoBack.mockReset().mockReturnValue(true);
  spies.forEach((s) => s.mockClear());
  shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
});
afterEach(() => {
  // 초대 코드·이름·메시지는 어떤 경우에도 로그로 나가지 않는다.
  spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  shareSpy.mockRestore();
});

// ── 탭 고르기 ─────────────────────────────────────────────

test('rooms/new: tab 주소 값대로 열고, 없거나 엉뚱하면 1:1 초대로 연다', async () => {
  expect((await setup()).texts()).toContain('코드 만들기');
  expect((await setup('nope')).texts()).toContain('코드 만들기');
  const group = await setup('group');
  expect(group.field('방 이름')).toBeDefined();
  const join = await setup('join');
  expect(join.field('초대 코드')).toBeDefined();
});

test('rooms/new: 세 갈래는 radio 묶음이고 고르면 화면이 바뀐다', async () => {
  const { press, radioState, field, texts } = await setup('direct');
  expect(radioState('1:1 초대')).toBe(true);
  await press('그룹 만들기', 'radio');
  expect(radioState('그룹 만들기')).toBe(true);
  expect(field('방 이름')).toBeDefined();
  await press('코드 입력', 'radio');
  expect(field('초대 코드')).toBeDefined();
  expect(texts()).not.toContain('72시간');
});

// ── 1:1 초대 ──────────────────────────────────────────────

test('direct: 관계 기본은 친구이고, 코드 만들기는 create_invite에 방 없이 관계만 보낸다', async () => {
  mockRpc.mockReturnValue(ok(CODE));
  const { press, radioState, texts, codeNode } = await setup('direct');
  expect(radioState('친구')).toBe(true);
  await press('코드 만들기');
  expect(mockRpc).toHaveBeenCalledTimes(1);
  expect(mockRpc).toHaveBeenCalledWith('create_invite', { relation: '친구' });
  expect(textOf(codeNode() as unknown as TestNode)).toBe(CODE);
  expect(codeNode().props.accessibilityLabel).toContain('A B 3 X 9 K 7 Q'); // 스크린리더가 한 글자씩 읽게
  expect(texts()).toContain('72시간 안에 한 번 쓸 수 있어요');
});

test('direct: 고른 관계가 전달된다', async () => {
  mockRpc.mockReturnValue(ok(CODE));
  const { press } = await setup('direct');
  await press('선후배', 'radio');
  await press('코드 만들기');
  expect(mockRpc).toHaveBeenCalledWith('create_invite', { relation: '선후배' });
});

test('direct: 보내기는 시스템 공유 창에 초대 코드를 넘긴다', async () => {
  mockRpc.mockReturnValue(ok(CODE));
  const { press } = await setup('direct');
  await press('코드 만들기');
  await press('보내기');
  expect(shareSpy).toHaveBeenCalledWith({ message: `초대 코드: ${CODE}` });
});

test('direct: 공유가 실패해도(웹 등) 조용히 넘어간다', async () => {
  mockRpc.mockReturnValue(ok(CODE));
  shareSpy.mockRejectedValue(new Error('share unavailable'));
  const { press, texts } = await setup('direct');
  await press('코드 만들기');
  await press('보내기');
  expect(texts()).toContain(CODE);
});

test('direct: 오류는 코드로 고른 한국어 문구만 보이고 서버 글은 보이지 않는다', async () => {
  mockRpc.mockReturnValue(fail('not_authenticated'));
  const a = await setup('direct');
  await a.press('코드 만들기');
  expect(a.texts()).toContain('로그인이 필요해요');

  mockRpc.mockReturnValue(fail('permission denied for function create_invite', 403));
  const b = await setup('direct');
  await b.press('코드 만들기');
  expect(b.texts()).toContain('코드를 만들지 못했어요');
  expect(b.texts()).not.toContain('permission denied');
});

test('direct: 서버에 닿지 못하면(상태 0, 5xx, 던짐) 연결 문구', async () => {
  for (const make of [() => fail('TypeError: Failed to fetch', 0), () => fail('boom', 503), () => Promise.reject(new Error('network'))]) {
    mockRpc.mockReturnValue(make());
    const s = await setup('direct');
    await s.press('코드 만들기');
    expect(s.texts()).toContain('연결이 불안정할 수도 있어요');
    expect(s.texts()).not.toContain('network');
  }
});

test('direct: 만드는 중에 다시 눌러도 요청은 한 번이다', async () => {
  let release!: (v: unknown) => void;
  mockRpc.mockReturnValue(new Promise((r) => (release = r)));
  const { press, buttons, texts } = await setup('direct');
  await press('코드 만들기');
  await press('코드 만들기');
  expect(mockRpc).toHaveBeenCalledTimes(1);
  await act(async () => release({ data: CODE, error: null, status: 200 }));
  expect(texts()).toContain(CODE);
  expect(buttons()).not.toContain('코드 만들기');
});

test('direct: 다른 코드 만들기는 처음 화면으로 돌아간다', async () => {
  mockRpc.mockReturnValue(ok(CODE));
  const { press, texts } = await setup('direct');
  await press('코드 만들기');
  await press('다른 코드 만들기');
  expect(texts()).not.toContain(CODE);
  expect(texts()).toContain('코드 만들기');
});

// ── 그룹 만들기 ───────────────────────────────────────────

test('group: 이름이 비었거나 31자면 요청하지 않고 안내한다', async () => {
  const { type, press, texts } = await setup('group');
  await type('방 이름', '   ');
  await press('방 만들기');
  expect(texts()).toContain('방 이름을 적어 주세요');
  await type('방 이름', '가'.repeat(31));
  await press('방 만들기');
  expect(texts()).toContain('30자까지 쓸 수 있어요');
  expect(mockRpc).not.toHaveBeenCalled();
});

test('group: 다듬은 이름과 관계로 create_group 다음 그 방의 create_invite', async () => {
  mockRpc.mockImplementation((fn: string) => (fn === 'create_group' ? ok(ROOM) : ok(CODE)));
  const { type, press, texts, codeNode } = await setup('group');
  await type('방 이름', '  팀플 3조 ');
  await press('팀원', 'radio');
  await press('방 만들기');
  expect(mockRpc.mock.calls).toEqual([
    ['create_group', { title: '팀플 3조', relation: '팀원' }],
    ['create_invite', { room: ROOM, relation: '팀원' }],
  ]);
  expect(textOf(codeNode() as unknown as TestNode)).toBe(CODE);
  expect(texts()).toContain('최대 8명까지 들어올 수 있어요');
});

test('group: 방으로 가기는 만든 방으로 보낸다', async () => {
  mockRpc.mockImplementation((fn: string) => (fn === 'create_group' ? ok(ROOM) : ok(CODE)));
  const { type, press } = await setup('group');
  await type('방 이름', '팀플');
  await press('방 만들기');
  await press('방으로 가기');
  expect(mockRouter.replace).toHaveBeenCalledWith(`/room/${ROOM}`);
});

test('group: 방은 만들어졌는데 코드가 실패하면 방을 또 만들지 않고 코드만 다시 만든다', async () => {
  let invites = 0;
  mockRpc.mockImplementation((fn: string) => (fn === 'create_group' ? ok(ROOM) : ++invites === 1 ? fail('not_group') : ok(CODE)));
  const { type, press, texts, buttons } = await setup('group');
  await type('방 이름', '팀플');
  await press('방 만들기');
  expect(texts()).toContain('그룹 방에서만 쓸 수 있어요');
  expect(buttons()).not.toContain('방 만들기');
  await press('코드 다시 만들기');
  expect(mockRpc.mock.calls.filter(([fn]) => fn === 'create_group')).toHaveLength(1);
  expect(mockRpc).toHaveBeenLastCalledWith('create_invite', { room: ROOM, relation: '친구' });
  expect(texts()).toContain(CODE);
});

test('group: 방 만들기가 실패하면 문구만 보이고 코드는 요청하지 않는다', async () => {
  mockRpc.mockReturnValue(fail('new row for relation "rooms" violates check constraint', 400));
  const { type, press, texts } = await setup('group');
  await type('방 이름', '팀플');
  await press('방 만들기');
  expect(mockRpc).toHaveBeenCalledTimes(1);
  expect(texts()).toContain('방을 만들지 못했어요');
  expect(texts()).not.toContain('violates');
});

// ── 코드 입력 ─────────────────────────────────────────────

test('join: 입력창은 대문자 자동 변환, 자동 고침 없음', async () => {
  const { field } = await setup('join');
  expect(field('초대 코드').props.autoCapitalize).toBe('characters');
  expect(field('초대 코드').props.autoCorrect).toBe(false);
});

test('join: 8자가 아니거나 영숫자가 아니면 요청하지 않는다', async () => {
  const { type, press, texts } = await setup('join');
  for (const bad of ['', 'AB3X9K7', 'AB3X9K7QZ', '가나다라마바사아']) {
    await type('초대 코드', bad);
    await press('참여하기');
  }
  expect(mockRpc).not.toHaveBeenCalled();
  expect(texts()).toContain('영문과 숫자 8자');
});

test('join: 공백·하이픈을 지우고 대문자로 바꿔 accept_invite 하고 그 방으로 간다', async () => {
  mockRpc.mockReturnValue(ok(ROOM));
  const { type, press } = await setup('join');
  await type('초대 코드', ' ab3-x9k7q ');
  await press('참여하기');
  expect(mockRpc).toHaveBeenCalledWith('accept_invite', { code: CODE });
  expect(mockRouter.replace).toHaveBeenCalledWith(`/room/${ROOM}`);
});

test('join: 오류 코드마다 정해진 문구', async () => {
  const cases: [string, string][] = [
    ['invite_expired', '기간이 지난 코드예요. 새 코드를 받아 주세요'],
    ['invite_used', '이미 쓰인 코드예요'],
    ['invite_self', '내가 만든 코드는 입력할 수 없어요'],
    ['room_full', '방이 가득 찼어요 (최대 8명)'],
    ['invite_not_found', '없는 코드예요. 다시 확인해 주세요'],
    ['boom', '코드를 확인해 주세요'],
  ];
  for (const [code, message] of cases) {
    mockRpc.mockReturnValue(fail(code));
    const { type, press, texts } = await setup('join');
    await type('초대 코드', CODE);
    await press('참여하기');
    expect(texts()).toContain(message);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  }
});

test('join: 서버에 닿지 못하면 코드가 틀렸다고 하지 않는다', async () => {
  mockRpc.mockReturnValue(fail('TypeError: Failed to fetch', 0));
  const { type, press, texts } = await setup('join');
  await type('초대 코드', CODE);
  await press('참여하기');
  expect(texts()).toContain('연결이 불안정할 수도 있어요');
  expect(texts()).not.toContain('코드를 확인해 주세요');
});

test('join: 고치면 이전 오류는 사라진다', async () => {
  mockRpc.mockReturnValue(fail('invite_used'));
  const { type, press, texts } = await setup('join');
  await type('초대 코드', CODE);
  await press('참여하기');
  expect(texts()).toContain('이미 쓰인 코드예요');
  await type('초대 코드', 'AB3X');
  expect(texts()).not.toContain('이미 쓰인 코드예요');
});

test('join: 확인하는 중에 다시 눌러도 요청은 한 번이다', async () => {
  let release!: (v: unknown) => void;
  mockRpc.mockReturnValue(new Promise((r) => (release = r)));
  const { type, press } = await setup('join');
  await type('초대 코드', CODE);
  await press('참여하기');
  await press('참여하기');
  expect(mockRpc).toHaveBeenCalledTimes(1);
  await act(async () => release({ data: ROOM, error: null, status: 200 }));
  expect(mockRouter.replace).toHaveBeenCalledTimes(1);
});

test('join: 엔터로 두 번 제출해도(버튼이 아니라) 요청은 한 번이다', async () => {
  let release!: (v: unknown) => void;
  mockRpc.mockReturnValue(new Promise((r) => (release = r)));
  const { type, field } = await setup('join');
  await type('초대 코드', CODE);
  await act(async () => void field('초대 코드').props.onSubmitEditing());
  await act(async () => void field('초대 코드').props.onSubmitEditing());
  expect(mockRpc).toHaveBeenCalledTimes(1);
  await act(async () => release({ data: ROOM, error: null, status: 200 }));
  expect(mockRouter.replace).toHaveBeenCalledTimes(1);
});

test('group: 엔터로 두 번 제출해도 방은 하나만 만든다', async () => {
  let release!: (v: unknown) => void;
  mockRpc.mockImplementation((fn: string) => (fn === 'create_group' ? new Promise((r) => (release = r)) : ok(CODE)));
  const { type, field } = await setup('group');
  await type('방 이름', '팀플');
  await act(async () => void field('방 이름').props.onSubmitEditing());
  await act(async () => void field('방 이름').props.onSubmitEditing());
  expect(mockRpc.mock.calls.filter(([fn]) => fn === 'create_group')).toHaveLength(1);
  await act(async () => release({ data: ROOM, error: null, status: 200 }));
});

// ── 공통 ──────────────────────────────────────────────────

test('뒤로 가기: 갈 곳이 있으면 back, 없으면(웹 직접 열기) 대화 탭으로', async () => {
  const a = await setup('direct');
  await a.press('뒤로');
  expect(mockRouter.back).toHaveBeenCalledTimes(1);

  mockRouter.canGoBack.mockReturnValue(false);
  const b = await setup('direct');
  await b.press('뒤로');
  expect(mockRouter.replace).toHaveBeenCalledWith('/');
});

test('키가 없으면(supabase === null) 안내만 하고 요청하지 않는다', async () => {
  mockSupabase = null;
  const { press, texts } = await setup('direct');
  expect(texts()).toContain('Supabase 키가 없어요');
  await press('코드 만들기');
  expect(mockRpc).not.toHaveBeenCalled();
});

test('로그인하지 않았거나 프로필이 없으면 대화 탭으로 돌려보낸다', async () => {
  mockSession = { status: 'none', profileStatus: 'loading' };
  const a = await setup('direct');
  expect(a.find((n) => n.props.testID === 'redirect:/')).toHaveLength(1);
  mockSession = { status: 'in', profileStatus: 'missing' };
  const b = await setup('direct');
  expect(b.find((n) => n.props.testID === 'redirect:/')).toHaveLength(1);
  expect(b.field('방 이름')).toBeUndefined();
});

// ── 갈래를 바꾸면 이전 갈래의 코드가 남지 않는다 ─────────────

test('tab switch: 1:1 코드를 만든 뒤 그룹 탭에는 그룹 폼이 보이고 옛 코드는 없다, 돌아오면 다시 만들 수 있다', async () => {
  mockRpc.mockReturnValue(ok(CODE));
  const { press, field, texts, codeNode } = await setup('direct');
  await press('코드 만들기');
  expect(texts()).toContain(CODE);
  await press('그룹 만들기', 'radio');
  expect(field('방 이름')).toBeDefined();
  expect(texts()).not.toContain(CODE);
  expect(texts()).not.toContain('한 번 쓸 수 있어요');
  await press('1:1 초대', 'radio');
  expect(texts()).toContain('코드 만들기');
  expect(codeNode()).toBeUndefined();
});

test('tab switch: 그룹을 만든 뒤 1:1 탭에는 1:1 폼이 보이고 방으로 가기가 없다', async () => {
  mockRpc.mockReturnValueOnce(ok(ROOM)).mockReturnValueOnce(ok(CODE));
  const { press, type, buttons, texts } = await setup('group');
  await type('방 이름', '팀플 3조');
  await press('방 만들기');
  expect(buttons()).toContain('방으로 가기');
  await press('1:1 초대', 'radio');
  expect(buttons()).not.toContain('방으로 가기');
  expect(texts()).not.toContain(CODE);
  expect(buttons()).toContain('코드 만들기');
});
