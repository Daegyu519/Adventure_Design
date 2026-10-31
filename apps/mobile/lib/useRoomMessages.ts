import { useCallback, useEffect, useRef, useState } from 'react';

import { mergeMessages, PAGE_SIZE, type Msg } from './messages';
import { freshTopic, watchStatus } from './realtime';
import { supabase } from './supabase';
import type { TablesInsert } from './types/db';

export type SendInput = Pick<TablesInsert<'messages'>, 'text' | 'reply_to' | 'image_path' | 'mentions'>;
export type SendError = Error & { status?: number };

// 방 하나의 메시지. 모든 경로(첫 페이지, Realtime, 재연결 따라잡기, 이전 페이지, 내 insert 응답)가 mergeMessages 한 길로 들어온다.
export function useRoomMessages(roomId: string, me: string) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const hasMoreRef = useRef(false);
  const [gen, setGen] = useState(0); // 다시 불러오기마다 채널을 새로 연다(서버가 닫은 채널은 다시 들어가지 않는다)
  const ref = useRef<Msg[]>([]);
  const loading = useRef(false);
  // 따라잡기의 기준은 "가져와서 확인한" 가장 큰 id다. Realtime으로 받은 id는 올리지 않는다:
  // 동시에 커밋된 71이 72보다 늦게 오거나 끊긴 사이 빠졌어도, 72를 기준으로 삼으면 71을 영영 못 채운다.
  // ponytail: 재연결 때 마지막으로 가져온 뒤의 것을 다시 받는다(중복은 merge가 지운다). 세션이 아주 길면 마지막 확인 지점을 Realtime으로도 올리는 쪽으로.
  const synced = useRef<number | null>(null);

  const add = useCallback((xs: Msg[]) => {
    ref.current = mergeMessages(ref.current, xs);
    setMessages(ref.current);
  }, []);

  // 방이 바뀔 때만 비운다(다시 구독할 때는 불러 둔 것을 두고 빈 구간만 채운다).
  useEffect(() => {
    ref.current = [];
    synced.current = null;
    setMessages([]);
    setHasMore(false);
    hasMoreRef.current = false;
    setError(false);
    setOlderError(false);
  }, [roomId]);

  useEffect(() => {
    if (!supabase) return;
    const c = supabase;
    let alive = true;
    let down = false; // Realtime이 끊긴 동안은 가져오기가 성공해도 오류 줄을 둔다(새 메시지가 안 온다)

    // SUBSCRIBED가 될 때마다(첫 연결 포함) 호출: 아직 아무것도 없으면 첫 페이지, 있으면 가장 새 id 뒤의 빈 구간.
    const catchUp = async () => {
      const newest = synced.current;
      const q = c.from('messages').select('*').eq('room_id', roomId);
      let res;
      try {
        res = newest === null ? await q.order('id', { ascending: false }).limit(PAGE_SIZE) : await q.gt('id', newest).order('id', { ascending: true });
      } catch {
        res = { data: null, error: { message: 'throw' } }; // 연결이 끊겨 던진 것도 오류 응답처럼 다룬다
      }
      if (!alive) return;
      const { data, error: e } = res;
      if (e || !data) {
        if (newest === null) setError(true);
        return;
      }
      if (!down) setError(false);
      if (newest === null) {
        hasMoreRef.current = data.length === PAGE_SIZE;
        setHasMore(hasMoreRef.current);
      }
      if (data.length) synced.current = Math.max(newest ?? 0, ...data.map((x) => x.id));
      else if (newest === null) synced.current = 0; // 빈 방: 이후 따라잡기는 id > 0
      add(data);
    };

    const channel = c
      .channel(freshTopic(`room:${roomId}`))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, (p) => alive && add([p.new as Msg]))
      .subscribe((s) =>
        alive &&
        watchStatus(
          s,
          'room',
          () => {
            down = false;
            void catchUp();
          },
          () => {
            down = true;
            setError(true);
          },
        ),
      );
    void catchUp(); // 첫 페이지는 Realtime 연결을 기다리지 않는다(연결이 안 돼도 대화는 보인다). 중복은 merge가 지운다.
    return () => {
      alive = false;
      void c.removeChannel(channel);
    };
  }, [roomId, add, gen]);

  // 실패해도 던지지 않는다: olderError로 알리고, 호출한 쪽(다시 불러오기 줄)이 다시 부른다.
  const loadOlder = useCallback(async () => {
    if (!supabase || loading.current || !hasMoreRef.current || ref.current.length === 0) return;
    loading.current = true;
    try {
      const { data, error: e } = await supabase.from('messages').select('*').eq('room_id', roomId).lt('id', ref.current[0].id).order('id', { ascending: false }).limit(PAGE_SIZE);
      if (e || !data) {
        setOlderError(true);
        return;
      }
      setOlderError(false);
      hasMoreRef.current = data.length === PAGE_SIZE;
      setHasMore(hasMoreRef.current);
      add(data);
    } catch {
      setOlderError(true);
    } finally {
      loading.current = false;
    }
  }, [roomId, add]);

  // 오류 줄의 다시 불러오기: 채널을 새로 구독하고 첫 페이지(또는 빈 구간)를 다시 가져온다.
  const reload = useCallback(() => setGen((g) => g + 1), []);

  // 엔진을 부르지 않는다(규칙 11). 실패하면 status를 단 Error를 던진다 — 호출한 쪽이 문구를 고른다.
  const send = useCallback(
    async (m: SendInput): Promise<Msg> => {
      if (!supabase) throw new Error('no_supabase');
      const { data, error: e, status } = await supabase.from('messages').insert({ ...m, room_id: roomId, sender_id: me }).select().single();
      if (e) throw Object.assign(new Error(e.message), { status });
      add([data]);
      return data;
    },
    [roomId, me, add],
  );

  return { messages, hasMore, error, olderError, reload, loadOlder, send };
}
