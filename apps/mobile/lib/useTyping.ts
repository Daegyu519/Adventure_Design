import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { supabase } from './supabase';
import { TYPING_IDLE_MS, TYPING_THROTTLE_MS, typingLabel, type PresenceState } from './typing';

// 입력 중 표시(Realtime Presence, private 채널 `typing:<room>`). 엔진을 부르지 않는다(규칙 11).
// 채널이 거부돼도(정책 없음·연결 끊김) 입력 중 표시만 안 뜨고 대화는 그대로다.
export function useTyping(roomId: string, me: string, names: Record<string, string>) {
  const [state, setState] = useState<PresenceState>({});
  const chRef = useRef<{ track(p: object): Promise<unknown> } | null>(null);
  const ready = useRef(false);
  const lastSent = useRef<number | null>(null); // 마지막 typing:true를 보낸 시각. null = 입력 중 아님
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!supabase) return;
    const c = supabase;
    const ch = c
      .channel(`typing:${roomId}`, { config: { private: true, presence: { key: me } } })
      .on('presence', { event: 'sync' }, () => setState(ch.presenceState<PresenceState[string][number]>() as PresenceState))
      .subscribe((s) => {
        ready.current = s === 'SUBSCRIBED';
      });
    chRef.current = ch;
    return () => {
      ready.current = false;
      chRef.current = null;
      lastSent.current = null;
      if (idle.current) clearTimeout(idle.current);
      void c.removeChannel(ch);
    };
  }, [roomId, me]);

  const send = useCallback((typing: boolean) => {
    if (ready.current) void Promise.resolve(chRef.current?.track({ user_id: me, typing })).catch(() => {});
  }, [me]);

  const stop = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    if (lastSent.current === null) return;
    lastSent.current = null;
    send(false);
  }, [send]);

  const onDraftChange = useCallback(
    (text: string) => {
      if (text === '') return stop();
      if (!ready.current) return;
      const now = Date.now();
      if (lastSent.current === null || now - lastSent.current >= TYPING_THROTTLE_MS) {
        lastSent.current = now;
        send(true);
      }
      if (idle.current) clearTimeout(idle.current);
      idle.current = setTimeout(stop, TYPING_IDLE_MS);
    },
    [send, stop],
  );

  const label = useMemo(() => typingLabel(state, me, names), [state, me, names]);
  return { label, onDraftChange, stop };
}
