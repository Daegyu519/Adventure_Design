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
      // supabase-js는 RLS·제약 위반을 던지지 않고 {error}로 준다. 개발 중에는 코드만 알린다(기록 실패가 조용히 사라지지 않게).
      const { error } = await c.from('tone_events').insert({ ...e, user_id: uid });
      if (error && __DEV__) console.warn(`[toneEvents] insert failed ${error.code}`);
    } catch {
      /* 기록 실패는 조용히 */
    }
  })();
}
