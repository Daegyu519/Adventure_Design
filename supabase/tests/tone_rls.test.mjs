import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, as, newUser } from './helpers.mjs'

const one = async (p) => (await p).rows[0]
const count = async (db, u, sql, params) => (await as(db, u, sql, params)).rows.length

// a, b는 1:1 방 멤버, c는 어느 방에도 없다.
async function abc() {
  const db = await freshDb()
  const [a, b, c] = [await newUser(db, 'A'), await newUser(db, 'B'), await newUser(db, 'C')]
  const code = (await one(as(db, a, 'select public.create_invite() as c'))).c
  const room = (await one(as(db, b, 'select public.accept_invite($1) as r', [code]))).r
  return { db, a, b, c, room }
}

const columns = async (db, schema, table) =>
  (await db.query(
    'select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position',
    [schema, table])).rows.map((r) => r.column_name)

const TONE_TABLES = ['feedback_log', 'sender_patterns', 'global_patterns', 'baselines', 'analysis_traces', 'pattern_reporters',
  'sender_pattern_reporters']

test('authenticated and anon cannot touch the tone schema', async () => {
  const { db, a, room } = await abc()
  for (const who of [a, 'anon']) {
    for (const t of TONE_TABLES) {
      await assert.rejects(as(db, who, `select * from tone.${t}`), /permission denied/)
      await assert.rejects(as(db, who, `delete from tone.${t}`), /permission denied/)
    }
    await assert.rejects(as(db, who, 'select * from tone.baselines'), /permission denied for schema tone/)
    await assert.rejects(as(db, who, 'insert into tone.global_patterns(trigger, count) values ($1, 1)', ['x']), /permission denied/)
    await assert.rejects(as(db, who, 'create table tone.x(i int)'), /permission denied/)
  }
  // 설정 실수로 표 권한이 새어도 스키마 USAGE가 없으면 막힌다(이중 방어)
  const { rows } = await db.query(
    `select r, has_schema_privilege(r, 'tone', 'usage') as u from unnest(array['anon', 'authenticated', 'service_role']) r`)
  assert.deepEqual(Object.fromEntries(rows.map((x) => [x.r, x.u])), { anon: false, authenticated: false, service_role: true })
  // 표마다 RLS도 켜져 있다
  const rls = await db.query(
    `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'tone' and c.relkind = 'r' and not c.relrowsecurity`)
  assert.deepEqual(rls.rows, [])
  assert.ok(room)
})

test('service_role can write tone tables', async () => {
  const { db, a, b, room } = await abc()
  const svc = (sql, params) => as(db, 'service', sql, params)
  await svc(
    `insert into tone.sender_patterns(sender_id, relation, trigger, count, strength, feeling, active_from)
     values ($1, '팀원', 'curt_reply', 2, 1.4, '차갑게', now() + interval '1 day')`, [a])
  // PK(sender_id, relation, trigger, active_from): 활성 시각마다 한 행. now()는 문장마다 달라 같은 키 검사에는 고정 시각을 쓴다
  const activation = (at) => svc(
    `insert into tone.sender_patterns(sender_id, relation, trigger, active_from) values ($1, '팀원', 'curt_reply', $2)`, [a, at])
  await activation('2026-10-01 00:00+09')
  await assert.rejects(activation('2026-10-01 00:00+09'), /duplicate key/)
  await activation('2026-10-02 00:00+09') // active_from만 다르면 별개 행
  await svc( // 같은 사람, 다른 관계는 별개 행
    `insert into tone.sender_patterns(sender_id, relation, trigger, active_from) values ($1, '친구', 'curt_reply', now())`, [a])
  await assert.rejects(svc(
    `insert into tone.sender_patterns(sender_id, relation, trigger, active_from) values ($1, '남', 'curt_reply', now())`, [a]),
  /check constraint/)
  // 패턴 태그는 짧은 라벨, 강도 1~3, 느낌은 읽힘 키만 — 문장이 통째로 들어갈 자리가 없다
  const pat = (trigger, strength, feeling) => svc(
    `insert into tone.sender_patterns(sender_id, relation, trigger, strength, feeling, active_from)
     values ($1, '기타', $2, $3, $4, now())`, [a, trigger, strength, feeling])
  await assert.rejects(pat('가'.repeat(31), 1, null), /check constraint/)
  await assert.rejects(pat('', 1, null), /check constraint/)
  await assert.rejects(pat('t', 4, null), /check constraint/)
  await assert.rejects(pat('t', 0.5, null), /check constraint/)
  await assert.rejects(pat('t', 1, '내 하소연 문장'), /check constraint/)
  await pat('이유 없는 거절', 2.5, '차갑게')
  await assert.rejects(svc(`insert into tone.global_patterns(trigger, count) values ($1, 1)`, ['가'.repeat(31)]), /check constraint/)
  await svc(`insert into tone.global_patterns(trigger, count) values ('curt_reply', 3)`)
  await svc('insert into tone.baselines(user_id, avg_len, polite_rate, softener_rate, n) values ($1, 12.5, 0.8, 0.1, 10)', [a])
  await assert.rejects(svc('insert into tone.pattern_reporters(trigger, reporter_id) values ($1, $2)', ['가'.repeat(31), b]),
    /check constraint/)
  await svc(`insert into tone.pattern_reporters(trigger, reporter_id) values ('curt_reply', $1)`, [b])
  // 보낸 사람 패턴의 신고자: (보낸 사람, 관계, 신호, 신고자)마다 한 번, 짧은 라벨·관계 값만
  const spr = (relation, trigger) => svc(
    `insert into tone.sender_pattern_reporters(sender_id, relation, trigger, reporter_id) values ($1, $2, $3, $4)`,
    [a, relation, trigger, b])
  await spr('팀원', 'curt_reply')
  await assert.rejects(spr('팀원', 'curt_reply'), /duplicate key/)
  await assert.rejects(spr('남', 'x'), /check constraint/)
  await assert.rejects(spr('팀원', '가'.repeat(31)), /check constraint/)
  await svc(
    `insert into tone.feedback_log(room_id, reporter_id, message_id, usable, pattern_count) values ($1, $2, null, true, 1)`,
    [room, b])
  await svc(
    `insert into tone.analysis_traces(path, user_id, room_id, experts, risk, alert, latency_ms)
     values ('hint', $1, $2, '[{"id":"tone_a","neg":0.7}]', 0.62, true, 840)`, [a, room])
  for (const t of TONE_TABLES) assert.ok((await svc(`select * from tone.${t}`)).rows.length >= 1, t)
  assert.equal((await svc('select * from tone.sender_patterns where active_from > now()')).rows.length, 1)
  // trace는 jsonb 크기 상한(문장 덩어리를 통째로 넣는 것을 막는다)
  await assert.rejects(svc(
    `insert into tone.analysis_traces(path, user_id, experts, alert, latency_ms) values ('hint', $1, $2, false, 1)`,
    [a, JSON.stringify([{ note: 'x'.repeat(17000) }])]), /check constraint/)
  await assert.rejects(svc(
    `insert into tone.analysis_traces(path, user_id, experts, alert, latency_ms) values ('chat', $1, '[]', false, 1)`, [a]),
  /check constraint/)
})

test('tone_events: own insert only, member room only', async () => {
  const { db, a, b, c, room } = await abc()
  const ins = (u, uid, kind = 'hint_shown', extra = '', vals = []) => as(db, u,
    `insert into public.tone_events(room_id, user_id, kind${extra ? ', ' + extra.split('=')[0] : ''})
     values ($1, $2, $3${extra ? ', ' + extra.split('=')[1] : ''}) returning id`, [room, uid, kind, ...vals])
  assert.ok((await one(ins(a, a))).id)
  await as(db, a,
    `insert into public.tone_events(room_id, user_id, kind, risk, top_reading, signals, choice)
     values ($1, $2, 'option_chosen', 0.71, '차갑게', '{"short":true}', 'A')`, [room, a])
  await assert.rejects(ins(a, b), /row-level security/) // 남의 이름으로
  await assert.rejects(ins(c, c), /row-level security/) // 비멤버
  await assert.rejects(ins('anon', a), /permission denied/)
  // 값 검사
  await assert.rejects(ins(a, a, 'typing'), /check constraint/)
  await assert.rejects(ins(a, a, 'option_chosen', 'choice=$4', ['C']), /check constraint/)
  await assert.rejects(ins(a, a, 'hint_shown', 'risk=$4', [1.5]), /check constraint/)
  await assert.rejects(ins(a, a, 'hint_shown', 'top_reading=$4', ['자유 문장']), /check constraint/) // 읽힘 키 다섯 개만
  await assert.rejects(ins(a, a, 'hint_shown', 'signals=$4', ['[1]']), /check constraint/) // 객체만
  await assert.rejects(ins(a, a, 'hint_shown', 'signals=$4', [JSON.stringify({ t: 'x'.repeat(2001) })]), /check constraint/)
  // 본인 것만 보인다
  assert.equal(await count(db, a, 'select * from public.tone_events'), 2)
  assert.equal(await count(db, b, 'select * from public.tone_events'), 0)
  assert.equal(await count(db, c, 'select * from public.tone_events'), 0)
  // 수정·삭제·id/created_at 지정·시퀀스 조작 모두 불가
  await assert.rejects(as(db, a, "update public.tone_events set kind = 'sent_with_hint'"), /permission denied/)
  await assert.rejects(as(db, a, 'delete from public.tone_events'), /permission denied/)
  await assert.rejects(as(db, a,
    "insert into public.tone_events(id, room_id, user_id, kind) values (999, $1, $2, 'hint_shown')", [room, a]), /permission denied|non-DEFAULT/) // generated always가 먼저 막기도 한다
  await assert.rejects(as(db, a, "select setval('public.tone_events_id_seq', 1)"), /permission denied/)
  // 엔진(service)은 어느 행이든 쓴다
  await as(db, 'service', "insert into public.tone_events(room_id, user_id, kind) values ($1, $2, 'detail_opened')", [room, b])
  assert.equal(await count(db, b, 'select * from public.tone_events'), 1)
})

test('mirror_attempts: own rows only for select; authenticated insert denied; service insert OK; gap range enforced', async () => {
  const { db, a, b, c } = await abc()
  let n = 0   // 카드 하나에 한 줄이라(unique) 넣을 때마다 다른 출처
  const ins = (uid, cols = '', vals = []) => as(db, 'service',
    `insert into public.mirror_attempts(user_id, kind, card_ref${cols ? ', ' + cols.split('|')[0] : ''})
     values ($1, 'predict', 'card-${++n}'${cols ? ', ' + cols.split('|')[1] : ''}) returning id`, [uid, ...vals])
  assert.ok((await one(ins(a, 'answer_score, predicted, panel_bin, gap|$2, $3, $4, $5', [null, 2, 4, 2]))).id)
  await ins(b)
  await ins(a, 'gap|$2', [0])
  await ins(a, 'gap|$2', [4])
  // 본인 행만 보인다
  assert.equal(await count(db, a, 'select * from public.mirror_attempts'), 3)
  assert.equal(await count(db, b, 'select * from public.mirror_attempts'), 1)
  assert.equal(await count(db, c, 'select * from public.mirror_attempts'), 0)
  await assert.rejects(as(db, 'anon', 'select * from public.mirror_attempts'), /permission denied/)
  // 앱(authenticated)은 쓰지 못한다 — 엔진만 쓴다
  await assert.rejects(as(db, a,
    "insert into public.mirror_attempts(user_id, kind, card_ref) values ($1, 'predict', 'c')", [a]), /permission denied/)
  await assert.rejects(as(db, a, 'update public.mirror_attempts set gap = 0'), /permission denied/)
  await assert.rejects(as(db, a, 'delete from public.mirror_attempts'), /permission denied/)
  await assert.rejects(as(db, a, "select setval('public.mirror_attempts_id_seq', 1)"), /permission denied/)
  // 범위
  await assert.rejects(ins(a, 'gap|$2', [5]), /check constraint/)
  await assert.rejects(ins(a, 'gap|$2', [-1]), /check constraint/)
  for (const col of ['answer_score', 'predicted', 'panel_bin']) {
    await assert.rejects(ins(a, `${col}|$2`, [0]), /check constraint/)
    await assert.rejects(ins(a, `${col}|$2`, [6]), /check constraint/)
    await ins(a, `${col}|$2`, [1])
    await ins(a, `${col}|$2`, [5])
  }
  await assert.rejects(as(db, 'service',
    "insert into public.mirror_attempts(user_id, kind, card_ref) values ($1, 'quiz', 'c')", [a]), /check constraint/)
  // (사용자, 종류, 출처)마다 한 줄. 엔진은 on conflict do nothing으로 써서 첫 답만 남긴다
  const once = "insert into public.mirror_attempts(user_id, kind, card_ref, gap) values ($1, 'receive', 'msg:1', $2)"
  await as(db, 'service', once, [a, 1])
  await assert.rejects(as(db, 'service', once, [a, 2]), /duplicate key/)
  await as(db, 'service', once + ' on conflict (user_id, kind, card_ref) do nothing', [a, 3])
  await as(db, 'service', once, [b, 4])   // 다른 사용자는 따로
  assert.deepEqual((await as(db, a, "select gap from public.mirror_attempts where card_ref = 'msg:1'")).rows, [{ gap: 1 }])
})

test('push_tokens: own rows only, platform web accepted', async () => {
  const { db, a, b } = await abc()
  const ins = (u, uid, token, platform) => as(db, u,
    'insert into public.push_tokens(user_id, token, platform) values ($1, $2, $3)', [uid, token, platform])
  const sub = JSON.stringify({ endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } })
  await ins(a, a, 'ExponentPushToken[xxx]', 'android')
  await ins(a, a, 'apns-token', 'ios')
  await ins(a, a, sub, 'web') // 웹 푸시 구독 JSON
  await assert.rejects(ins(a, a, sub, 'web'), /duplicate key/) // PK(user_id, token)
  // web이면 endpoint 문자열이 있는 JSON 객체여야 한다
  for (const bad of ['not json', '{}', '[]', '"endpoint"', '{"endpoint":1}', '{"keys":{}}', 'null', '{"endpoint":"http://x.example/a"}'])
    await assert.rejects(ins(a, a, bad, 'web'), /check constraint|invalid input syntax/, bad)
  await ins(a, a, 'not json', 'ios') // web이 아니면 JSON 검사 없음
  await assert.rejects(ins(a, a, 'tok', 'sms'), /check constraint/)
  await assert.rejects(ins(a, a, 'x'.repeat(2049), 'android'), /check constraint/)
  await assert.rejects(ins(a, a, '', 'android'), /check constraint/)
  // 남 것 못 만들고, 못 보고, 못 지운다
  await assert.rejects(ins(a, b, 'tok-b', 'android'), /row-level security/)
  await ins(b, b, 'tok-b', 'android')
  await assert.rejects(ins('anon', a, 'tok', 'android'), /permission denied/)
  assert.equal(await count(db, a, 'select * from public.push_tokens'), 4)
  assert.equal(await count(db, b, 'select * from public.push_tokens'), 1)
  assert.equal((await as(db, b, 'delete from public.push_tokens where user_id = $1', [a])).affectedRows, 0)
  // 갱신(upsert용): 본인 행만, 형식 제약은 그대로, 행을 남에게 넘길 수 없다
  assert.equal((await as(db, a, "update public.push_tokens set updated_at = now() where token = 'apns-token'")).affectedRows, 1)
  assert.equal((await as(db, b, "update public.push_tokens set updated_at = now() where token = 'apns-token'")).affectedRows, 0)
  await assert.rejects(as(db, a, "update public.push_tokens set platform = 'web' where token = 'apns-token'"),
    /check constraint|invalid input syntax/) // web인데 JSON이 아님
  await assert.rejects(as(db, a, "update public.push_tokens set user_id = $1 where token = 'apns-token'", [b]), /row-level security/)
  assert.equal((await as(db, a, "update public.push_tokens set platform = 'android' where token = 'apns-token'")).affectedRows, 1)
  assert.equal((await as(db, a, "delete from public.push_tokens where token = 'apns-token'")).affectedRows, 1)
  // 엔진은 전부 읽는다
  assert.equal(await count(db, 'service', 'select * from public.push_tokens'), 4)
})

test('push_tokens: supabase-js upsert (merge-duplicates) works for the owner only', async () => {
  const { db, a, b } = await abc()
  // PostgREST는 payload의 모든 칸을 DO UPDATE SET에 넣는다. updated_at은 트리거가 채우므로 payload에 없다.
  const upsert = (u, uid, token, platform) => as(db, u,
    `insert into public.push_tokens(user_id, token, platform) values ($1, $2, $3)
     on conflict (user_id, token) do update set user_id = excluded.user_id, token = excluded.token,
       platform = excluded.platform, updated_at = excluded.updated_at`, [uid, token, platform])
  assert.equal((await upsert(a, a, 'tok', 'android')).affectedRows, 1) // 첫 등록부터 된다
  assert.equal((await upsert(a, a, 'tok', 'android')).affectedRows, 1) // 재등록
  assert.equal((await upsert(a, a, 'tok', 'ios')).affectedRows, 1) // 플랫폼 바뀜
  assert.equal((await one(as(db, a, 'select platform from public.push_tokens'))).platform, 'ios')
  // payload에 updated_at이 들어 있어도(클라이언트가 보낸 과거 시각) 실패하지 않고, 저장되는 값은 서버 시각이다
  assert.equal((await as(db, a,
    `insert into public.push_tokens(user_id, token, platform, updated_at) values ($1, 'tok', 'android', '2000-01-01')
     on conflict (user_id, token) do update set user_id = excluded.user_id, token = excluded.token,
       platform = excluded.platform, updated_at = excluded.updated_at`, [a])).affectedRows, 1)
  assert.ok((await one(as(db, 'service',
    "select updated_at > now() - interval '1 minute' as ok from public.push_tokens where user_id = $1 and token = 'tok'", [a]))).ok)
  // 칸을 줄인 형태(platform, updated_at만)도 된다
  assert.equal((await as(db, a,
    `insert into public.push_tokens(user_id, token, platform) values ($1, 'tok', 'android')
     on conflict (user_id, token) do update set platform = excluded.platform, updated_at = excluded.updated_at`, [a])).affectedRows, 1)
  assert.equal(await count(db, a, 'select * from public.push_tokens'), 1)
  // 남의 행: 남의 이름으로 넣는 것은 insert 정책이, 충돌한 행을 남에게 옮기는 것은 update 정책이 막는다
  await assert.rejects(upsert(b, a, 'tok', 'web'), /row-level security/)
  await assert.rejects(as(db, a,
    `insert into public.push_tokens(user_id, token, platform) values ($1, 'tok', 'ios')
     on conflict (user_id, token) do update set user_id = $2`, [a, b]), /row-level security/)
  assert.deepEqual((await as(db, 'service', 'select user_id, platform from public.push_tokens')).rows, [{ user_id: a, platform: 'android' }])
  // b가 같은 토큰 문자열을 올리면 b의 행이 따로 생긴다(PK가 (user_id, token)). a의 행은 그대로다.
  await upsert(b, b, 'tok', 'ios')
  assert.equal(await count(db, 'service', 'select * from public.push_tokens'), 2)
  assert.equal(await count(db, b, 'select * from public.push_tokens'), 1)
  // 형식 제약은 upsert에도 적용된다
  await assert.rejects(upsert(a, a, 'not json', 'web'), /check constraint|invalid input syntax/)
  await assert.rejects(upsert(a, a, 'tok', 'web'), /check constraint|invalid input syntax/)
})

test('push_tokens.updated_at is set by the server clock', async () => {
  const { db, a } = await abc()
  const fresh = async () => (await one(as(db, 'service',
    "select updated_at between now() - interval '1 minute' and now() + interval '1 minute' as ok from public.push_tokens where token = 'tok'"))).ok
  // insert payload에 updated_at이 있어도 실패하지 않고, 서버 시각으로 덮인다
  await as(db, a, "insert into public.push_tokens(user_id, token, platform, updated_at) values ($1, 'tok', 'ios', '2000-01-01')", [a])
  assert.ok(await fresh())
  // update로 과거·미래 시각을 넣어도 서버 시계로 덮인다 (service_role도 같다)
  for (const [who, t] of [[a, '2000-01-01'], [a, '2999-01-01'], ['service', '2000-01-01'], ['service', '2999-01-01']]) {
    await as(db, who, `update public.push_tokens set updated_at = '${t}' where token = 'tok'`)
    assert.ok(await fresh(), `${who} ${t}`)
  }
  // 갱신하면 시각이 앞으로 간다
  const ts = async () => (await one(as(db, 'service', "select updated_at as t from public.push_tokens where token = 'tok'"))).t.getTime()
  const before = await ts()
  await as(db, a, "update public.push_tokens set platform = 'android' where token = 'tok'")
  assert.ok(await ts() > before)
  // 트리거 함수는 직접 부를 수 없다
  await assert.rejects(as(db, a, 'select public.push_tokens_touch()'), /permission denied/)
})

test('no column stores raw complaint text', async () => {
  const db = await freshDb()
  assert.deepEqual(await columns(db, 'tone', 'feedback_log'),
    ['id', 'room_id', 'reporter_id', 'message_id', 'usable', 'pattern_count', 'created_at'])
  // trace에는 겉 신호와 전문가 출력만 — 초안 문장 칸 없음
  assert.deepEqual(await columns(db, 'tone', 'analysis_traces'),
    ['trace_id', 'path', 'user_id', 'room_id', 'experts', 'risk', 'alert', 'latency_ms', 'created_at'])
  // 엔진 계획이 real을 전제한다(이동 평균이라 정수가 아님)
  assert.equal((await db.query(
    "select data_type from information_schema.columns where table_schema = 'tone' and table_name = 'sender_patterns' and column_name = 'strength'")).rows[0].data_type, 'real')
  assert.deepEqual(await columns(db, 'public', 'mirror_attempts'),
    ['id', 'user_id', 'kind', 'card_ref', 'answer_score', 'predicted', 'panel_bin', 'gap', 'created_at'])
  // tone 스키마의 문자열 칸은 짧은 라벨뿐이어야 한다. 자유 문장 칸이 늘면 여기서 걸린다.
  const { rows } = await db.query(
    `select table_name || '.' || column_name as c from information_schema.columns
     where table_schema = 'tone' and data_type in ('text', 'character varying', 'character') order by 1`)
  assert.deepEqual(rows.map((r) => r.c), [
    'analysis_traces.path', 'global_patterns.trigger', 'pattern_reporters.trigger',
    'sender_pattern_reporters.relation', 'sender_pattern_reporters.trigger', 'sender_patterns.feeling',
    'sender_patterns.relation', 'sender_patterns.trigger'])
})

test('register_push_token: a device handed to B leaves A, only the exact token moves', async () => {
  const { db, a, b } = await abc()
  const reg = (u, token, platform = 'android') => as(db, u, 'select public.register_push_token($1, $2)', [token, platform])
  const sub = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/w/1', keys: { p256dh: 'k', auth: 'a' } })
  await reg(a, 'ExponentPushToken[shared]')
  await reg(a, 'ExponentPushToken[a-other]')
  await reg(a, sub, 'web')
  await reg(b, 'ExponentPushToken[b-own]')
  await reg(b, 'ExponentPushToken[shared]')
  await reg(b, sub, 'web')
  const rows = (await as(db, 'service', 'select user_id, token from public.push_tokens order by token')).rows
  assert.deepEqual(rows.filter((r) => r.token === 'ExponentPushToken[shared]').map((r) => r.user_id), [b])
  assert.deepEqual(rows.filter((r) => r.token === sub).map((r) => r.user_id), [b])
  assert.ok(rows.some((r) => r.user_id === a && r.token === 'ExponentPushToken[a-other]')) // B cannot touch A's other tokens
  assert.ok(rows.some((r) => r.user_id === b && r.token === 'ExponentPushToken[b-own]'))
  await reg(b, 'ExponentPushToken[shared]') // idempotent
  assert.equal(await count(db, 'service', "select * from public.push_tokens where token = 'ExponentPushToken[shared]'"), 1)
  await assert.rejects(reg(b, 'not json', 'web'), /check constraint|invalid input syntax/)
  await assert.rejects(reg(b, 'tok', 'sms'), /check constraint/)
  await assert.rejects(as(db, 'anon', "select public.register_push_token('t', 'android')"), /permission denied/)
})
