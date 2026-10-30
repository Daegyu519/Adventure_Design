import { typingLabel, type PresenceState } from '../typing';

const A = 'a';
const st = (m: Record<string, boolean>): PresenceState => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [{ user_id: k, typing: v }]]));
const names = { b: '지은', c: '민수', d: '하나', e: '다온', a: '나' };

test('only me typing → null', () => expect(typingLabel(st({ a: true }), A, names)).toBeNull());
test('others not typing → null', () => expect(typingLabel(st({ b: false }), A, names)).toBeNull());
test('one other → name', () => expect(typingLabel(st({ b: true }), A, names)).toBe('지은님이 입력 중'));
test('two or three others → names', () => {
  expect(typingLabel(st({ b: true, c: true }), A, names)).toBe('지은, 민수님이 입력 중');
  expect(typingLabel(st({ b: true, c: true, d: true }), A, names)).toBe('지은, 민수, 하나님이 입력 중');
});
test('four or more → count', () => expect(typingLabel(st({ b: true, c: true, d: true, e: true }), A, names)).toBe('4명이 입력 중'));
test('same user on two devices counts once', () =>
  expect(typingLabel({ b: [{ user_id: 'b', typing: true }, { user_id: 'b', typing: true }] }, A, names)).toBe('지은님이 입력 중'));
test('non-member key is ignored', () => expect(typingLabel(st({ z: true }), A, names)).toBeNull());
test('payload claiming another user under a different key is ignored', () => {
  expect(typingLabel({ c: [{ user_id: 'b', typing: true }] }, A, names)).toBeNull();
  expect(typingLabel({ c: [{ user_id: 'b', typing: true }], b: [{ user_id: 'b', typing: true }] }, A, names)).toBe('지은님이 입력 중');
});
test('claiming to be me under my own key slot of someone else does not hide real typers', () =>
  expect(typingLabel({ b: [{ user_id: 'a', typing: true }] }, A, names)).toBeNull());
