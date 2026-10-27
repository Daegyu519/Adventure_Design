// 앱 → 엔진(/v1/*) 클라이언트. 타입은 생성 파일(types/engine.ts)에서 꺼내기만 한다.
// EXPO_PUBLIC_ENGINE_URL이 비어 있으면 mock(engineMock.ts)으로 돈다.
import { abortError, createMockEngine } from './engineMock';
import { supabase } from './supabase';
import type { paths } from './types/engine';

export type HintReq = paths['/v1/hint']['post']['requestBody']['content']['application/json'];
export type HintRes = paths['/v1/hint']['post']['responses'][200]['content']['application/json'];
export type DetailReq = paths['/v1/detail']['post']['requestBody']['content']['application/json'];
export type DetailRes = paths['/v1/detail']['post']['responses'][200]['content']['application/json'];
export type FeedbackReq = paths['/v1/feedback']['post']['requestBody']['content']['application/json'];
export type FeedbackRes = paths['/v1/feedback']['post']['responses'][202]['content']['application/json'];
export type StatsRes = paths['/v1/stats/me']['get']['responses'][200]['content']['application/json'];
export type MirrorTodayRes = paths['/v1/mirror/today']['post']['responses'][200]['content']['application/json'];
export type MirrorAnswerReq = paths['/v1/mirror/answer']['post']['requestBody']['content']['application/json'];
export type MirrorAnswerRes = paths['/v1/mirror/answer']['post']['responses'][200]['content']['application/json'];

/** status: HTTP 상태. 0 = 네트워크 오류 · 시간 초과, 401 = 로그인 토큰 없음. 호출자가 끊으면 EngineError가 아니라 AbortError다. */
export class EngineError extends Error {
  status: number;
  constructor(status: number, message = `engine error ${status}`) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
  }
}

export type CallOpts = { signal?: AbortSignal; timeoutMs?: number };

export const HINT_TIMEOUT_MS = 1700; // 엔진 1.5초 + 왕복 0.2초
export const DETAIL_TIMEOUT_MS = 9000;
export const DEFAULT_TIMEOUT_MS = 10000;

export type Engine = {
  isMock: boolean;
  hint(b: HintReq, o?: CallOpts): Promise<HintRes>;
  detail(b: DetailReq, o?: CallOpts): Promise<DetailRes>;
  feedback(b: FeedbackReq, o?: CallOpts): Promise<FeedbackRes>;
  stats(o?: CallOpts): Promise<StatsRes>;
  mirrorToday(o?: CallOpts): Promise<MirrorTodayRes>;
  mirrorAnswer(b: MirrorAnswerReq, o?: CallOpts): Promise<MirrorAnswerRes>;
};

export function createEngine(o: {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  fetchFn?: typeof fetch;
}): Engine {
  if (o.baseUrl === '') return createMockEngine();
  const fetchFn = o.fetchFn ?? fetch;

  async function call<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: CallOpts = {}): Promise<T> {
    // Hermes에는 AbortSignal.any가 없다. 호출자 signal과 시간 초과를 우리 controller 하나에 잇는다.
    const ctrl = new AbortController();
    const caller = opts.signal;
    const onCallerAbort = () => ctrl.abort();
    if (caller?.aborted) throw abortError(); // 이미 끊긴 signal은 abort 이벤트가 다시 오지 않는다
    caller?.addEventListener('abort', onCallerAbort);
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const token = await o.getToken();
      if (!token) throw new EngineError(401, 'no session');
      const res = await fetchFn(o.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new EngineError(res.status);
      return (await res.json()) as T;
    } catch (e) {
      if (caller?.aborted) throw abortError();
      if (e instanceof EngineError) throw e;
      // 호출자가 끊지 않았는데 controller가 끊겼으면 시간 초과다. 둘 다 status 0.
      throw new EngineError(0, ctrl.signal.aborted ? 'timeout' : String(e));
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }
  }

  return {
    isMock: false,
    hint: (b, opts) => call('POST', '/v1/hint', b, opts),
    detail: (b, opts) => call('POST', '/v1/detail', b, opts),
    feedback: (b, opts) => call('POST', '/v1/feedback', b, opts),
    stats: (opts) => call('GET', '/v1/stats/me', undefined, opts),
    mirrorToday: (opts) => call('POST', '/v1/mirror/today', undefined, opts),
    mirrorAnswer: (b, opts) => call('POST', '/v1/mirror/answer', b, opts),
  };
}

export const engine: Engine = createEngine({
  baseUrl: process.env.EXPO_PUBLIC_ENGINE_URL ?? '',
  getToken: async () => (await supabase?.auth.getSession())?.data.session?.access_token ?? null,
});
