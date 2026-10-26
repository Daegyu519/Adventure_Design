-- T-03a 채팅 스키마 + RLS.
-- 앱은 사용자 JWT로 직접 쓰므로 RLS와 아래 권한(grant)이 곧 인가 계층이다.
-- 오류 메시지는 앱이 한국어 문구로 바꿔 보여 줄 코드다(invite_expired 등).

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 20),
  tone_hint_on boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct', 'group')),
  -- 제목은 그룹만. 길이 30은 임의 상한(남용 방지).
  title text check (title is null or (kind = 'group' and char_length(title) between 1 and 30)),
  relation text not null check (relation in ('친구', '팀원', '선후배', '기타')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  muted boolean not null default false,
  primary key (room_id, user_id)
);
create index on public.room_members(user_id);

create table public.messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  text text not null default '' check (char_length(text) <= 2000),
  image_path text,
  reply_to bigint references public.messages(id) on delete set null,
  mentions uuid[] not null default '{}' check (cardinality(mentions) <= 8),
  created_at timestamptz not null default now(),
  check (text <> '' or image_path is not null),
  -- 사진은 Storage chat-images의 room_id/<파일 이름> 한 단계만. 하위 폴더·'..' 금지(경로 탈출 차단)
  constraint messages_image_path_room check (image_path is null or (
    image_path ~ ('^' || room_id::text || '/[A-Za-z0-9_-][A-Za-z0-9._-]*$') and image_path !~ '\.\.'))
);
create index on public.messages(room_id, id);

create table public.reactions (
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (emoji in ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table public.invites (
  code text primary key,
  inviter_id uuid not null references public.profiles(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade, -- null = 1:1 초대
  relation text not null check (relation in ('친구', '팀원', '선후배', '기타')),
  max_uses int not null,
  uses int not null default 0 check (uses between 0 and max_uses),
  expires_at timestamptz not null
);

-- ── 함수 ────────────────────────────────────────────────

create function public.is_member(room uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.room_members m
    where m.room_id = is_member.room and m.user_id = auth.uid()
  )
$$;

create function public.create_group(title text, relation text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
  rid uuid;
begin
  if me is null then raise exception 'not_authenticated'; end if;
  insert into public.rooms(kind, title, relation, created_by)
    values ('group', create_group.title, create_group.relation, me)
    returning id into rid;
  insert into public.room_members(room_id, user_id) values (rid, me);
  return rid;
end $$;

create function public.create_invite(room uuid default null, relation text default '친구') returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
  rel text := create_invite.relation;
  b bytea;
  c text;
begin
  if me is null then raise exception 'not_authenticated'; end if;
  if room is not null then
    -- 그룹 초대: 멤버만, 관계는 방의 것을 따른다
    if not public.is_member(room) then raise exception 'not_member'; end if;
    select r.relation into rel from public.rooms r where r.id = room and r.kind = 'group';
    if not found then raise exception 'not_group'; end if;
  end if;
  -- ponytail: 8자(36^8 ≈ 2.8조) 길이만으로 추측을 막는다. 사용자별 시도 횟수 제한은 없다.
  -- 수업 밖으로 가입을 열기 전에 accept_invite에 시도 카운터를 넣을 것.
  loop
    -- gen_random_uuid()는 강한 난수(pg_strong_random). 6·8번 바이트는 버전·변형 비트라 뺀다.
    -- 252(=36×7) 이상인 바이트는 버려서 % 36의 나머지 편향을 없앤다.
    b := uuid_send(gen_random_uuid());
    select string_agg(substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', get_byte(b, i) % 36 + 1, 1), '' order by i)
      into c from (
        select i from generate_series(0, 15) i
        where i not in (6, 8) and get_byte(b, i) < 252 order by i limit 8
      ) s;
    continue when coalesce(length(c), 0) < 8;
    begin
      insert into public.invites(code, inviter_id, room_id, relation, max_uses, expires_at)
        values (c, me, room, rel, case when room is null then 1 else 7 end, now() + interval '72 hours');
      return c;
    exception when unique_violation then
      -- 코드 충돌이면 다시 뽑는다
    end;
  end loop;
end $$;

create function public.accept_invite(code text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
  inv public.invites;
  rid uuid;
begin
  if me is null then raise exception 'not_authenticated'; end if;
  -- 행을 잠가 동시 수락이 uses를 넘기지 못하게 한다
  select * into inv from public.invites i where i.code = upper(btrim(accept_invite.code)) for update;
  if not found then raise exception 'invite_not_found'; end if;

  if inv.room_id is null then
    if inv.inviter_id = me then raise exception 'invite_self'; end if;
    -- 같은 두 사람의 동시 수락(서로 다른 초대)이 방을 두 개 만들지 않게 짝 단위로 잠근다
    perform pg_advisory_xact_lock(hashtextextended(least(me, inv.inviter_id)::text || greatest(me, inv.inviter_id)::text, 0));
    select r.id into rid from public.rooms r
      join public.room_members a on a.room_id = r.id and a.user_id = inv.inviter_id
      join public.room_members b on b.room_id = r.id and b.user_id = me
      where r.kind = 'direct' limit 1;
  elsif exists (select 1 from public.room_members m where m.room_id = inv.room_id and m.user_id = me) then
    rid := inv.room_id;
  end if;
  -- 이미 그 방에 있으면 만료·소진된 코드여도 방을 돌려준다(새로 생기는 권한이 없다)
  if rid is not null then return rid; end if;

  if inv.expires_at <= now() then raise exception 'invite_expired'; end if;
  if inv.uses >= inv.max_uses then raise exception 'invite_used'; end if;
  if inv.room_id is null then
    insert into public.rooms(kind, relation, created_by)
      values ('direct', inv.relation, inv.inviter_id) returning id into rid;
    insert into public.room_members(room_id, user_id) values (rid, inv.inviter_id), (rid, me);
  else
    rid := inv.room_id;
    insert into public.room_members(room_id, user_id) values (rid, me); -- 인원 상한은 트리거
  end if;

  update public.invites i set uses = i.uses + 1 where i.code = inv.code;
  return rid;
end $$;

-- 인원 상한(1:1 2명, 그룹 8명). 어느 경로로 넣든 걸리게 트리거로 둔다.
-- 방 행을 잠가 동시 참여를 한 줄로 세운다. for no key update라 메시지·반응 insert의
-- FK 검사(KEY SHARE)는 막지 않는다. READ COMMITTED(Supabase 기본)에 기댄다: 잠금을 얻은 뒤
-- count가 새 스냅숏으로 돌아 먼저 커밋된 참여를 본다. REPEATABLE READ 이상이면 상한이 샐 수 있다.
create function public.room_members_cap() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  k text;
  n int;
begin
  select r.kind into k from public.rooms r where r.id = new.room_id for no key update;
  select count(*) into n from public.room_members m where m.room_id = new.room_id;
  if n >= (case k when 'direct' then 2 else 8 end) then raise exception 'room_full'; end if;
  return new;
end $$;
create trigger room_members_cap before insert on public.room_members
  for each row execute function public.room_members_cap();

-- reply_to는 같은 방 메시지만, mentions는 그 방 멤버만. 호출자 권한으로 돈다(security definer 아님):
-- RLS 때문에 보낸 사람이 볼 수 있는 메시지·멤버만 찾으므로 다른 방 정보가 새지 않는다.
create function public.check_message() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.reply_to is not null and not exists (
    select 1 from public.messages m where m.id = new.reply_to and m.room_id = new.room_id
  ) then
    raise exception 'reply_to_other_room';
  end if;
  if not new.mentions <@ array(select m.user_id from public.room_members m where m.room_id = new.room_id) then
    raise exception 'mention_not_member';
  end if;
  return new;
end $$;
create trigger check_message before insert on public.messages
  for each row execute function public.check_message();

-- ── 권한: 기본 grant all을 걷고 필요한 것만 다시 준다 ──────────

revoke all on public.profiles, public.rooms, public.room_members,
  public.messages, public.reactions, public.invites from anon, authenticated;
-- identity는 시퀀스 권한 없이도 insert된다. 남겨 두면 setval()로 id를 되감을 수 있다.
revoke all on sequence public.messages_id_seq from anon, authenticated;

grant select, insert (id, name, tone_hint_on), update (name, tone_hint_on) on public.profiles to authenticated;
grant select on public.rooms, public.invites to authenticated;
grant select, update (last_read_at, muted) on public.room_members to authenticated;
grant select, insert (room_id, sender_id, text, image_path, reply_to, mentions) on public.messages to authenticated;
grant select, insert (message_id, user_id, emoji), update (emoji), delete on public.reactions to authenticated;

revoke all on function public.is_member(uuid), public.create_group(text, text),
  public.create_invite(uuid, text), public.accept_invite(text),
  public.room_members_cap(), public.check_message() from public, anon, authenticated;
grant execute on function public.is_member(uuid), public.create_group(text, text),
  public.create_invite(uuid, text), public.accept_invite(text) to authenticated, service_role;
-- 트리거 함수는 발화할 때 EXECUTE 권한을 보지 않으므로 다시 줄 필요가 없다.

-- ── RLS ─────────────────────────────────────────────────

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;
alter table public.reactions enable row level security;
alter table public.invites enable row level security;

create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid())
  or exists (select 1 from public.room_members m where m.user_id = profiles.id and public.is_member(m.room_id))
);
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy rooms_select on public.rooms for select to authenticated
  using (public.is_member(id));

create policy room_members_select on public.room_members for select to authenticated
  using (public.is_member(room_id));
create policy room_members_update on public.room_members for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy messages_select on public.messages for select to authenticated
  using (public.is_member(room_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and public.is_member(room_id));

create policy reactions_select on public.reactions for select to authenticated
  using (public.is_member((select m.room_id from public.messages m where m.id = message_id)));
create policy reactions_insert on public.reactions for insert to authenticated
  with check (user_id = (select auth.uid())
    and public.is_member((select m.room_id from public.messages m where m.id = message_id)));
create policy reactions_update on public.reactions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy reactions_delete on public.reactions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy invites_select on public.invites for select to authenticated
  using (inviter_id = (select auth.uid()));
