import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'

const dir = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, dir), 'utf8')

// shim + migrations/*.sql(이름에 _platform 없는 것)을 이름순으로 실행한 새 DB.
export async function freshDb() {
  const db = new PGlite()
  await db.exec(read('tests/shim.sql'))
  const files = readdirSync(new URL('migrations/', dir))
    .filter((f) => f.endsWith('.sql') && !f.includes('_platform'))
    .sort()
  for (const f of files) await db.exec(read(`migrations/${f}`))
  return db
}

// userId 역할로 sql 하나를 트랜잭션 안에서 실행. 'service' → service_role, 'anon' → anon.
export async function as(db, userId, sql, params = []) {
  return db.transaction(async (tx) => {
    if (userId === 'service') await tx.query('set local role service_role')
    else if (userId === 'anon') await tx.query('set local role anon')
    else {
      await tx.query('set local role authenticated')
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId])
    }
    return tx.query(sql, params)
  })
}

// auth.users + profiles 행을 만들고 id를 돌려준다.
export async function newUser(db, name) {
  const { rows } = await db.query('insert into auth.users values (gen_random_uuid()) returning id')
  await db.query('insert into public.profiles(id, name) values ($1, $2)', [rows[0].id, name])
  return rows[0].id
}
