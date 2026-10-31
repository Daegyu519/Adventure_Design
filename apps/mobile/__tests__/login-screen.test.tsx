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

const SENT = '메일로 받은 숫자 코드를 적어 주세요';

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

test('login: 6~10자리 숫자가 아니면 확인하지 않는다', async () => {
  const { type, press, texts } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await type(SENT, '12345');
  await press('로그인');
  expect(mockVerify).not.toHaveBeenCalled();
  expect(texts()).toContain('메일로 받은 숫자 코드를 그대로 적어 주세요');
});

test('login: Supabase 기본 8자리 코드도 그대로 확인한다', async () => {
  const { type, press } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await type(SENT, '7977 8423');
  await press('로그인');
  expect(mockVerify).toHaveBeenCalledWith({ email: 'a@b.co', token: '79778423', type: 'email' });
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

test('login: 확인이 네트워크 오류로 던져지면 코드가 틀렸다고 하지 않고 연결 문구를 보여 준다', async () => {
  mockVerify.mockRejectedValue(new Error('network'));
  const { type, press, texts } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await type(SENT, '123456');
  await press('로그인');
  expect(texts()).toContain('연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.');
  expect(texts()).not.toContain('코드가 맞지 않거나');
});

test('login: 코드 받기를 보내는 중에 다시 제출(Enter)해도 한 번만 보낸다', async () => {
  mockOtp.mockReturnValue(new Promise(() => {})); // 응답이 올 때까지 멈춤
  const { type, press, field } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await act(async () => field('이메일').props.onSubmitEditing());
  expect(mockOtp).toHaveBeenCalledTimes(1);
});

test('login: 확인하는 중에 다시 제출(Enter)해도 한 번만 확인한다', async () => {
  mockVerify.mockReturnValue(new Promise(() => {}));
  const { type, press, field } = await setup();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await type(SENT, '123456');
  await press('로그인');
  await act(async () => field(SENT).props.onSubmitEditing());
  expect(mockVerify).toHaveBeenCalledTimes(1);
});

// "이메일 다시 적기"를 누르면 그 버튼이 사라진다: 포커스가 body로 떨어지지 않게 이메일 칸으로(T-07). 처음 열 때는 자동 포커스 없음.
test('login: 이메일 다시 적기 뒤에는 이메일 칸에 포커스, 처음에는 없음', async () => {
  const { type, press, field } = await setup();
  expect(field('이메일').props.autoFocus).toBeFalsy();
  await type('이메일', 'a@b.co');
  await press('코드 받기');
  await press('이메일 다시 적기');
  expect(field('이메일').props.autoFocus).toBe(true);
});
