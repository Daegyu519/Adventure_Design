import type { HintRes } from './engine';

// 화면에 보이는 문구만. 알림 단계(level·can_soften, P-46)는 보낼 때 확인(sendReview)에서 HintRes로 직접 본다.
export type Hint = Pick<NonNullable<HintRes['hint']>, 'title' | 'detail'>;
type Result = { hint: Hint | null; traceId: string | null };
const NONE: Result = { hint: null, traceId: null };
const BACKOFF_MS = 5000; // 실패(429 Retry-After 없음·503·네트워크·그 밖의 상태) 뒤 기본 대기
const BACKOFF_MAX_MS = 60_000;

// 입력 중 힌트 요청 스케줄러(규칙 8: seq + AbortController로 오래된 결과를 버린다).
// 새 입력 동안 기존 힌트는 그대로 둔다(깜빡임 방지) — 비우는 건 빈 글·너무 긴 글·꺼짐·실패·보내기뿐.
export function createHintScheduler(o: {
  request(text: string, seq: number, signal: AbortSignal): Promise<HintRes>;
  onResult(r: Result): void;
  enabled(): boolean;
  debounceMs?: number;
  maxLen?: number;
}) {
  const debounceMs = o.debounceMs ?? 500;
  const maxLen = o.maxLen ?? 500;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ctrl: AbortController | null = null;
  let blockedUntil = 0; // 실패 뒤 이 시각까지 요청하지 않는다(장애 중 타자마다 요청이 나가지 않게)
  let dead = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    ctrl?.abort();
    ctrl = null;
  };

  const fire = async (text: string, mine: number) => {
    timer = null;
    if (!o.enabled()) return o.onResult(NONE);
    const c = (ctrl = new AbortController());
    try {
      const res = await o.request(text, mine, c.signal);
      if (dead || mine !== seq || res.seq !== mine) return;
      o.onResult({ hint: res.hint ?? null, traceId: res.trace_id ?? null });
    } catch (e) {
      if (dead || mine !== seq || c.signal.aborted) return;
      const err = e as { status?: number; retryAfterMs?: number };
      // 어떤 실패든 쉰다(401·403·422·500도: 쉬지 않으면 글자마다 실패 요청이 나간다). 429는 Retry-After만큼.
      const wait = err.retryAfterMs && err.retryAfterMs > 0 ? err.retryAfterMs : BACKOFF_MS;
      blockedUntil = Date.now() + Math.min(wait, BACKOFF_MAX_MS);
      // ponytail: 개발 중 경고만(상태만, 서버 글 없음). tone_events.kind에 hint_error가 없어 파일럿 기록은 마이그레이션이 생기면.
      if (__DEV__ && err.status !== undefined && err.status !== 0 && err.status !== 429 && err.status !== 503) console.warn(`[hint] engine error ${err.status}`);
      o.onResult(NONE); // 조용히 힌트 없음. 서버 문구는 보이지 않는다.
    }
  };

  return {
    input(text: string) {
      cancel();
      const mine = ++seq;
      const t = text.trim();
      if (!t || t.length > maxLen || !o.enabled()) return o.onResult(NONE);
      timer = setTimeout(() => void fire(t, mine), Math.max(debounceMs, blockedUntil - Date.now()));
    },
    sent() {
      cancel();
      seq++;
      o.onResult(NONE);
    },
    dispose() {
      dead = true;
      cancel();
    },
  };
}
