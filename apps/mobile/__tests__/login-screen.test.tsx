import { act } from 'react';
import { createRoot } from 'test-renderer';

import Login from '../app/login';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }));

const mockOtp = jest.fn();
const mockVerify = jest.fn();
jest.mock('../lib/supabase', () => ({ supabase: { auth: { signInWithOtp: (a: unknown) => mockOtp(a), verifyOtp: (a: unknown) => mockVerify(a) } } }));

async function setup() {
  const root = createRoot();
  await act(async () => {
    root.render(<Login />);
  });
  const field = (label: string) => root.container.queryAll((n) => n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function')[0];
  const button = (label: string) => root.container.queryAll((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label)[0];
  const type = (label: string, text: string) => act(async () => field(label).props.onChangeText(text));
  const press = (label: string) => act(async () => button(label).props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  const texts = () => JSON.stringify(root.container.toJSON());
  return { root, field, button, type, press, texts };
}

const SENT = '메일로 받은 6자리 코드를 적어 주세요';

beforeEach(() => {
  mockOtp.mockReset().mockResolvedValue({ error: null });
  mockVerify.mockReset().mockResolvedValue({ error: null });
});

test('login: 이메일이 아니면 보내지 않고 입력창 아래에 알려 준다', async () => {
  const { type, press, texts } = await setup();
  await type('이메일', 'a@b');
  await press('코드 받기');
  expect(mockOtp).not.toHaveBeenCalled();
  expect(texts()).toContain('이메일 주소를 확인해 주세요');
});

test('login: 이메일을 다듬어 signInWithOtp(shouldCreateUser)로 보내고 코드 단계로 넘어간다', async () => {
  const { type, press, field, texts } = await setup();
  await type('이메일', ' a@b.co ');
  await press('코드 받기');
  expect(mockOtp).toHaveBeenCalledWith({ email: 'a@b.co', options: { shouldCreateUser: true } });
  expect(texts()).toContain(SENT);
  const code = field(SENT);
  expect(code.props).toMatchObject({ keyboardType: 'number-pad', textContentType: 'oneTimeCode', autoComplete: 'one-time-code' });
});

test('login: 보내기 한도(429)에 걸리면 이메일 단계에 남고 정해 둔 문구를 보여 준다', async () => {
  mockOtp.mockResolvedValue({ error: { status: 429, message: 'email rate limit exceeded' } });
  const { type, press, texts } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  expect(texts()).toContain('잠시 뒤 다시 받아 주세요');
  expect(texts()).not.toContain('rate limit'); // 서버 영문 문구는 그대로 보이지 않는다
  expect(texts()).not.toContain(SENT);
});

test('login: 코드는 공백을 지우고 verifyOtp(type email)로 확인한다', async () => {
  const { type, press } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await type(SENT, '123 456');
  await press('로그인');
  expect(mockVerify).toHaveBeenCalledWith({ email: 'a@b.co', token: '123456', type: 'email' });
});

test('login: 6자리가 아니면 확인하지 않는다', async () => {
  const { type, press, texts } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await type(SENT, '12345');
  await press('로그인');
  expect(mockVerify).not.toHaveBeenCalled();
  expect(texts()).toContain('6자리');
});

test('login: 틀리거나 만료된 코드는 정해 둔 문구', async () => {
  mockVerify.mockResolvedValue({ error: { status: 403, message: 'Token has expired or is invalid' } });
  const { type, press, texts } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await type(SENT, '123456');
  await press('로그인');
  expect(texts()).toContain('코드가 맞지 않거나 시간이 지났어요. 다시 받아 주세요.');
  expect(texts()).not.toContain('Token');
});

test('login: 확인 429는 기다리라는 문구', async () => {
  mockVerify.mockResolvedValue({ error: { status: 429, message: 'x' } });
  const { type, press, texts } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await type(SENT, '123456');
  await press('로그인');
  expect(texts()).toContain('잠시 뒤 다시 받아 주세요');
});

test('login: 이메일 다시 적기 → 이메일 단계로, 적었던 이메일은 남고 코드·오류는 지워진다', async () => {
  mockVerify.mockResolvedValue({ error: { status: 403, message: 'x' } });
  const { type, press, field, texts } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await type(SENT, '123456');
  await press('로그인');
  await press('이메일 다시 적기');
  expect(field('이메일').props.value).toBe('a@b.co');
  expect(texts()).not.toContain('코드가 맞지 않거나');
  await press('코드 받기');
  expect(mockOtp).toHaveBeenCalledTimes(2);
  expect(field(SENT).props.value).toBe('');
});

test('login: 이메일과 코드를 로그에 남기지 않는다', async () => {
  const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
  mockVerify.mockResolvedValue({ error: { status: 403, message: 'x' } });
  const { type, press } = await setup();
  await type('이메일', 'secret@b.co');
  await press('코드 받기');
  await type(SENT, '987654');
  await press('로그인');
  const logged = JSON.stringify(spies.map((s) => s.mock.calls));
  expect(logged).not.toContain('secret@b.co');
  expect(logged).not.toContain('987654');
  jest.restoreAllMocks();
});
