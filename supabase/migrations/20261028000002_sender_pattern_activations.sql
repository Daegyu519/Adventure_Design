-- T-24 보낸 사람 패턴을 활성 시각별 행으로 둔다.
-- 신고는 자기 active_from(다음 날 0시, Asia/Seoul) 행에만 쌓인다. 이미 켜진 행은 건드리지 않으므로
-- 재신고가 켜져 있던 패턴을 다음 날까지 꺼 버리지 않는다. 읽을 때는 active_from <= now인 행을
-- trigger별로 묶어 count는 합, strength는 count 가중 평균으로 본다(app/db.py PgRepo.sender_patterns).
alter table tone.sender_patterns drop constraint sender_patterns_pkey;
alter table tone.sender_patterns add primary key (sender_id, relation, trigger, active_from);

-- 보낸 사람 패턴의 count = (보낸 사람, 관계, 신호)마다 서로 다른 신고자 수(규칙 7: 한 사람의 되풀이로 알림 기준을 넘지 않게).
-- 이 표에 처음 들어간 신고자일 때만 sender_patterns.count + 1(apply_feedback의 같은 트랜잭션).
-- 누가 누구를 신고했는지 잇는 표라 다른 tone 표처럼 service_role만, RLS도 켠다(정책 없음).
create table tone.sender_pattern_reporters (
  sender_id uuid not null references public.profiles(id) on delete cascade,
  relation text not null check (relation in ('친구', '팀원', '선후배', '기타')),
  trigger text not null check (char_length(trigger) between 1 and 30),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (sender_id, relation, trigger, reporter_id));
create index on tone.sender_pattern_reporters (reporter_id); -- 신고자 삭제 cascade
revoke all on tone.sender_pattern_reporters from public, anon, authenticated;
grant all on tone.sender_pattern_reporters to service_role;
alter table tone.sender_pattern_reporters enable row level security;
