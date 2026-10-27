import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { supabase } from './supabase';
import type { Tables } from './types/db';

type Profile = Tables<'profiles'>;
type Auth = { status: 'loading' | 'none' | 'in'; userId: string | null; email: string | null };
type SessionLike = { user: { id: string; email?: string } } | null;

export type SessionValue = Auth & {
  profile: Profile | null;
  profileStatus: 'loading' | 'missing' | 'ok';
  refreshProfile(): Promise<void>;
};

const Ctx = createContext<SessionValue | null>(null);

const toAuth = (s: SessionLike): Auth =>
  s ? { status: 'in', userId: s.user.id, email: s.user.email ?? null } : { status: 'none', userId: null, email: null };

// 키가 없으면(supabase === null) 곧바로 'none'. 게이트가 backend:false로 로그인 없이 앱을 연다.
export function SessionProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth>(() => (supabase ? { status: 'loading', userId: null, email: null } : toAuth(null)));
  // 읽은 행은 어느 사용자의 것인지 같이 들고 있다. 사용자가 바뀌면 이전 행은 보이지 않는다.
  const [loaded, setLoaded] = useState<{ userId: string; row: Profile | null } | null>(null);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    let evented = false; // 이벤트가 이미 상태를 정했다면 늦게 온 getSession 결과가 덮어쓰지 않는다
    const apply = (s: SessionLike) => setAuth(toAuth(s)); // 같은 사용자의 토큰 갱신은 userId가 같아 프로필을 다시 읽지 않는다
    // 콜백 안에서는 supabase 호출을 하지 않고 상태만 바꾼다(콜백 안의 await는 supabase-js 잠금과 교착할 수 있다).
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      evented = true;
      if (alive) apply(s);
    });
    supabase.auth
      .getSession()
      .then(({ data: d }) => alive && !evented && apply(d.session))
      .catch(() => alive && !evented && apply(null)); // 저장소를 못 읽으면 로그인 화면으로
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const loadProfile = useCallback(async (id: string) => {
    let row: Profile | null = null;
    try {
      // 읽기에 실패해도 'missing'으로 본다. 이름 화면의 insert는 이미 행이 있으면 기본 키 충돌로 실패하므로 덮어쓰지 않는다.
      row = (await supabase?.from('profiles').select('*').eq('id', id).maybeSingle())?.data ?? null;
    } catch {
      row = null;
    }
    if (userIdRef.current === id) setLoaded({ userId: id, row }); // 그 사이 로그아웃·교체됐다면 버린다
  }, []);

  useEffect(() => {
    userIdRef.current = auth.userId;
    if (auth.userId) void loadProfile(auth.userId);
    return () => {
      userIdRef.current = null;
    };
  }, [auth.userId, loadProfile]);

  const refreshProfile = useCallback(async () => {
    if (userIdRef.current) await loadProfile(userIdRef.current);
  }, [loadProfile]);

  const value = useMemo<SessionValue>(() => {
    const mine = loaded && loaded.userId === auth.userId ? loaded : null;
    return { ...auth, profile: mine?.row ?? null, profileStatus: mine ? (mine.row ? 'ok' : 'missing') : 'loading', refreshProfile };
  }, [auth, loaded, refreshProfile]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession은 SessionProvider 안에서만 쓴다');
  return v;
}
