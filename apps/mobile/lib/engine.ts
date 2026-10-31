// 앱 → 엔진(/v1/*) 클라이언트. 타입은 생성 파일(types/engine.ts)에서 꺼내기만 한다.
// EXPO_PUBLIC_ENGINE_URL이 비어 있으면 개발·테스트는 mock(engineMock.ts)으로 돌고, 배포 빌드는 엔진이 꺼진다(모든 호출 실패, 채팅은 그대로).
import { abortError } from './abort';
import { createMockEngine } from './engineMock';
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
  retryAfterMs?: number; // 429의 Retry-After(초)를 ms로
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
  // 앞뒤 공백과 끝 '/'를 떼어 'http://host:8000/'이 '//v1/…'(404)가 되지 않게 한다. 공백뿐이면 비어 있는 것으로 본다.
  const baseUrl = o.baseUrl.trim().replace(/\/+$/, '');
  if (baseUrl === '') {
    if (__DEV__) return createMockEngine();
    // 배포 빌드는 가짜 힌트를 내지 않고(파일럿 기록이 가짜가 된다) 던지지도 않는다(규칙 11: 엔진 때문에 채팅이 멈추면 안 된다).
    // 모든 호출이 연결 실패(status 0)로 끝나 힌트는 조용히 없고, 살펴보기·털어놓기·거울·리포트는 기존 고정 문구를 보인다.
    console.error('[engine] EXPO_PUBLIC_ENGINE_URL is empty in a release build: engine features are off');
    const off = () => Promise.reject(new EngineError(0, 'engine_not_configured'));
    return { isMock: false, hint: off, detail: off, feedback: off, stats: off, mirrorToday: off, mirrorAnswer: off };
  }
  const fetchFn = o.fetchFn ?? fetch;

  async function call<T>(method: 'GET' | 'POST', path: string, body: unknown, opts: CallOpts = {}, defaultTimeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    // Hermes에는 AbortSignal.any가 없다. 호출자 signal과 시간 초과를 우리 controller 하나에 잇는다.
    const ctrl = new AbortController();
    const caller = opts.signal;
    const onCallerAbort = () => ctrl.abort();
    if (caller?.aborted) throw abortError(); // 이미 끊긴 signal은 abort 이벤트가 다시 오지 않는다
    caller?.addEventListener('abort', onCallerAbort);
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? defaultTimeoutMs);
    // getToken(세션 갱신은 네트워크를 탈 수 있다)은 끊을 수 없으니 abort와 경주시켜 시간 안에 끝낸다.
    const aborted = new Promise<never>((_resolve, reject) => ctrl.signal.addEventListener('abort', () => reject(abortError())));
    aborted.catch(() => {}); // 경주가 끝난 뒤 abort되어도 처리 안 된 reject로 남지 않게

    try {
      const token = await Promise.race([o.getToken(), aborted]);
      if (!token) throw new EngineError(401, 'no session');
      if (ctrl.signal.aborted) throw abortError(); // 토큰과 abort가 같이 끝났으면 fetch하지 않는다
      const res = await fetchFn(baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = new EngineError(res.status);
        const raw = res.headers?.get?.('Retry-After');
        const ra = raw ? Number(raw) : NaN; // 없음·빈 값·날짜 형식은 NaN → 미설정(호출자가 기본 대기를 쓴다)
        if (res.status === 429 && Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
        throw err;
      }
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
    hint: (b, opts) => call('POST', '/v1/hint', b, opts, HINT_TIMEOUT_MS),
    detail: (b, opts) => call('POST', '/v1/detail', b, opts, DETAIL_TIMEOUT_MS),
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

// URL이 비면 가짜 힌트가 나간다. 개발 중에는 눈에 보이게 알린다(배포 빌드는 위에서 엔진을 끈다).
if (__DEV__ && process.env.NODE_ENV !== 'test' && engine.isMock) {
  console.warn('[engine] EXPO_PUBLIC_ENGINE_URL 이 비어 있어 mock 엔진을 씁니다(가짜 힌트). apps/mobile/.env 를 확인하세요(.env.example 참고).');
}
