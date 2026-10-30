-- T-28a 보강: 같은 기기(같은 토큰)를 다른 사용자가 등록하면 이전 사용자의 행을 정리한다.
-- 로그아웃 때 해제가 실패해도(오프라인) 이전 사용자의 알림 미리보기가 다음 사용자에게 가지 않게 한다.
-- RLS는 남의 행을 못 지우므로 SECURITY DEFINER. 토큰이 정확히 같은 행만 정리하고 다른 토큰은 건드리지 않는다.

create function public.register_push_token(p_token text, p_platform text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated'; end if;
  delete from public.push_tokens where token = p_token and user_id <> me;
  insert into public.push_tokens(user_id, token, platform) values (me, p_token, p_platform)
    on conflict (user_id, token) do update set platform = excluded.platform;
end $$;

revoke all on function public.register_push_token(text, text) from public, anon, authenticated;
grant execute on function public.register_push_token(text, text) to authenticated;
