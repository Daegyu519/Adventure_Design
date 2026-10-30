import { shouldSubmitOnKey } from '../composer';

test('Enter sends', () => expect(shouldSubmitOnKey({ key: 'Enter' })).toBe(true));
test('Shift+Enter is newline', () => expect(shouldSubmitOnKey({ key: 'Enter', shiftKey: true })).toBe(false));
test('other keys never send', () => expect(shouldSubmitOnKey({ key: 'a' })).toBe(false));
test('Enter during Korean IME composition does not send', () => {
  expect(shouldSubmitOnKey({ key: 'Enter', isComposing: true })).toBe(false);
  expect(shouldSubmitOnKey({ key: 'Enter', keyCode: 229 })).toBe(false);
});
