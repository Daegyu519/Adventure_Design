import { useEffect, useMemo, useState } from 'react';

import { tsMicros } from './messages';
import type { Member } from './rooms';
import { supabase } from './supabase';

const EMPTY: Member[] = [];
const newerThan = (a: string | null, b: string | null) => a !== null && (b === null || tsMicros(a) > tsMicros(b));

// 방 멤버. 처음 값(fetchRoom 결과)에 room_members UPDATE(last_read_at·muted)를 덮는다. 더 옛 읽은 시각으로는 되돌리지 않는다.
export function useMembers(roomId: string, initial: Member[] = EMPTY): Member[] {
  const [patch, setPatch] = useState<Record<string, Pick<Member, 'last_read_at' | 'muted'>>>({});
  useEffect(() => {
    if (!supabase) return;
    const c = supabase;
    const ch = c
      .channel(`members:${roomId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` }, (p) => {
        const n = p.new as { user_id: string; last_read_at: string | null; muted: boolean };
        setPatch((cur) => {
          const old = cur[n.user_id];
          return { ...cur, [n.user_id]: { muted: n.muted, last_read_at: old && newerThan(old.last_read_at, n.last_read_at) ? old.last_read_at : n.last_read_at } };
        });
      })
      .subscribe();
    return () => void c.removeChannel(ch);
  }, [roomId]);
  return useMemo(
    () =>
      initial.map((m) => {
        const p = patch[m.user_id];
        if (!p) return m;
        return { ...m, muted: p.muted, last_read_at: newerThan(m.last_read_at, p.last_read_at) ? m.last_read_at : p.last_read_at };
      }),
    [initial, patch],
  );
}
