import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { supabase } from './supabase';
import type { Tables } from './types/db';

type Profile = Tables<'profiles'>;
type Auth = { status: 'loading' | 'none' | 'in'; userId: string | null; email: string | null };
type SessionLike = { user: { id: string; email?: string } } | null;

export type SessionValue = Auth & {
  profile: Profile | null;
  profileStatus: 'loading' | 'missing' | 'ok';
  // 읽기 자체가 실패했다(오프라인 등). 이때 profileStatus는 'missing'이지만 "행이 없다"는 뜻이 아니다. 화면은 이름 입력 대신 다시 불러오기를 보여 준다.
  profileFailed: boolean;
  refreshProfile(): Promise<void>; // 결과는 상태(profile·profileStatus·profileFailed)로 알린다
};

const Ctx = createContext<SessionValue | null>(null);

const toAuth = (s: SessionLike): Auth =>
  s ? { status: 'in', userId: s.user.id, email: s.user.email ?? null } : { status: 'none', userId: null, email: null };

// 키가 없으면(supabase === null) 곧바로 'none'. 게이트가 backend:false로 로그인 없이 앱을 연다.
export function SessionProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Auth>(() => (supabase ? { status: 'loading', userId: null, email: null } : toAuth(null)));
  // 읽은 행은 어느 사용자의 것인지 같이 들고 있다. 사용자가 바뀌면 이전 행은 보이지 않는다.
  const [loaded, setLoaded] = useState<{ userId: string; row: Profile | null; failed: boolean } | null>(null);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    let evented = false; // 이벤트가 이미 상태를 정했다면 늦게 온 getSession 결과가 덮어쓰지 않는다
    const apply = (s: SessionLike) => {
      setAuth(toAuth(s)); // 같은 사용자의 토큰 갱신은 userId가 같아 프로필을 다시 읽지 않는다
      if (!s) setLoaded(null); // 로그아웃하면 읽어 둔 행도 지운다(같은 사람이 다시 들어와도 새로 읽는다)
    };
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
    if (!supabase) return;
    let row: Profile | null = null;
    let failed = false;
    try {
      const res = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();
      failed = res.error !== null;
      row = failed ? null : res.data;
    } catch {
      failed = true;
    }
    if (userIdRef.current === id) setLoaded({ userId: id, row, failed }); // 그 사이 로그아웃·교체됐다면 버린다
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
    return {
      ...auth,
      profile: mine?.row ?? null,
      profileStatus: mine ? (mine.row ? 'ok' : 'missing') : 'loading',
      profileFailed: mine?.failed ?? false,
      refreshProfile,
    };
  }, [auth, loaded, refreshProfile]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession은 SessionProvider 안에서만 쓴다');
  return v;
}
