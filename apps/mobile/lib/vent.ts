import type { Checked } from './auth';
import type { Msg } from './messages';

export const VENT_MAX = 1000; // 엔진 FeedbackIn 상한(코드포인트)

// 받은 메시지이고 글이 있을 때만(사진만 있는 메시지는 가릴 글이 없다). 서버도 내 메시지는 403으로 막는다.
export function canVent(msg: Pick<Msg, 'sender_id' | 'text'>, me: string): boolean {
  return msg.sender_id !== me && msg.text.trim() !== '';
}

export function validateVent(s: string): Checked {
  const value = s.trim();
  const n = [...value].length;
  if (n === 0) return { ok: false, message: '적어 주세요' };
  if (n > VENT_MAX) return { ok: false, message: `${VENT_MAX}자까지 쓸 수 있어요` };
  return { ok: true, value };
}

// 고정 문구만. 엔진 글은 쓰지 않는다. 202는 중복·상한도 같으므로 여기서 구분하지 않는다.
export function ventErrorMessage(status: number): string {
  if (status === 403) return '이 메시지에는 남길 수 없어요';
  if (status === 429) return '잠시 뒤 다시 남겨 주세요';
  return '지금은 남기지 못했어요. 잠시 뒤 다시 해 주세요.';
}
