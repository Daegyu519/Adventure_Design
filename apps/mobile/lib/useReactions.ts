import { useCallback, useEffect, useRef, useState } from 'react';

import type { Emoji } from './messages';
import { nextReactionOp } from './messages';
import { supabase } from './supabase';
import type { Tables } from './types/db';

type Row = Tables<'reactions'>;
const same = (a: Pick<Row, 'message_id' | 'user_id'>, b: Pick<Row, 'message_id' | 'user_id'>) => a.message_id === b.message_id && a.user_id === b.user_id;

// 방의 공감. 불러온 메시지의 것만 담는다. upsert는 쓰지 않는다(DB는 update(emoji)만 허용): insert / update / delete로 나눈다.
export function useReactions(roomId: string, messageIds: number[], me: string) {
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef<Row[]>([]);
  const loaded = useRef(new Set<number>());
  const fetched = useRef(new Set<number>());
  loaded.current = new Set(messageIds);

  const set = useCallback((next: Row[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);
  const put = useCallback((r: Row) => set([...rowsRef.current.filter((x) => !same(x, r)), r]), [set]);
  const drop = useCallback((r: Pick<Row, 'message_id' | 'user_id'>) => set(rowsRef.current.filter((x) => !same(x, r))), [set]);

  // 새로 보이는 메시지의 공감을 한 번 읽는다. 실패하면 다음에 id가 바뀔 때 다시 읽는다.
  const key = messageIds.join(',');
  useEffect(() => {
    if (!supabase) return;
    const fresh = messageIds.filter((i) => !fetched.current.has(i));
    if (!fresh.length) return;
    fresh.forEach((i) => fetched.current.add(i));
    void Promise.resolve(supabase.from('reactions').select('*').in('message_id', fresh)).then(
      ({ data, error }) => {
        if (error || !data) return fresh.forEach((i) => fetched.current.delete(i));
        set([...rowsRef.current.filter((x) => !data.some((d) => same(d, x))), ...data]);
      },
      () => fresh.forEach((i) => fetched.current.delete(i)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key가 messageIds의 내용이다
  }, [key, set]);

  useEffect(() => {
    if (!supabase) return;
    const c = supabase;
    // ponytail: 필터 없이 모든 방의 공감 이벤트를 받고 불러온 메시지만 거른다(RLS가 내 방 것만 준다). 방이 많아지면 메시지 id로 서버 필터.
    const ch = c
      .channel(`reactions:${roomId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, (p) => {
        if (p.eventType === 'DELETE') return drop(p.old as Row);
        const n = p.new as Row;
        if (loaded.current.has(n.message_id)) put(n);
      })
      .subscribe();
    return () => void c.removeChannel(ch);
  }, [roomId, put, drop]);

  const toggle = useCallback(
    async (messageId: number, emoji: Emoji) => {
      if (!supabase) throw new Error('no_supabase');
      const t = supabase.from.bind(supabase);
      const key = { message_id: messageId, user_id: me };
      const mine = rowsRef.current.find((x) => same(x, key));
      const op = nextReactionOp((mine?.emoji as Emoji | undefined) ?? null, emoji);
      const doInsert = async () => {
        const { error } = await t('reactions').insert({ ...key, emoji });
        if (error) {
          if (error.code === '23505') return doUpdate(false);
          throw error;
        }
        put({ ...key, emoji, created_at: '' });
      };
      const doUpdate = async (fallback = true): Promise<void> => {
        const { data, error } = await t('reactions').update({ emoji }).eq('message_id', messageId).eq('user_id', me).select('message_id');
        if (error) throw error;
        if (!data.length) {
          if (fallback) return doInsert2();
          throw new Error('reaction_gone');
        }
        put({ ...key, emoji, created_at: '' });
      };
      // 되돌려 한 번만 시도한다: update→insert는 다시 update로 돌아가지 않는다.
      const doInsert2 = async () => {
        const { error } = await t('reactions').insert({ ...key, emoji });
        if (error) throw error;
        put({ ...key, emoji, created_at: '' });
      };
      if (op.op === 'insert') return doInsert();
      if (op.op === 'update') return doUpdate();
      const { error } = await t('reactions').delete().eq('message_id', messageId).eq('user_id', me);
      if (error) throw error;
      drop(key);
    },
    [me, put, drop],
  );

  return { rows, toggle };
}
