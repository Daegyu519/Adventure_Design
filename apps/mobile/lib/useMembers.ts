import { useCallback, useEffect, useMemo, useState } from 'react';

import { tsMicros } from './messages';
import { freshTopic, watchStatus } from './realtime';
import type { Member } from './rooms';
import { supabase } from './supabase';

const EMPTY: Member[] = [];
const newerThan = (a: string | null, b: string | null) => a !== null && (b === null || tsMicros(a) > tsMicros(b));

// 방 멤버. 처음 값(fetchRoom 결과)에 room_members UPDATE(last_read_at·muted)를 덮는다. 더 옛 읽은 시각으로는 되돌리지 않는다.
// error = Realtime이 끊김(다시 불러오기 줄). reload는 채널을 새로 연다(읽은 시각은 부른 쪽이 fetchRoom으로 다시 받는다).
export function useMembers(roomId: string, initial: Member[] = EMPTY) {
  const [patch, setPatch] = useState<Record<string, Pick<Member, 'last_read_at' | 'muted'>>>({});
  const [error, setError] = useState(false);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!supabase) return;
    const c = supabase;
    let alive = true;
    const ch = c
      .channel(freshTopic(`members:${roomId}`))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, (p) => {
        const n = p.new as { user_id: string; last_read_at: string | null; muted: boolean };
        setPatch((cur) => {
          const old = cur[n.user_id];
          return { ...cur, [n.user_id]: { muted: n.muted, last_read_at: old && newerThan(old.last_read_at, n.last_read_at) ? old.last_read_at : n.last_read_at } };
        });
      })
      .subscribe((s) => alive && watchStatus(s, 'members', () => setError(false), () => setError(true)));
    return () => {
      alive = false;
      void c.removeChannel(ch);
    };
  }, [roomId, gen]);
  const reload = useCallback(() => setGen((g) => g + 1), []);
  const members = useMemo(
    () =>
      initial.map((m) => {
        const p = patch[m.user_id];
        if (!p) return m;
        return { ...m, muted: p.muted, last_read_at: newerThan(m.last_read_at, p.last_read_at) ? m.last_read_at : p.last_read_at };
      }),
    [initial, patch],
  );
  return { members, error, reload };
}
