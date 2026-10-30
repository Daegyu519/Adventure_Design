import { EngineError } from '../engine';
import { choiceOf, detailErrorCopy, INTENTS } from '../intent';

jest.mock('../supabase', () => ({ supabase: null }));

test('INTENTS are the three engine intents in order', () => expect([...INTENTS]).toEqual(['단호하게', '미안하게', '가볍게']));
test('choiceOf follows the label, not the display order', () => {
  expect(choiceOf('조금만 바꾼 문장')).toBe('A');
  expect(choiceOf('가장 부드럽게 바꾼 문장')).toBe('B'); // 후보가 이것 하나만 와도 B
});
test('choiceOf: unknown label → null', () => expect(choiceOf('다른 문장')).toBeNull());
test('detailErrorCopy: fixed non-assertive copy per status, never the server text', () => {
  const generic = '지금은 살펴보기 어려워요. 잠시 뒤 다시 해 주세요.';
  expect(detailErrorCopy(new EngineError(429, 'rate_limited: SECRET'))).toBe('요청이 많아요. 잠시 뒤 다시 해 주세요.');
  expect(detailErrorCopy(new EngineError(503, 'x'))).toBe('연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.');
  expect(detailErrorCopy(new EngineError(0))).toBe('연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.');
  expect(detailErrorCopy(new EngineError(500, 'boom'))).toBe(generic);
  expect(detailErrorCopy(new Error('x'))).toBe(generic);
});
