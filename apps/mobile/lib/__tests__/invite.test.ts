/// <reference types="node" /> // 마이그레이션 SQL을 읽는다(앱 코드에서는 node 타입을 쓰지 않는다)
import fs from 'fs';
import path from 'path';

import { GROUP_MAX, INVITE_CODE_LENGTH, normalizeInviteCode, RELATIONS, rpcText, validateGroupTitle } from '../invite';

// 코드 입력(accept_invite)이 실패했을 때 화면에 낼 문구
const inviteErrorMessage = async (err: { message: string }) => {
  const r = await rpcText(Promise.resolve({ data: null, error: err, status: 400 }), '코드를 확인해 주세요');
  return r.ok ? null : r.message;
};

const SQL = fs.readFileSync(path.join(__dirname, '../../../../supabase/migrations/20261027000001_chat.sql'), 'utf8');

test('normalizeInviteCode uppercases and strips spaces/hyphens', () => expect(normalizeInviteCode(' ab3-x9k7q ')).toBe('AB3X9K7Q'));
// 공유 문구("초대 코드: ABCD1234")를 통째로 붙여 넣어도 코드만 꺼낸다. 메신저가 바꾼 긴 대시·보이지 않는 글자도 지운다(AM-5).
test.each([
  ['초대 코드: ABCD1234', 'ABCD1234'],
  ['초대 코드: abcd1234\n', 'ABCD1234'],
  ['방에 들어와요 — 초대 코드: Q1W2E3R4 (72시간)', 'Q1W2E3R4'],
  ['AB–CD—1234', 'ABCD1234'],
  ['ABCD\u200b1234\ufeff', 'ABCD1234'],
])('normalizeInviteCode pulls the code out of pasted text: %j', (input, out) => expect(normalizeInviteCode(input)).toBe(out));
test('normalizeInviteCode rejects wrong length or non-alnum', () => {
  expect(normalizeInviteCode('AB3X9K7')).toBeNull(); // 7자
  expect(normalizeInviteCode('AB3X9K7QZ')).toBeNull(); // 9자
  expect(normalizeInviteCode('가나다라마바사아')).toBeNull(); // 8자지만 영숫자 아님
  expect(normalizeInviteCode('초대 코드: ABCD12345')).toBeNull(); // 붙은 9자는 코드가 아니다
});
test('rpcText maps each invite error code', async () => {
  expect(await inviteErrorMessage({ message: 'invite_expired' })).toBe('기간이 지난 코드예요. 새 코드를 받아 주세요');
  expect(await inviteErrorMessage({ message: 'invite_used' })).toBe('이미 쓰인 코드예요');
  expect(await inviteErrorMessage({ message: 'invite_self' })).toBe('내가 만든 코드는 입력할 수 없어요');
  expect(await inviteErrorMessage({ message: 'room_full' })).toBe('방이 가득 찼어요 (최대 8명)');
  expect(await inviteErrorMessage({ message: 'invite_not_found' })).toBe('없는 코드예요. 다시 확인해 주세요');
});
test('rpcText unknown code → fallback; unreachable → connection copy', async () => {
  expect(await inviteErrorMessage({ message: 'boom' })).toBe('코드를 확인해 주세요');
  expect(await rpcText(Promise.resolve({ data: null, error: { message: 'x' }, status: 0 }), 'fb')).toEqual({ ok: false, message: '연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.' });
  expect(await rpcText(Promise.resolve({ data: 'ABCD1234', error: null, status: 200 }), 'fb')).toEqual({ ok: true, data: 'ABCD1234' });
});
test('validateGroupTitle', () => {
  expect(validateGroupTitle('  팀플 3조 ')).toEqual({ ok: true, value: '팀플 3조' });
  expect(validateGroupTitle('').ok).toBe(false);
  expect(validateGroupTitle('   ').ok).toBe(false);
  expect(validateGroupTitle('가'.repeat(31)).ok).toBe(false);
  expect(validateGroupTitle('가'.repeat(30)).ok).toBe(true);
  expect(validateGroupTitle('😀'.repeat(30)).ok).toBe(true); // 코드포인트로 센다(JS 길이 60)
});

// DB 쪽 값과 어긋나면 여기서 깨진다. 생성된 db.ts는 check 제약을 string으로만 주므로 값은 마이그레이션 SQL에서 확인한다.
test('RELATIONS equals the rooms.relation check in the chat migration', () => {
  const m = SQL.match(/create table public\.rooms[\s\S]*?relation text not null check \(relation in \(([^)]*)\)\)/);
  expect(m).not.toBeNull();
  const values = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  expect([...RELATIONS]).toEqual(values);
});
test('invite code length and group cap match the DB', () => {
  expect(SQL).toMatch(new RegExp(`order by i limit ${INVITE_CODE_LENGTH}\\b`));
  expect(SQL).toMatch(new RegExp(`coalesce\\(length\\(c\\), 0\\) < ${INVITE_CODE_LENGTH}\\b`));
  expect(SQL).toMatch(new RegExp(`else ${GROUP_MAX} end\\) then raise exception 'room_full'`));
  expect(SQL).toMatch(new RegExp(`char_length\\(title\\) between 1 and 30`));
});
