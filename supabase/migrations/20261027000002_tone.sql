-- T-03b tone 스키마(엔진 전용) + 앱이 쓰는 tone_events · mirror_attempts · push_tokens.
-- T-03a처럼 기본 grant를 걷고 필요한 것만 다시 준다. 하소연·초안 원문을 담는 칸은 어디에도 없다.

-- ── tone 스키마: 앱(anon·authenticated)은 접근 불가, service_role(엔진)만 ─────────

create schema tone;
revoke all on schema tone from public, anon, authenticated;
grant usage on schema tone to service_role;

-- 하소연 1건의 결과. 원문은 메모리에서만 쓰고 버리므로 문장 칸이 없다(규칙 5).
create table tone.feedback_log (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  message_id bigint references public.messages(id) on delete set null,
  usable boolean not null,
  pattern_count int not null default 0 check (pattern_count >= 0),
  created_at timestamptz not null default now()
);
create index on tone.feedback_log(reporter_id, created_at); -- 관계별 주간 상한(T-24)

-- 보낸 사람 패턴. 모든 방의 하소연이 들어온다(규칙 14, 2026-10-31 변경).
-- trigger는 짧은 패턴 태그다. 길이 상한으로 하소연 문장이 통째로 들어오는 것을 막는다.
create table tone.sender_patterns (
  sender_id uuid not null references public.profiles(id) on delete cascade,
  relation text not null check (relation in ('친구', '팀원', '선후배', '기타')),
  trigger text not null check (char_length(trigger) between 1 and 30),
  count int not null default 1 check (count >= 1),
  strength real not null default 1 check (strength between 1 and 3), -- L4 강도 1~3의 이동 평균
  feeling text check (feeling in ('차갑게', '성의없게', '화나게', '무난하게', '따뜻하게')),
  active_from timestamptz not null, -- 이 시각 전에는 반영하지 않는다(다음 날 0시)
  updated_at timestamptz not null default now(),
  primary key (sender_id, relation, trigger)
);

create table tone.global_patterns (
  trigger text primary key check (char_length(trigger) between 1 and 30),
  count int not null default 0 check (count >= 0)
);

create table tone.baselines (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  avg_len real check (avg_len >= 0),
  polite_rate real check (polite_rate between 0 and 1),
  softener_rate real check (softener_rate between 0 and 1),
  n int not null default 0 check (n >= 0)
);

-- trace: 겉 신호와 전문가 출력만. 초안·최근 대화 문장 칸이 없고, experts는 크기를 제한한다.
create table tone.analysis_traces (
  trace_id uuid primary key default gen_random_uuid(),
  -- 털어놓기(feedback) 경로는 일부러 trace를 남기지 않는다(규칙 5: 하소연 흔적 금지). 결과는 feedback_log에만.
  path text not null check (path in ('hint', 'detail', 'mirror')),
  user_id uuid not null references public.profiles(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade, -- 거울 경로는 방이 없다
  experts jsonb not null default '[]'
    check (jsonb_typeof(experts) in ('array', 'object') and octet_length(experts::text) <= 16384),
  risk real check (risk between 0 and 1), -- 기권이면 null
  alert boolean not null,
  latency_ms int not null check (latency_ms >= 0),
  created_at timestamptz not null default now()
);
create index on tone.analysis_traces(user_id, created_at);

-- tone 표는 service_role만. RLS도 켜 두어(정책 없음) 권한이 잘못 새어도 행이 안 보이게 한다.
revoke all on all tables in schema tone from public, anon, authenticated;
revoke all on all sequences in schema tone from public, anon, authenticated;
grant all on all tables in schema tone to service_role;
alter table tone.feedback_log enable row level security;
alter table tone.sender_patterns enable row level security;
alter table tone.global_patterns enable row level security;
alter table tone.baselines enable row level security;
alter table tone.analysis_traces enable row level security;

-- ── public.push_tokens: 본인만 ──────────────────────────────

create table public.push_tokens (
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null check (char_length(token) between 1 and 2048),
  platform text not null check (platform in ('ios', 'android', 'web')),
  updated_at timestamptz not null default now(),
  primary key (user_id, token),
  -- web이면 token은 웹 푸시 구독 JSON이다: endpoint가 https 주소인 객체.
  -- case로 쓴다: or는 평가 순서를 보장하지 않아 web이 아닌 토큰에도 JSON 변환이 돌 수 있다.
  -- JSON이 아니면 변환 오류로 insert가 거절되고, endpoint가 없으면 coalesce가 false로 막는다.
  constraint push_tokens_web_subscription check (
    case when platform = 'web'
      then coalesce((token::jsonb ->> 'endpoint') ~ '^https://', false)
      else true end)
);

-- updated_at은 서버 시계로만 정한다. 클라이언트가 값을 과거·미래로 넣어도 덮어쓴다(upsert의 DO UPDATE 포함).
create function public.push_tokens_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger push_tokens_touch before insert or update on public.push_tokens
  for each row execute function public.push_tokens_touch();

-- ── public.tone_events: 본인 행 insert(방 멤버일 때)·select만 ──────────

create table public.tone_events (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('hint_shown', 'detail_opened', 'option_chosen', 'sent_with_hint', 'sent_after_fix')),
  risk real check (risk between 0 and 1),
  top_reading text check (top_reading in ('차갑게', '성의없게', '화나게', '무난하게', '따뜻하게')),
  signals jsonb check (signals is null or (jsonb_typeof(signals) = 'object' and octet_length(signals::text) <= 2000)),
  choice text check (choice in ('A', 'B', 'original')),
  created_at timestamptz not null default now()
);
create index on public.tone_events(user_id, created_at);

-- ── public.mirror_attempts: 엔진만 쓰고 본인은 읽기만. 문장 원문 칸 없음 ───

create table public.mirror_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('roleplay', 'receive', 'predict')),
  card_ref text not null check (char_length(card_ref) between 1 and 200), -- 카드 참조값이지 문장이 아니다
  answer_score smallint check (answer_score between 1 and 5),
  predicted smallint check (predicted between 1 and 5),
  panel_bin smallint check (panel_bin between 1 and 5),
  gap smallint check (gap between 0 and 4),
  created_at timestamptz not null default now()
);
create index on public.mirror_attempts(user_id, created_at);

-- ── 권한 ────────────────────────────────────────────────

revoke all on public.push_tokens, public.tone_events, public.mirror_attempts from anon, authenticated;
revoke all on sequence public.tone_events_id_seq, public.mirror_attempts_id_seq from anon, authenticated;
-- 트리거 함수는 발화할 때 EXECUTE 권한을 보지 않으므로 직접 호출만 막으면 된다.
revoke all on function public.push_tokens_touch() from public, anon, authenticated;

-- supabase-js .upsert()는 PostgREST가 payload의 모든 칸을 `ON CONFLICT DO UPDATE SET`에 넣으므로
-- 그 칸들의 UPDATE 권한이 있어야 첫 등록부터 된다. user_id를 남에게 옮기는 것은 update 정책의 with check가,
-- 값 형식은 check 제약이 그대로 막는다.
-- insert에도 updated_at을 열어 둔다: payload에 시각이 있어도 실패하지 않고, 트리거가 서버 시각으로 덮는다.
grant select, insert (user_id, token, platform, updated_at), update (user_id, token, platform, updated_at), delete on public.push_tokens to authenticated;
grant select, insert (room_id, user_id, kind, risk, top_reading, signals, choice) on public.tone_events to authenticated;
grant select on public.mirror_attempts to authenticated; -- insert는 엔진(service_role)

-- ── RLS ─────────────────────────────────────────────────

alter table public.push_tokens enable row level security;
alter table public.tone_events enable row level security;
alter table public.mirror_attempts enable row level security;

create policy push_tokens_select on public.push_tokens for select to authenticated
  using (user_id = (select auth.uid()));
create policy push_tokens_insert on public.push_tokens for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy push_tokens_update on public.push_tokens for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy push_tokens_delete on public.push_tokens for delete to authenticated
  using (user_id = (select auth.uid()));

create policy tone_events_select on public.tone_events for select to authenticated
  using (user_id = (select auth.uid()));
create policy tone_events_insert on public.tone_events for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_member(room_id));

create policy mirror_attempts_select on public.mirror_attempts for select to authenticated
  using (user_id = (select auth.uid()));
