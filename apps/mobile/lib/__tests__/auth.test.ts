import { isValidEmail, normalizeOtp, otpErrorMessage, OTP_LENGTH, validateName } from '../auth';

test('OTP_LENGTH is 6', () => expect(OTP_LENGTH).toBe(6));

test('isValidEmail', () => {
  expect(isValidEmail(' a@b.co ')).toBe(true);
  expect(isValidEmail('a@b')).toBe(false);
});
test('isValidEmail rejects blanks and inner spaces', () => {
  expect(isValidEmail('')).toBe(false);
  expect(isValidEmail('a b@c.co')).toBe(false);
  expect(isValidEmail('a@@b.co')).toBe(false);
});

test('normalizeOtp', () => {
  expect(normalizeOtp('123 456')).toBe('123456');
  expect(normalizeOtp('12345')).toBeNull();
  expect(normalizeOtp('12345a')).toBeNull();
});
test('normalizeOtp rejects 7 digits', () => expect(normalizeOtp('1234567')).toBeNull());

test('validateName trims', () => expect(validateName('  지은 ')).toEqual({ ok: true, value: '지은' }));
test('validateName empty', () => expect(validateName('  ')).toEqual({ ok: false, message: '이름을 적어 주세요' }));
test('validateName over 20', () => expect(validateName('가'.repeat(21))).toEqual({ ok: false, message: '20자까지 쓸 수 있어요' }));
test('validateName 20 is fine', () => expect(validateName('가'.repeat(20)).ok).toBe(true));
test('validateName counts emoji as one char like Postgres', () => expect(validateName('😀'.repeat(20)).ok).toBe(true));

test('otpErrorMessage: 429 on either step asks to wait', () => {
  expect(otpErrorMessage('send', { status: 429 })).toBe('잠시 뒤 다시 받아 주세요');
  expect(otpErrorMessage('verify', { status: 429 })).toBe('잠시 뒤 다시 받아 주세요');
});
test('otpErrorMessage: wrong or expired code', () =>
  expect(otpErrorMessage('verify', { status: 403 })).toBe('코드가 맞지 않거나 시간이 지났어요. 다시 받아 주세요.'));
test('otpErrorMessage: 400 and 422 on verify are still a wrong or expired code', () => {
  expect(otpErrorMessage('verify', { status: 400 })).toBe('코드가 맞지 않거나 시간이 지났어요. 다시 받아 주세요.');
  expect(otpErrorMessage('verify', { status: 422 })).toBe('코드가 맞지 않거나 시간이 지났어요. 다시 받아 주세요.');
});
test('otpErrorMessage: verify with no status, 0 or 5xx is a connection problem, not a wrong code', () => {
  const CONNECTION = '연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.';
  for (const status of [undefined, 0, 500, 503]) expect(otpErrorMessage('verify', { status })).toBe(CONNECTION);
});
test('otpErrorMessage: send failure', () =>
  expect(otpErrorMessage('send', { status: 500 })).toBe('코드를 보내지 못했어요. 잠시 뒤 다시 해 주세요.'));
