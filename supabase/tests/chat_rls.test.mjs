import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, as, newUser } from './helpers.mjs'

const one = async (p) => (await p).rows[0]
const invite = async (db, u, room = null, relation = '친구') =>
  (await one(as(db, u, 'select public.create_invite($1, $2) as c', [room, relation]))).c
const accept = async (db, u, code) =>
  (await one(as(db, u, 'select public.accept_invite($1) as r', [code]))).r
const direct = async (db, a, b, relation) => accept(db, b, await invite(db, a, null, relation))
const send = async (db, u, room, text, replyTo = null) =>
  (await one(as(db, u,
    'insert into public.messages(room_id, sender_id, text, reply_to) values ($1, $2, $3, $4) returning id',
    [room, u, text, replyTo]))).id
const count = async (db, u, sql, params) => (await as(db, u, sql, params)).rows.length

async function abc() {
  const db = await freshDb()
  const [a, b, c] = [await newUser(db, 'A'), await newUser(db, 'B'), await newUser(db, 'C')]
  return { db, a, b, c }
}

test('non-member sees no messages', async () => {
  const { db, a, b, c } = await abc()
  const room = await direct(db, a, b)
  await send(db, a, room, 'hi')
  assert.equal(await count(db, b, 'select * from public.messages'), 1)
  assert.equal(await count(db, c, 'select * from public.messages'), 0)
  assert.equal(await count(db, c, 'select * from public.rooms'), 0)
  assert.equal(await count(db, c, 'select * from public.room_members'), 0)
  // anon은 표도 함수도 못 쓴다
  await assert.rejects(as(db, 'anon', 'select * from public.messages'), /permission denied/)
  await assert.rejects(as(db, 'anon', "select public.accept_invite('AAAAAAAA')"), /permission denied/)
  await assert.rejects(as(db, 'anon', "select public.create_group('g', '친구')"), /permission denied/)
  await assert.rejects(as(db, 'anon', 'select public.create_invite()'), /permission denied/)
  await assert.rejects(as(db, 'anon', 'select public.is_member($1)', [room]), /permission denied/)
})

test('cannot insert as someone else', async () => {
  const { db, a, b } = await abc()
  const room = await direct(db, a, b)
  await assert.rejects(as(db, a,
    'insert into public.messages(room_id, sender_id, text) values ($1, $2, $3)', [room, b, 'fake']),
  /row-level security/)
})

test('non-member cannot insert', async () => {
  const { db, a, b, c } = await abc()
  const room = await direct(db, a, b)
  await assert.rejects(send(db, c, room, 'intrude'), /row-level security/)
  assert.equal(await count(db, 'service', 'select * from public.messages'), 0)
})

test('reply_to must be in same room', async () => {
  const { db, a, b, c } = await abc()
  const r1 = await direct(db, a, b)
  const r2 = await direct(db, a, c)
  const m1 = await send(db, a, r1, 'in room 1')
  await assert.rejects(send(db, a, r2, 'cross', m1), /reply_to_other_room/)
  assert.ok(await send(db, b, r1, 'same room ok', m1))
})

test('messages cannot be updated or deleted', async () => {
  const { db, a, b } = await abc()
  const room = await direct(db, a, b)
  const m = await send(db, a, room, 'original')
  await assert.rejects(as(db, a, "update public.messages set text = 'edited' where id = $1", [m]), /permission denied/)
  await assert.rejects(as(db, a, 'delete from public.messages where id = $1', [m]), /permission denied/)
  await assert.rejects(as(db, a, "select setval('public.messages_id_seq', 1)"), /permission denied/)
  const row = await one(as(db, 'service', 'select text from public.messages where id = $1', [m]))
  assert.equal(row.text, 'original')
})

test('direct invite: accept creates room with both', async () => {
  const { db, a, b } = await abc()
  const code = await invite(db, a, null, '팀원')
  assert.match(code, /^[A-Z0-9]{8}$/)
  const inv = await one(as(db, a, "select max_uses, expires_at > now() + interval '71 hours' and expires_at <= now() + interval '72 hours' as ttl from public.invites"))
  assert.deepEqual(inv, { max_uses: 1, ttl: true })
  const room = await accept(db, b, code)
  assert.deepEqual(await one(as(db, b, 'select kind, relation from public.rooms where id = $1', [room])),
    { kind: 'direct', relation: '팀원' })
  const members = (await as(db, a, 'select user_id from public.room_members where room_id = $1', [room])).rows
  assert.deepEqual(members.map((r) => r.user_id).sort(), [a, b].sort())
})

test('direct invite cannot be reused or self-accepted', async () => {
  const { db, a, b, c } = await abc()
  const code = await invite(db, a)
  await assert.rejects(accept(db, a, code), /invite_self/)
  await accept(db, b, code)
  await assert.rejects(accept(db, c, code), /invite_used/)
  assert.equal(await count(db, c, 'select * from public.rooms'), 0)
})

test('expired invite rejected', async () => {
  const { db, a, b } = await abc()
  const code = await invite(db, a)
  await as(db, 'service', "update public.invites set expires_at = now() - interval '1 minute' where code = $1", [code])
  await assert.rejects(accept(db, b, code), /invite_expired/)
  await assert.rejects(accept(db, b, 'ZZZZZZZZ'), /invite_not_found/)
})

test('re-accepting returns same room, no duplicates', async () => {
  const { db, a, b } = await abc()
  const code = await invite(db, a)
  const room = await accept(db, b, code)
  assert.equal(await accept(db, b, code), room)
  assert.equal(await direct(db, a, b), room) // 새 초대여도 기존 1:1 방
  assert.equal(await direct(db, b, a), room) // 반대 방향도
  assert.equal(await count(db, 'service', 'select * from public.rooms'), 1)
  assert.equal(await count(db, 'service', 'select * from public.room_members'), 2)
  // 이미 그 방에 있으면 만료·소진된 코드여도 방을 돌려받는다
  const g = (await one(as(db, a, "select public.create_group('g', '친구') as g"))).g
  const gcode = await invite(db, a, g)
  await accept(db, b, gcode)
  await as(db, 'service', "update public.invites set expires_at = now() - interval '1 minute', uses = max_uses")
  assert.equal(await accept(db, b, code), room)
  assert.equal(await accept(db, b, gcode), g)
  const c = await newUser(db, 'C')
  await assert.rejects(accept(db, c, gcode), /invite_expired/) // 남에게는 여전히 거절
})

test('group: 9th member rejected', async () => {
  const { db, a, b } = await abc()
  const g = (await one(as(db, a, "select public.create_group('스터디', '팀원') as g"))).g
  assert.deepEqual(await one(as(db, a, 'select kind, title, relation from public.rooms')),
    { kind: 'group', title: '스터디', relation: '팀원' })
  await assert.rejects(invite(db, b, g), /not_member/) // 그룹 초대는 멤버만
  const code = await invite(db, a, g)
  for (let i = 1; i <= 7; i++) assert.equal(await accept(db, await newUser(db, `U${i}`), code), g)
  assert.equal(await count(db, a, 'select * from public.room_members where room_id = $1', [g]), 8)
  const code2 = await invite(db, a, g)
  await assert.rejects(accept(db, b, code2), /room_full/)
  assert.equal(await count(db, 'service', 'select * from public.room_members where room_id = $1', [g]), 8)
})

test('reactions: one per user, members only, own only', async () => {
  const { db, a, b, c } = await abc()
  const room = await direct(db, a, b)
  const m = await send(db, a, room, 'react to me')
  const react = (u, uid, emoji) => as(db, u,
    'insert into public.reactions(message_id, user_id, emoji) values ($1, $2, $3)', [m, uid, emoji])
  await react(b, b, '👍')
  await react(a, a, '❤️')
  await assert.rejects(react(b, b, '😂'), /duplicate key/) // 한 사람 하나
  await assert.rejects(react(a, b, '😮'), /row-level security/) // 남의 이름으로
  await assert.rejects(react(c, c, '👍'), /row-level security/) // 비멤버
  await assert.rejects(react(a, a, '🔥'), /check constraint/) // 고정 6개만
  assert.equal(await count(db, c, 'select * from public.reactions'), 0)
  assert.equal((await as(db, a, 'delete from public.reactions where user_id = $1', [b])).affectedRows, 0)
  assert.equal((await as(db, b, "update public.reactions set emoji = '🙏' where user_id = $1", [a])).affectedRows, 0)
  assert.equal((await as(db, b, "update public.reactions set emoji = '🙏' where user_id = $1", [b])).affectedRows, 1)
  assert.equal((await as(db, a, 'delete from public.reactions where user_id = $1', [a])).affectedRows, 1)
  assert.equal(await count(db, b, 'select * from public.reactions'), 1)
})

test('room_members: can update own last_read_at/muted only', async () => {
  const { db, a, b } = await abc()
  const room = await direct(db, a, b)
  const upd = (u, set, who) => as(db, u, `update public.room_members set ${set} where room_id = $1 and user_id = $2`, [room, who])
  assert.equal((await upd(a, 'last_read_at = now(), muted = true', a)).affectedRows, 1)
  assert.equal((await upd(a, 'muted = true', b)).affectedRows, 0)
  await assert.rejects(upd(a, "joined_at = now() - interval '1 day'", a), /permission denied/)
  await assert.rejects(upd(a, 'user_id = $2', a), /permission denied/)
  await assert.rejects(as(db, a, 'delete from public.room_members where user_id = $1', [a]), /permission denied/)
  const c = await newUser(db, 'C')
  const ins = (u, who) => as(db, u, 'insert into public.room_members(room_id, user_id) values ($1, $2)', [room, who])
  await assert.rejects(ins(c, c), /permission denied/) // 자기 자신을 남의 방에
  await assert.rejects(ins(a, c), /permission denied/) // 멤버가 남을 직접
  const rows = (await as(db, 'service', 'select user_id, muted from public.room_members where room_id = $1', [room])).rows
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.user_id, r.muted])), { [a]: true, [b]: false })
})

test('profiles visible to self and co-members only', async () => {
  const { db, a, b, c } = await abc()
  await direct(db, a, b)
  const names = async (u) => (await as(db, u, 'select name from public.profiles order by name')).rows.map((r) => r.name)
  assert.deepEqual(await names(a), ['A', 'B'])
  assert.deepEqual(await names(c), ['C'])
  assert.equal((await as(db, a, "update public.profiles set name = 'X' where id = $1", [b])).affectedRows, 0)
  assert.equal((await as(db, a, "update public.profiles set name = 'A2' where id = $1", [a])).affectedRows, 1)
})

test('rooms and invites are written only through functions', async () => {
  const { db, a, b } = await abc()
  const room = await direct(db, a, b)
  await assert.rejects(as(db, a, "insert into public.rooms(kind, relation) values ('group', '친구')"), /permission denied/)
  await assert.rejects(as(db, a,
    "insert into public.invites(code, inviter_id, relation, max_uses, expires_at) values ('AAAAAAAA', $1, '친구', 99, now() + interval '1 year')",
    [a]), /permission denied/)
  await assert.rejects(as(db, a, 'update public.invites set uses = 0'), /permission denied/)
  await assert.rejects(invite(db, a, room), /not_group/) // 1:1 방에는 초대 못 함
})

test('message files: all-or-none fields, own-room path, name/size limits, one attachment, content required', async () => {
  const { db, a, b, c } = await abc()
  const r1 = await direct(db, a, b)
  const r2 = await direct(db, a, c)
  const ins = (text, img, path, name, size) => as(db, a,
    'insert into public.messages(room_id, sender_id, text, image_path, file_path, file_name, file_size) values ($1, $2, $3, $4, $5, $6, $7) returning id',
    [r1, a, text, img, path, name, size])
  assert.ok((await ins('', null, `${r1}/1-abc.pdf`, '보고서.pdf', 340000)).rows[0].id) // 글 없는 파일 메시지
  assert.ok((await ins('같이 봐요', null, `${r1}/2-abc`, 'a'.repeat(200), 20971520)).rows[0].id)
  await assert.rejects(ins('', null, `${r1}/x.pdf`, null, null), /messages_file_all_or_none/) // 일부만
  await assert.rejects(ins('', null, null, 'a.pdf', 10), /messages_file_all_or_none/)
  await assert.rejects(ins('hi', null, null, null, 10), /messages_file_all_or_none/)
  await assert.rejects(ins('', null, `${r2}/x.pdf`, 'a.pdf', 10), /messages_file_path_room/) // 다른 방 폴더
  await assert.rejects(ins('', null, 'x.pdf', 'a.pdf', 10), /messages_file_path_room/)
  await assert.rejects(ins('', null, `${r1}/a/b.pdf`, 'a.pdf', 10), /messages_file_path_room/)
  await assert.rejects(ins('', null, `${r1}/a..b.pdf`, 'a.pdf', 10), /messages_file_path_room/)
  await assert.rejects(ins('', null, `${r1}/x.pdf`, 'a\u0007b.pdf', 10), /messages_file_name_ok/) // 제어 문자
  await assert.rejects(ins('', null, `${r1}/x.pdf`, 'a\nb.pdf', 10), /messages_file_name_ok/)
  await assert.rejects(ins('', null, `${r1}/x.pdf`, 'a'.repeat(201), 10), /messages_file_name_ok/)
  await assert.rejects(ins('', null, `${r1}/x.pdf`, '', 10), /messages_file_name_ok/)
  await assert.rejects(ins('', null, `${r1}/x.pdf`, 'a.pdf', 0), /messages_file_size_ok/)
  await assert.rejects(ins('', null, `${r1}/x.pdf`, 'a.pdf', 20971521), /messages_file_size_ok/)
  await assert.rejects(ins('', `${r1}/p.jpg`, `${r1}/x.pdf`, 'a.pdf', 10), /messages_one_attachment/) // 사진+파일
  await assert.rejects(ins('', null, null, null, null), /messages_has_content/) // 빈 메시지
})

test('deleting a replied-to user keeps replies with reply_to null', async () => {
  const { db, a, b } = await abc()
  const room = await direct(db, a, b)
  const m = await send(db, a, room, 'from A')
  const r = await send(db, b, room, 'reply from B', m)
  await db.query('delete from auth.users where id = $1', [a])
  const rows = (await as(db, 'service', 'select id, reply_to from public.messages')).rows
  assert.deepEqual(rows, [{ id: r, reply_to: null }])
})

test('message fields: image_path in own room, mentions of members only, at most 8', async () => {
  const { db, a, b, c } = await abc()
  const r1 = await direct(db, a, b)
  const r2 = await direct(db, a, c)
  const ins = (img, mentions = []) => as(db, a,
    'insert into public.messages(room_id, sender_id, image_path, mentions) values ($1, $2, $3, $4) returning id',
    [r1, a, img, mentions])
  assert.ok((await ins(`${r1}/photo.jpg`, [b])).rows[0].id) // 같은 방 경로, 멤버 언급
  await assert.rejects(ins(`${r2}/photo.jpg`), /messages_image_path_room/) // 다른 방 경로
  await assert.rejects(ins('photo.jpg'), /messages_image_path_room/)
  await assert.rejects(ins(`${r1}/../${r2}/x.jpg`), /messages_image_path_room/) // 경로 탈출
  await assert.rejects(ins(`${r1}/a/../b.jpg`), /messages_image_path_room/)
  await assert.rejects(ins(`${r1}/a/b.jpg`), /messages_image_path_room/) // 하위 폴더
  assert.ok((await ins(`${r1}/abc-123.jpg`)).rows[0].id)
  await assert.rejects(ins(`${r1}/x.jpg`, [c]), /mention_not_member/) // 비멤버 언급
  await assert.rejects(ins(`${r1}/x.jpg`, Array(9).fill(b)), /messages_mentions_check/) // 9개
})
