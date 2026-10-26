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
  await assert.rejects(as(db, 'anon', "select public.accept_invite('AAAAAA')"), /permission denied/)
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
  assert.match(code, /^[A-Z0-9]{6}$/)
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
  await assert.rejects(accept(db, b, 'ZZZZZZ'), /invite_not_found/)
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
