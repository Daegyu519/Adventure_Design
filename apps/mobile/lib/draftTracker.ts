import type { Hint } from './hintScheduler';

// 한 초안 동안 힌트가 어떻게 됐는지(로그용). 보내면 비운다.
export function createDraftTracker() {
  let current: string | null = null; // 지금 떠 있는 제목
  let everShown = false;
  let wasDismissed = false;
  const closed = new Set<string>();
  const reset = () => {
    current = null;
    everShown = false;
    wasDismissed = false;
    closed.clear();
  };
  return {
    shown(h: Hint) {
      const isNew = h.title !== current;
      current = h.title;
      everShown = true;
      return isNew;
    },
    cleared() {
      current = null;
    },
    dismissed() {
      if (current !== null) closed.add(current);
      wasDismissed = true;
      current = null;
    },
    suppressed: (h: Hint) => closed.has(h.title),
    send(): 'sent_with_hint' | 'sent_after_fix' | null {
      const r = current !== null || wasDismissed ? 'sent_with_hint' : everShown ? 'sent_after_fix' : null;
      reset();
      return r;
    },
  };
}
