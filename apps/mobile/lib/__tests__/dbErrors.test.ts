/// <reference types="node" /> // 마이그레이션 SQL을 읽는다(앱 코드에서는 node 타입을 쓰지 않는다)
import fs from 'fs';
import path from 'path';

import { dbErrorMessage, ERROR_MESSAGES, isUnreachable } from '../dbErrors';

const MIGRATION = path.join(__dirname, '../../../../supabase/migrations/20261027000001_chat.sql');

test('codes are matched exactly: mention_not_member is not not_member', () => {
  expect(dbErrorMessage({ message: 'mention_not_member' }, 'x')).toBe('이 방에 없는 사람은 언급할 수 없어요');
  expect(dbErrorMessage({ message: 'not_member' }, 'x')).toBe('이 방의 멤버가 아니에요');
  expect(dbErrorMessage({ message: 'reply_to_other_room' }, 'x')).toBe('다른 방의 메시지에는 답장할 수 없어요');
  expect(dbErrorMessage({ message: 'ERROR: not_group' }, 'x')).toBe('그룹 방에서만 쓸 수 있어요');
});

test('prose, unknown or missing error → fallback', () => {
  expect(dbErrorMessage({ message: '기간이 지난 초대' }, 'fb')).toBe('fb');
  expect(dbErrorMessage({ message: 'boom' }, 'fb')).toBe('fb');
  expect(dbErrorMessage(null, 'fb')).toBe('fb');
  expect(dbErrorMessage(undefined, 'fb')).toBe('fb');
});

test('every raise exception code in the chat migration has a Korean message', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const codes = [...sql.matchAll(/raise exception '([a-z_]+)'/g)].map((m) => m[1]);
  expect(codes.length).toBeGreaterThan(0);
  for (const c of codes) expect(ERROR_MESSAGES).toHaveProperty(c);
});

test('raw Postgres text around a known code is never echoed', () => {
  const out = dbErrorMessage({ message: 'ERROR: invite_used DETAIL: Key (code)=(AB3X9K7Q) conflicts' }, 'fb');
  expect(out).toBe(ERROR_MESSAGES.invite_used);
  expect(out).not.toContain('AB3X9K7Q');
});

test('isUnreachable: status 0 or 5xx means the server was not reached, 4xx means it answered', () => {
  expect(isUnreachable(0)).toBe(true);
  expect(isUnreachable(503)).toBe(true);
  expect(isUnreachable(400)).toBe(false);
  expect(isUnreachable(undefined)).toBe(false);
});

test('inherited object keys are not treated as codes', () => {
  expect(dbErrorMessage({ message: 'constructor' }, 'fb')).toBe('fb');
});
