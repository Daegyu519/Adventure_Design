import { createEngine, EngineError } from '../engine';

// 기본 engine 인스턴스가 읽는 supabase(AsyncStorage 네이티브 모듈)는 이 테스트와 관계없다.
jest.mock('../supabase', () => ({ supabase: null }));

const R = '00000000-0000-4000-8000-000000000001';

// fetch 응답 흉내. 엔진 클라이언트는 ok · status · json()만 본다.
const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

// signal이 abort될 때만 끝나는(reject) fetch
const hangingFetch = () =>
  jest.fn(
    (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  );

afterEach(() => jest.useRealTimers());

test('posts JSON with Bearer token to baseUrl + path', async () => {
  const fetchFn = jest.fn(async () => reply(200, { seq: 1, hint: null, trace_id: 't' }));
  const res = await createEngine({ baseUrl: 'http://e', getToken: async () => 'tok', fetchFn }).hint({ room_id: R, text: '안녕', seq: 1 });
  expect(res).toEqual({ seq: 1, hint: null, trace_id: 't' });
  expect(fetchFn).toHaveBeenCalledWith('http://e/v1/hint', expect.objectContaining({ method: 'POST' }));
  const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  expect(JSON.parse(init.body as string).seq).toBe(1);
});

test('non-2xx throws EngineError with status', async () => {
  const fetchFn = jest.fn(async () => reply(403, { detail: 'not a member' }));
  const p = createEngine({ baseUrl: 'http://e', getToken: async () => 'tok', fetchFn }).stats();
  await expect(p).rejects.toBeInstanceOf(EngineError);
  await expect(p).rejects.toMatchObject({ status: 403 });
});

test('no token → EngineError 401 without calling fetch', async () => {
  const fetchFn = jest.fn();
  const p = createEngine({ baseUrl: 'http://e', getToken: async () => null, fetchFn }).mirrorToday();
  await expect(p).rejects.toMatchObject({ status: 401 });
  expect(fetchFn).not.toHaveBeenCalled();
});

test('timeoutMs elapsed → aborts fetch and throws EngineError 0', async () => {
  jest.useFakeTimers();
  const fetchFn = hangingFetch();
  const p = createEngine({ baseUrl: 'http://e', getToken: async () => 'tok', fetchFn }).hint({ room_id: R, text: '안녕', seq: 2 }, { timeoutMs: 1700 });
  const settled = expect(p).rejects.toMatchObject({ name: 'EngineError', status: 0 });

  await jest.advanceTimersByTimeAsync(1699);
  const signal = fetchFn.mock.calls[0][1]!.signal!;
  expect(signal.aborted).toBe(false); // 시간이 되기 전에는 끊지 않는다

  await jest.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  await settled;
});

test('caller abort → rejects and fetch signal is aborted', async () => {
  const fetchFn = hangingFetch();
  const ctrl = new AbortController();
  const p = createEngine({ baseUrl: 'http://e', getToken: async () => 'tok', fetchFn }).detail({ room_id: R, text: '안 돼요.' }, { signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 0)); // 토큰을 받고 fetch까지 가게 둔다
  ctrl.abort();
  // 호출자가 끊은 것은 엔진 오류(0 · 시간 초과)와 구별되게 AbortError로 돌려준다
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchFn.mock.calls[0][1]!.signal!.aborted).toBe(true);

  // 이미 끊긴 signal이면 fetch를 부르지 않는다(abort 이벤트가 다시 오지 않으므로)
  const late = createEngine({ baseUrl: 'http://e', getToken: async () => 'tok', fetchFn }).detail({ room_id: R, text: '안 돼요.' }, { signal: ctrl.signal });
  await expect(late).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test('mock: echoes seq, hints "안 돼요." and not "좋아요!"', async () => {
  const e = createEngine({ baseUrl: '', getToken: async () => null });
  expect(e.isMock).toBe(true);
  expect((await e.hint({ room_id: R, text: '안 돼요.', seq: 3 })).seq).toBe(3);
  expect((await e.hint({ room_id: R, text: '안 돼요.', seq: 3 })).hint?.title).toBe('차갑게 느껴질 수도 있어요');
  expect((await e.hint({ room_id: R, text: '좋아요!', seq: 4 })).hint).toBeNull();
});

test('mock detail: option A changes with intent', async () => {
  const e = createEngine({ baseUrl: '', getToken: async () => null });
  const sorry = await e.detail({ room_id: R, text: '안 돼요.', intent: '미안하게' });
  expect(sorry.options[0].text.startsWith('미안하지만 ')).toBe(true);
  expect(typeof sorry.mismatch).toBe('string');
  expect(sorry.options.map((o) => o.label)).toEqual(['조금만 바꾼 문장', '가장 부드럽게 바꾼 문장']);

  const plain = await e.detail({ room_id: R, text: '안 돼요.' });
  expect(plain.options[0].text.startsWith('미안하지만 ')).toBe(false);
  expect(plain.mismatch).toBeNull();
});
