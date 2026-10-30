import { supabase } from './supabase';
import { tsMicros } from './messages';
import type { Tables } from './types/db';

export type Member = { user_id: string; name: string; last_read_at: string | null; muted: boolean };
export type RoomListItem = {
  id: string;
  kind: string;
  title: string;
  relation: string;
  muted: boolean;
  unread: number;
  last: { text: string; isImage: boolean; created_at: string } | null;
  created_at: string;
};

export function roomTitle(room: Pick<Tables<'rooms'>, 'kind' | 'title'>, members: Pick<Member, 'user_id' | 'name'>[], me: string): string {
  if (room.kind === 'direct') return members.find((m) => m.user_id !== me)?.name ?? '대화방';
  return room.title || '대화방';
}

// 마지막 메시지 시각(없으면 방 만든 시각) 내림차순.
export function sortRooms(items: RoomListItem[]): RoomListItem[] {
  const key = (r: RoomListItem) => tsMicros(r.last?.created_at ?? r.created_at);
  return [...items].sort((a, b) => key(b) - key(a));
}

function db() {
  if (!supabase) throw new Error('no_supabase');
  return supabase;
}

export async function fetchRoomList(me: string): Promise<RoomListItem[]> {
  const c = db();
  const mine = await c.from('room_members').select('room_id,last_read_at,muted').eq('user_id', me);
  if (mine.error) throw mine.error;
  if (mine.data.length === 0) return [];
  const ids = mine.data.map((r) => r.room_id);
  const [rooms, mates] = await Promise.all([
    c.from('rooms').select('*').in('id', ids),
    c.from('room_members').select('room_id,user_id').in('room_id', ids),
  ]);
  if (rooms.error) throw rooms.error;
  if (mates.error) throw mates.error;
  const uids = [...new Set(mates.data.map((x) => x.user_id))];
  const profs = await c.from('profiles').select('id,name').in('id', uids);
  if (profs.error) throw profs.error;
  const nameOf = new Map(profs.data.map((p) => [p.id, p.name]));
  // ponytail: 방마다 쿼리 2개, 방이 20개를 넘으면 RPC 하나로
  const items = await Promise.all(
    rooms.data.map(async (room): Promise<RoomListItem> => {
      const mm = mine.data.find((r) => r.room_id === room.id)!;
      const members = mates.data.filter((x) => x.room_id === room.id).map((x) => ({ user_id: x.user_id, name: nameOf.get(x.user_id) ?? '' }));
      let unreadQ = c.from('messages').select('id', { count: 'exact', head: true }).eq('room_id', room.id).neq('sender_id', me);
      if (mm.last_read_at) unreadQ = unreadQ.gt('created_at', mm.last_read_at);
      const [lastQ, unread] = await Promise.all([
        c.from('messages').select('text,image_path,created_at').eq('room_id', room.id).order('id', { ascending: false }).limit(1),
        unreadQ,
      ]);
      if (lastQ.error) throw lastQ.error;
      if (unread.error) throw unread.error;
      const l = lastQ.data[0];
      return {
        id: room.id,
        kind: room.kind,
        title: roomTitle(room, members, me),
        relation: room.relation,
        muted: mm.muted,
        unread: unread.count ?? 0,
        last: l ? { text: l.text, isImage: !!l.image_path && !l.text, created_at: l.created_at } : null,
        created_at: room.created_at,
      };
    }),
  );
  return sortRooms(items);
}

export async function fetchRoom(id: string): Promise<{ room: Tables<'rooms'>; members: Member[] }> {
  const c = db();
  const [room, mem] = await Promise.all([c.from('rooms').select('*').eq('id', id).single(), c.from('room_members').select('user_id,last_read_at,muted').eq('room_id', id)]);
  if (room.error) throw room.error;
  if (mem.error) throw mem.error;
  const profs = await c.from('profiles').select('id,name').in('id', mem.data.map((m) => m.user_id));
  if (profs.error) throw profs.error;
  const nameOf = new Map(profs.data.map((p) => [p.id, p.name]));
  return { room: room.data, members: mem.data.map((m) => ({ ...m, name: nameOf.get(m.user_id) ?? '' })) };
}

// 읽은 시각은 클라이언트 시계가 아니라 서버가 본 마지막 메시지의 created_at이다(`at`). 시계가 틀려도 안 읽은 수가 어긋나지 않는다.
export async function markRead(roomId: string, me: string, at: string): Promise<void> {
  const { error } = await db().from('room_members').update({ last_read_at: at }).eq('room_id', roomId).eq('user_id', me);
  if (error) throw error;
}
