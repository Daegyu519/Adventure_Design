-- T-35 거울 카드 하나(사용자, 종류, 출처)의 답은 한 줄만 남긴다. 엔진은 `on conflict do nothing`으로 쓴다:
-- 같은 카드에 동시에 두 번 답해도(읽고-쓰기 경합) 첫 답만 남고, 다시 답해도 기록은 바뀌지 않는다.
-- 혹시 이미 겹친 줄이 있으면 가장 먼저 남은 줄(id가 작은 것)만 둔다.
delete from public.mirror_attempts a
  using public.mirror_attempts b
  where a.user_id = b.user_id and a.kind = b.kind and a.card_ref = b.card_ref and a.id > b.id;
create unique index mirror_attempts_once on public.mirror_attempts (user_id, kind, card_ref);
