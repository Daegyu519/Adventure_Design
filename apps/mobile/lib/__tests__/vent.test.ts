import { canVent, validateVent, ventErrorMessage } from '../vent';

const ME = 'me';
const B = 'b';

test('canVent: my own message → false', () => expect(canVent({ sender_id: ME, text: '안녕' }, ME)).toBe(false));
test('canVent: received text → true', () => expect(canVent({ sender_id: B, text: '안 돼요.' }, ME)).toBe(true));
test('canVent: received photo without text → false', () => expect(canVent({ sender_id: B, text: '' }, ME)).toBe(false));
test('validateVent: blank rejected', () => expect(validateVent('   ').ok).toBe(false));
test('validateVent: trims and accepts 1000 code points, rejects 1001', () => {
  expect(validateVent('  힘들어요 ')).toEqual({ ok: true, value: '힘들어요' });
  expect(validateVent('😀'.repeat(1000)).ok).toBe(true);
  expect(validateVent('😀'.repeat(1001)).ok).toBe(false);
});
test('ventErrorMessage: fixed copy per status, never server text', () => {
  expect(ventErrorMessage(403)).toBe('이 메시지에는 남길 수 없어요');
  expect(ventErrorMessage(429)).toBe('잠시 뒤 다시 남겨 주세요');
  expect(ventErrorMessage(500)).toBe('지금은 남기지 못했어요. 잠시 뒤 다시 해 주세요.');
  expect(ventErrorMessage(0)).toBe('지금은 남기지 못했어요. 잠시 뒤 다시 해 주세요.');
});
