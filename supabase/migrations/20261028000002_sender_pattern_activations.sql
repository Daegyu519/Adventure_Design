-- T-24 보낸 사람 패턴을 활성 시각별 행으로 둔다.
-- 신고는 자기 active_from(다음 날 0시, Asia/Seoul) 행에만 쌓인다. 이미 켜진 행은 건드리지 않으므로
-- 재신고가 켜져 있던 패턴을 다음 날까지 꺼 버리지 않는다. 읽을 때는 active_from <= now인 행을
-- trigger별로 묶어 count는 합, strength는 count 가중 평균으로 본다(app/db.py PgRepo.sender_patterns).
alter table tone.sender_patterns drop constraint sender_patterns_pkey;
alter table tone.sender_patterns add primary key (sender_id, relation, trigger, active_from);
