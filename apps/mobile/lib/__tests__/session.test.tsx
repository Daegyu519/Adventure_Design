import { act } from 'react';
import { createRoot } from 'test-renderer';

import { SessionProvider, useSession } from '../session';

type Sess = { user: { id: string; email?: string } } | null;
type Listener = (event: string, session: Sess) => void;

// 가짜 supabase: 네트워크·키 없이 세션 읽기, 로그인 이벤트, profiles 한 행 읽기만 흉내 낸다.
let mockSupabase: unknown = null;
jest.mock('../supabase', () => ({
  get supabase() {
    return mockSupabase;
  },
}));

const ROW = { id: 'u1', name: '지은', created_at: '2026-10-27T00:00:00Z', tone_hint_on: true };
const SESSION: Sess = { user: { id: 'u1', email: 'a@b.co' } };

function setup(initial: Sess | 'pending') {
  let emit: Listener = () => {};
  const unsubscribe = jest.fn();
  let finishSession: (s: Sess) => void = () => {};
  const maybeSingle = jest.fn();
  const fake = {
    auth: {
      getSession: jest.fn(() =>
        initial === 'pending'
          ? new Promise((r) => (finishSession = (s) => r({ data: { session: s }, error: null })))
          : Promise.resolve({ data: { session: initial }, error: null }),
      ),
      onAuthStateChange: jest.fn((cb: Listener) => {
        emit = cb;
        return { data: { subscription: { unsubscribe } } };
      }),
    },
    from: jest.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) })),
  };
  mockSupabase = fake;
  return { fake, maybeSingle, unsubscribe, emit: (e: string, s: Sess) => emit(e, s), finishSession: (s: Sess) => finishSession(s) };
}

async function mount() {
  let seen!: ReturnType<typeof useSession>;
  const Probe = () => {
    seen = useSession();
    return null;
  };
  const root = createRoot();
  await act(async () => {
    root.render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
  });
  return { root, get: () => seen };
}

afterEach(() => {
  mockSupabase = null;
  jest.restoreAllMocks();
});

test('session: no supabase keys → none, and nothing throws', async () => {
  const { get } = await mount();
  expect(get()).toMatchObject({ status: 'none', userId: null, email: null, profile: null });
});

test('session: loading until getSession answers (so login never flashes for a signed-in user)', async () => {
  const s = setup('pending');
  const { get } = await mount();
  expect(get().status).toBe('loading');
  s.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  await act(async () => s.finishSession(SESSION));
  expect(get().status).toBe('in');
});

test('session: signed out at start → none', async () => {
  setup(null);
  const { get } = await mount();
  expect(get().status).toBe('none');
  expect(get().userId).toBeNull();
});

test('session: signed in with a profiles row → in / ok, row exposed', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  const { get } = await mount();
  expect(get()).toMatchObject({ status: 'in', userId: 'u1', email: 'a@b.co', profileStatus: 'ok', profile: ROW });
  expect(s.fake.from).toHaveBeenCalledWith('profiles');
});

test('session: profile read still pending → profileStatus loading (not missing)', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockReturnValue(new Promise(() => {}));
  const { get } = await mount();
  expect(get()).toMatchObject({ status: 'in', profileStatus: 'loading', profile: null });
});

test('session: signed in without a row → missing, and that is not a failure', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockResolvedValue({ data: null, error: null });
  const { get } = await mount();
  expect(get()).toMatchObject({ status: 'in', profileStatus: 'missing', profile: null, profileFailed: false });
});

test('session: a profile read that errors is profileFailed, not a silent missing (gate still sees missing)', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection' } });
  const { get } = await mount();
  expect(get()).toMatchObject({ profileStatus: 'missing', profile: null, profileFailed: true });
});

test('session: a profile read that throws is profileFailed too', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockRejectedValue(new Error('offline'));
  const { get } = await mount();
  expect(get()).toMatchObject({ profileStatus: 'missing', profileFailed: true });
});

test('session: refreshProfile after a failure clears profileFailed when the read works; a second failure keeps it', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockRejectedValue(new Error('offline'));
  const { get } = await mount();
  expect(get().profileFailed).toBe(true);
  await act(async () => get().refreshProfile()); // 아직 오프라인
  expect(get().profileFailed).toBe(true);
  s.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  await act(async () => get().refreshProfile());
  expect(get()).toMatchObject({ profileFailed: false, profileStatus: 'ok', profile: ROW });
});

test('session: SIGNED_IN after login → in, profile read for that user', async () => {
  const s = setup(null);
  const { get } = await mount();
  s.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  await act(async () => s.emit('SIGNED_IN', SESSION));
  expect(get()).toMatchObject({ status: 'in', userId: 'u1', profileStatus: 'ok' });
});

test('session: SIGNED_OUT → none and the old profile is gone', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  const { get } = await mount();
  await act(async () => s.emit('SIGNED_OUT', null));
  expect(get()).toMatchObject({ status: 'none', userId: null, profile: null });
});

test('session: TOKEN_REFRESHED for the same user does not re-read the profile', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  await mount();
  await act(async () => s.emit('TOKEN_REFRESHED', { user: { id: 'u1', email: 'a@b.co' } }));
  expect(s.maybeSingle).toHaveBeenCalledTimes(1);
});

test('session: a profile read that lands after sign-out is dropped', async () => {
  const s = setup(SESSION);
  let finishRead: (v: unknown) => void = () => {};
  s.maybeSingle.mockReturnValue(new Promise((r) => (finishRead = r)));
  const { get } = await mount();
  await act(async () => s.emit('SIGNED_OUT', null));
  await act(async () => finishRead({ data: ROW, error: null }));
  expect(get()).toMatchObject({ status: 'none', profile: null });
  // 같은 기기에서 다른 사람이 들어와도 이전 사람의 행이 보이지 않는다
  s.maybeSingle.mockReturnValue(new Promise(() => {}));
  await act(async () => s.emit('SIGNED_IN', { user: { id: 'u2', email: 'c@d.co' } }));
  expect(get()).toMatchObject({ userId: 'u2', profileStatus: 'loading', profile: null });
});

test('session: refreshProfile re-reads the row (after the name is saved)', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockResolvedValue({ data: null, error: null });
  const { get } = await mount();
  expect(get().profileStatus).toBe('missing');
  s.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  await act(async () => get().refreshProfile());
  expect(get()).toMatchObject({ profileStatus: 'ok', profile: ROW });
});

test('session: unmount unsubscribes from auth changes', async () => {
  const s = setup(null);
  const { root } = await mount();
  await act(async () => root.unmount());
  expect(s.unsubscribe).toHaveBeenCalledTimes(1);
});

test('session: after sign-out the old profile is cleared, so the same user signing back in waits for a fresh read', async () => {
  const s = setup(SESSION);
  s.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  const { get } = await mount();
  expect(get().profileStatus).toBe('ok');
  await act(async () => s.emit('SIGNED_OUT', null));
  s.maybeSingle.mockReturnValue(new Promise(() => {}));
  await act(async () => s.emit('SIGNED_IN', SESSION));
  expect(get()).toMatchObject({ status: 'in', userId: 'u1', profileStatus: 'loading', profile: null });
});

test('session: a getSession result that arrives after an auth event does not overwrite it', async () => {
  const s = setup('pending');
  s.maybeSingle.mockResolvedValue({ data: ROW, error: null });
  const { get } = await mount();
  await act(async () => s.emit('SIGNED_IN', SESSION)); // 이벤트가 먼저
  await act(async () => s.finishSession(null)); // 늦게 온 옛 결과
  expect(get()).toMatchObject({ status: 'in', userId: 'u1' });
});

test('session: an auth event after unmount starts no profile read and logs nothing', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const s = setup(null);
  const { root } = await mount();
  await act(async () => root.unmount());
  await act(async () => s.emit('SIGNED_IN', SESSION));
  expect(s.fake.from).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test('session: never logs the email', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const s = setup(SESSION);
  s.maybeSingle.mockRejectedValue(new Error('offline'));
  await mount();
  expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain('a@b.co');
});
