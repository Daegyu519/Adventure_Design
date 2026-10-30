import { supabase } from './supabase';
import type { Tables } from './types/db';

export const SEARCH_LIMIT = 50;

// ilike 패턴: 앞뒤 공백을 지우고 \ % _ 를 이스케이프해 글자 그대로 찾는다. 빈 검색어는 null.
// ponytail: 결과를 눌러 원문 위치로 이동은 대화방 ?at=<id>가 기존 인용 이동(불러오며 찾기)을 쓴다.
// PostgREST는 `*`도 와일드카드로 보고 이스케이프할 방법이 없다 → keepMatches로 클라이언트에서 한 번 더 거른다(LIMIT 안에서만).
export function ilikePattern(q: string): string | null {
  const t = q.trim();
  return t ? `%${t.replace(/[\\%_]/g, '\\$&')}%` : null;
}

export function highlight(text: string, q: string): { text: string; match: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const hay = text.toLowerCase();
  // toLowerCase가 길이를 바꾸는 글자(İ 등)는 위치가 어긋나므로 그대로 둔다.
  if (hay.length !== text.length) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  let i = 0;
  for (let j = hay.indexOf(needle); j >= 0; j = hay.indexOf(needle, i)) {
    if (j > i) out.push({ text: text.slice(i, j), match: false });
    out.push({ text: text.slice(j, j + needle.length), match: true });
    i = j + needle.length;
  }
  if (i < text.length) out.push({ text: text.slice(i), match: false });
  return out;
}

export const keepMatches = <T extends { text: string }>(rows: T[], q: string): T[] => rows.filter((r) => r.text.toLowerCase().includes(q.trim().toLowerCase()));

// 방 안 검색: 최신순 SEARCH_LIMIT개. 빈 검색어는 요청하지 않는다.
export async function searchMessages(roomId: string, q: string): Promise<Tables<'messages'>[]> {
  const pattern = ilikePattern(q);
  if (!pattern || !supabase) return [];
  const { data, error } = await supabase.from('messages').select('*').eq('room_id', roomId).ilike('text', pattern).order('id', { ascending: false }).limit(SEARCH_LIMIT);
  if (error) throw error;
  return keepMatches(data, q);
}
