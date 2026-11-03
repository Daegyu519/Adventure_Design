import { engine, type HintReq, type HintRes } from './engine';

export const SEND_REVIEW_MS = 1500;

// 앱에서 잰 최대 대기 시간(토큰 갱신·왕복 포함). 엔진/통신 실패는 전송을 막지 않는다.
// fetch가 abort를 무시해도 끝나도록 별도 타이머로 경주한다. 원문은 메모리에만 둔다.
export function reviewBeforeSend(body: HintReq, signal: AbortSignal): Promise<HintRes | null> {
  if (signal.aborted || body.text.length > 500) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const deadline = Date.now() + SEND_REVIEW_MS;
    let settled = false;
    const finish = (result: HintRes | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      ctrl.abort();
      resolve(result);
    };
    const cancel = () => finish(null);
    const timer = setTimeout(cancel, SEND_REVIEW_MS);
    signal.addEventListener('abort', cancel);
    void Promise.resolve().then(() => {
      if (settled) return null;
      return engine.hint(body, { signal: ctrl.signal, timeoutMs: SEND_REVIEW_MS });
    }).then((result) => finish(result && result.seq === body.seq && Date.now() < deadline ? result : null), cancel);
  });
}
