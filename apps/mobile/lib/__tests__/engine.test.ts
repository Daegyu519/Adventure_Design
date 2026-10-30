import { createEngine, EngineError, type Engine } from '../engine';

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

const real = (fetchFn: jest.Mock, getToken: () => Promise<string | null> = async () => 'tok') =>
  createEngine({ baseUrl: 'http://e', getToken, fetchFn: fetchFn as unknown as typeof fetch });

afterEach(() => jest.useRealTimers());

test('posts JSON with Bearer token to baseUrl + path, then clears its timer and listener', async () => {
  jest.useFakeTimers();
  const fetchFn = jest.fn(async () => reply(200, { seq: 1, hint: null, trace_id: 't' }));
  const caller = new AbortController();
  const removed = jest.spyOn(caller.signal, 'removeEventListener');
  const res = await real(fetchFn).hint({ room_id: R, text: '안녕', seq: 1 }, { signal: caller.signal });
  expect(res).toEqual({ seq: 1, hint: null, trace_id: 't' });
  expect(fetchFn).toHaveBeenCalledWith('http://e/v1/hint', expect.objectContaining({ method: 'POST' }));
  const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body as string).seq).toBe(1);
  expect(jest.getTimerCount()).toBe(0); // 시간 초과 타이머가 남지 않는다
  expect(removed).toHaveBeenCalledWith('abort', expect.any(Function)); // 호출자 signal에 붙인 listener도 뗀다
});

test('GET sends no body and no Content-Type', async () => {
  const fetchFn = jest.fn(async () => reply(200, {}));
  await real(fetchFn).stats();
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://e/v1/stats/me');
  expect(init.method).toBe('GET');
  expect(init.body).toBeUndefined();
  expect(init.headers).not.toHaveProperty('Content-Type');
});

test('baseUrl is trimmed and loses trailing slashes; whitespace-only means mock', async () => {
  const fetchFn = jest.fn(async () => reply(200, {}));
  await createEngine({ baseUrl: '  http://e//  ', getToken: async () => 'tok', fetchFn: fetchFn as unknown as typeof fetch }).stats();
  expect(fetchFn.mock.calls[0]).toContain('http://e/v1/stats/me');
  expect(createEngine({ baseUrl: '   ', getToken: async () => 'tok' }).isMock).toBe(true);
});

test('non-2xx throws EngineError with status', async () => {
  const fetchFn = jest.fn(async () => reply(403, { detail: 'not a member' }));
  const p = real(fetchFn).stats();
  await expect(p).rejects.toBeInstanceOf(EngineError);
  await expect(p).rejects.toMatchObject({ status: 403 });
});

test('network TypeError → EngineError 0', async () => {
  const fetchFn = jest.fn(async () => {
    throw new TypeError('Network request failed');
  });
  await expect(real(fetchFn).feedback({ room_id: R, message_id: 1, text: '속상했어요' })).rejects.toMatchObject({ name: 'EngineError', status: 0 });
});

test('no token → EngineError 401 without calling fetch', async () => {
  const fetchFn = jest.fn();
  await expect(real(fetchFn, async () => null).mirrorToday()).rejects.toMatchObject({ status: 401 });
  expect(fetchFn).not.toHaveBeenCalled();
});

test('timeoutMs elapsed → aborts fetch and throws EngineError 0', async () => {
  jest.useFakeTimers();
  const fetchFn = hangingFetch();
  const p = real(fetchFn).hint({ room_id: R, text: '안녕', seq: 2 }, { timeoutMs: 1700 });
  const settled = expect(p).rejects.toMatchObject({ name: 'EngineError', status: 0 });

  await jest.advanceTimersByTimeAsync(1699);
  const signal = fetchFn.mock.calls[0][1]!.signal!;
  expect(signal.aborted).toBe(false); // 시간이 되기 전에는 끊지 않는다

  await jest.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  await settled;
});

test('slow getToken is bounded by the timeout and fetch is never called', async () => {
  jest.useFakeTimers();
  const fetchFn = hangingFetch();
  const slowToken = () => new Promise<string>((r) => setTimeout(() => r('tok'), 5000));
  const p = real(fetchFn, slowToken).hint({ room_id: R, text: '안녕', seq: 5 }, { timeoutMs: 1700 });
  let settledAt = -1;
  p.catch(() => (settledAt = Date.now()));
  const start = Date.now();

  await jest.advanceTimersByTimeAsync(1700);
  await expect(p).rejects.toMatchObject({ name: 'EngineError', status: 0 });
  expect(settledAt - start).toBe(1700);

  await jest.advanceTimersByTimeAsync(5000); // 토큰이 뒤늦게 와도 fetch하지 않는다
  expect(fetchFn).not.toHaveBeenCalled();
});

test('caller abort while waiting for the token → AbortError at once, no fetch', async () => {
  const fetchFn = hangingFetch();
  const ctrl = new AbortController();
  const p = real(fetchFn, () => new Promise<string>(() => {})).hint({ room_id: R, text: '안녕', seq: 6 }, { signal: ctrl.signal });
  ctrl.abort();
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchFn).not.toHaveBeenCalled();
});

test('caller abort → rejects and fetch signal is aborted', async () => {
  const fetchFn = hangingFetch();
  const ctrl = new AbortController();
  const p = real(fetchFn).detail({ room_id: R, text: '안 돼요.' }, { signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 0)); // 토큰을 받고 fetch까지 가게 둔다
  ctrl.abort();
  // 호출자가 끊은 것은 엔진 오류(0 · 시간 초과)와 구별되게 AbortError로 돌려준다
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchFn.mock.calls[0][1]!.signal!.aborted).toBe(true);

  // 이미 끊긴 signal이면 fetch를 부르지 않는다(abort 이벤트가 다시 오지 않으므로)
  const late = real(fetchFn).detail({ room_id: R, text: '안 돼요.' }, { signal: ctrl.signal });
  await expect(late).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

const byMethod: [string, number, (e: Engine) => Promise<unknown>][] = [
  ['hint', 1700, (e) => e.hint({ room_id: R, text: '안녕', seq: 1 })],
  ['detail', 9000, (e) => e.detail({ room_id: R, text: '안녕' })],
  ['feedback', 10000, (e) => e.feedback({ room_id: R, message_id: 1, text: '속상했어요' })],
  ['stats', 10000, (e) => e.stats()],
  ['mirrorToday', 10000, (e) => e.mirrorToday()],
  ['mirrorAnswer', 10000, (e) => e.mirrorAnswer({ card_id: 'c', score: 3 })],
];
test.each(byMethod)('%s times out after %i ms by default', async (_name, ms, run) => {
  jest.useFakeTimers();
  const fetchFn = hangingFetch();
  const settled = expect(run(real(fetchFn))).rejects.toMatchObject({ name: 'EngineError', status: 0 });
  await jest.advanceTimersByTimeAsync(ms - 1);
  expect(fetchFn.mock.calls[0][1]!.signal!.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  await settled;
});

test('default engine falls back to the mock and warns in dev when EXPO_PUBLIC_ENGINE_URL is empty', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const env = process.env;
  process.env = { ...env, NODE_ENV: 'development', EXPO_PUBLIC_ENGINE_URL: ' ' };
  try {
    jest.isolateModules(() => {
      expect(jest.requireActual<typeof import('../engine')>('../engine').engine.isMock).toBe(true);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EXPO_PUBLIC_ENGINE_URL'));
  } finally {
    process.env = env;
    warn.mockRestore();
  }
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

test('mock stats: five Monday weeks ending this week, oldest first (Sunday belongs to the week before)', async () => {
  jest.useFakeTimers({ now: new Date('2026-11-01T03:00:00Z') }); // 2026-11-01 일요일 낮 12시 KST(기기 시간대와 무관)
  const p = createEngine({ baseUrl: '', getToken: async () => null }).stats();
  await jest.advanceTimersByTimeAsync(300);
  const s = await p;
  expect(s.hints_by_week).toEqual([
    { week: '2026-09-28', count: 1 },
    { week: '2026-10-05', count: 0 },
    { week: '2026-10-12', count: 3 },
    { week: '2026-10-19', count: 5 },
    { week: '2026-10-26', count: 3 },
  ]);
  expect(s.predict_gap_trend.map((g) => g.week)).toEqual(['2026-10-19', '2026-10-26']);
});

// 기기 시간대와 무관해야 한다: 아래 두 순간은 UTC 기기에서는 둘 다 일요일이다(TZ=UTC로 돌려 확인).
test.each([
  ['2026-11-01T14:59:00Z', '2026-10-26'], // 일요일 23:59 KST = 지난 주 (mock은 300ms 뒤에 시계를 읽으므로 경계에서 1분 떨어뜨린다)
  ['2026-11-01T15:00:00Z', '2026-11-02'], // 월요일 00:00 KST = 새 주
])('mock stats: 마지막 주는 KST 이번 주 월요일이다 (%s)', async (now, lastWeek) => {
  jest.useFakeTimers({ now: new Date(now) });
  const p = createEngine({ baseUrl: '', getToken: async () => null }).stats();
  await jest.advanceTimersByTimeAsync(300);
  const s = await p;
  expect(s.hints_by_week.at(-1)?.week).toBe(lastWeek);
  expect(s.hints_by_week).toHaveLength(5);
});

test('429 carries Retry-After as retryAfterMs; other statuses do not', async () => {
  const h = (v: string | null) => ({ get: () => v });
  const f429 = jest.fn(async () => ({ ok: false, status: 429, headers: h('3'), json: async () => ({}) }) as unknown as Response);
  const e = await real(f429).hint({ room_id: R, text: 'a', seq: 1 }).catch((x) => x);
  expect(e).toBeInstanceOf(EngineError);
  expect(e.status).toBe(429);
  expect(e.retryAfterMs).toBe(3000);
  const f503 = jest.fn(async () => ({ ok: false, status: 503, headers: h('3'), json: async () => ({}) }) as unknown as Response);
  expect((await real(f503).hint({ room_id: R, text: 'a', seq: 1 }).catch((x) => x)).retryAfterMs).toBeUndefined();
});

test.each([[null], [''], ['abc'], ['0'], ['Wed, 21 Oct 2026 07:28:00 GMT']])('429 with unusable Retry-After %p leaves retryAfterMs unset', async (v) => {
  const f = jest.fn(async () => ({ ok: false, status: 429, headers: { get: () => v }, json: async () => ({}) }) as unknown as Response);
  const e = await real(f).hint({ room_id: R, text: 'a', seq: 1 }).catch((x) => x);
  expect(e.status).toBe(429);
  expect(e.retryAfterMs).toBeUndefined();
});
