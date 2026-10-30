import { useCallback, useEffect, useRef, useState } from 'react';

import { createDraftTracker } from './draftTracker';
import { engine, HINT_TIMEOUT_MS } from './engine';
import { createHintScheduler, type Hint } from './hintScheduler';
import { logToneEvent } from './toneEvents';

// 방마다 스케줄러·초안 추적기 하나. 엔진이 죽어도 대화는 그대로다(규칙 11): 실패는 힌트 없음일 뿐.
// enabled/replyTo는 ref로 읽어서 설정을 바꾸면 다음 입력부터 바로 반영된다.
export function useToneHint(roomId: string, replyToId: number | null, enabled: boolean) {
  const [hint, setHint] = useState<Hint | null>(null);
  const live = useRef({ enabled, replyToId });
  live.current = { enabled, replyToId };
  const tracker = useRef(createDraftTracker());
  const sched = useRef<ReturnType<typeof createHintScheduler> | null>(null);

  useEffect(() => {
    const t = tracker.current;
    const s = createHintScheduler({
      enabled: () => live.current.enabled,
      request: (text, seq, signal) =>
        engine.hint({ room_id: roomId, text, seq, ...(live.current.replyToId !== null ? { reply_to: live.current.replyToId } : {}) }, { signal, timeoutMs: HINT_TIMEOUT_MS }),
      onResult: ({ hint: h, traceId }) => {
        if (h && !t.suppressed(h)) {
          setHint(h);
          if (t.shown(h)) logToneEvent({ room_id: roomId, kind: 'hint_shown', signals: { trace_id: traceId } });
        } else {
          setHint(null);
          t.cleared();
        }
      },
    });
    sched.current = s;
    return () => {
      s.dispose();
      sched.current = null;
    };
  }, [roomId]);

  // 힌트를 끄면 떠 있는 힌트를 치우고 진행 중 요청을 끊는다.
  useEffect(() => {
    if (!enabled) sched.current?.sent();
  }, [enabled]);

  const input = useCallback((text: string) => sched.current?.input(text), []);
  const dismiss = useCallback(() => {
    tracker.current.dismissed();
    setHint(null);
  }, []);
  const sent = useCallback(() => {
    const ev = tracker.current.send();
    if (ev) logToneEvent({ room_id: roomId, kind: ev });
    sched.current?.sent();
  }, [roomId]);
  return { hint, input, dismiss, sent };
}
