import { typingLabel, type PresenceState } from '../typing';

const A = 'a';
const st = (m: Record<string, boolean>): PresenceState => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [{ user_id: k, typing: v }]]));
const names = { b: '지은', c: '민수', a: '나' };

test('only me typing → null', () => expect(typingLabel(st({ a: true }), A, names)).toBeNull());
test('others not typing → null', () => expect(typingLabel(st({ b: false }), A, names)).toBeNull());
test('one other → name', () => expect(typingLabel(st({ b: true }), A, names)).toBe('지은님이 입력 중'));
test('two others → count', () => expect(typingLabel(st({ b: true, c: true }), A, names)).toBe('2명이 입력 중'));
test('same user on two devices counts once', () =>
  expect(typingLabel({ b: [{ user_id: 'b', typing: true }, { user_id: 'b', typing: true }] }, A, names)).toBe('지은님이 입력 중'));
test('unknown name → 상대', () => expect(typingLabel(st({ z: true }), A, names)).toBe('상대님이 입력 중'));
