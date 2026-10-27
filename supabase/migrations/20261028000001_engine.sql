-- T-06a 엔진이 쓰는 제약·색인. 하소연 원문 칸은 없다.

-- 같은 사람이 같은 메시지로 털어놓기를 되풀이해도 한 번만 남긴다(apply_feedback의 on conflict).
create unique index if not exists feedback_log_reporter_message_key on tone.feedback_log (reporter_id, message_id);

-- 전체 패턴 수 = 서로 다른 신고자 수. 이 표에 처음 들어간 (trigger, 신고자)일 때만 global_patterns.count + 1.
-- trigger는 global_patterns와 같은 짧은 라벨 제약(문장이 통째로 들어올 자리가 없다).
create table if not exists tone.pattern_reporters (
  trigger text not null check (char_length(trigger) between 1 and 30),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (reporter_id, trigger)); -- reporter_id가 앞이라 FK(사용자 삭제 cascade)도 이 색인을 쓴다
-- 다른 tone 표처럼 service_role만, RLS도 켠다(정책 없음).
revoke all on tone.pattern_reporters from public, anon, authenticated;
grant all on tone.pattern_reporters to service_role;
alter table tone.pattern_reporters enable row level security;

create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);
create index if not exists messages_sender_created_idx on public.messages (sender_id, created_at desc); -- sent_messages
create index if not exists tone_events_user_kind_idx on public.tone_events (user_id, kind, created_at);
