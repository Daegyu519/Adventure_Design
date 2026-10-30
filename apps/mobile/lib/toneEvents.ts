import { supabase } from './supabase';
import type { TablesInsert } from './types/db';

// tone_events 기록(힌트 표시·보냄). 기록은 대화를 막지 않는다(규칙 11): await 안 함, 오류는 삼킨다.
// signals는 항상 객체(jsonb)로만 쓴다.
export function logToneEvent(e: Omit<TablesInsert<'tone_events'>, 'id' | 'user_id' | 'created_at'>): void {
  const c = supabase;
  if (!c) return;
  void (async () => {
    try {
      const uid = (await c.auth.getSession()).data.session?.user.id;
      if (!uid) return;
      await c.from('tone_events').insert({ ...e, user_id: uid });
    } catch {
      /* 기록 실패는 조용히 */
    }
  })();
}
