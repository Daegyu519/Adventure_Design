// 로그인·프로필 입력 검사. 순수 함수만 둔다(이메일·코드·이름은 로그에 남기지 않는다).
export const OTP_LENGTH = 6;

export type Checked = { ok: true; value: string } | { ok: false; message: string };

// 가입 여부는 서버가 정한다. 여기서는 "메일을 보낼 만한 모양인가"만 본다.
export const isValidEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// 메일에서 붙여 넣으면 공백이 섞일 수 있다. 공백을 지운 뒤 숫자 6자리만 받는다.
export function normalizeOtp(s: string): string | null {
  const t = s.replace(/\s+/g, '');
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(t) ? t : null;
}

// profiles.name은 Postgres char_length 1~20(코드포인트). JS 길이가 아니라 [...s]로 센다.
export function validateName(s: string): Checked {
  const value = s.trim();
  const n = [...value].length;
  if (n === 0) return { ok: false, message: '이름을 적어 주세요' };
  if (n > 20) return { ok: false, message: '20자까지 쓸 수 있어요' };
  return { ok: true, value };
}

// 서버 오류 문구는 그대로 보여 주지 않는다(내부 정보·영문). 상태 코드만 보고 고정 문구를 고른다.
export function otpErrorMessage(step: 'send' | 'verify', err: { status?: number }): string {
  const s = err.status;
  if (s === 429) return '잠시 뒤 다시 받아 주세요';
  if (step === 'send') return '코드를 보내지 못했어요. 잠시 뒤 다시 해 주세요.';
  // 상태가 없거나(0 포함) 5xx면 서버에 닿지 못했거나 서버 문제다. 코드가 틀렸다고 말하지 않는다.
  if (!s || s >= 500) return '연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.';
  return '코드가 맞지 않거나 시간이 지났어요. 다시 받아 주세요.';
}
