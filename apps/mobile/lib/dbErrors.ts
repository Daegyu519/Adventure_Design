// DB 함수·트리거가 raise exception으로 던지는 코드(supabase/migrations/20261027000001_chat.sql)를 한국어 문구로 바꾼다.
// PostgREST는 코드를 message에 그대로 준다. 문구는 코드로만 고르고, 서버가 준 글(영문·내부 정보·코드값)은 화면에 내지 않는다.
export const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: '로그인이 필요해요',
  not_member: '이 방의 멤버가 아니에요',
  not_group: '그룹 방에서만 쓸 수 있어요',
  invite_not_found: '없는 코드예요. 다시 확인해 주세요',
  invite_self: '내가 만든 코드는 입력할 수 없어요',
  invite_expired: '기간이 지난 코드예요. 새 코드를 받아 주세요',
  invite_used: '이미 쓰인 코드예요',
  room_full: '방이 가득 찼어요 (최대 8명)',
  reply_to_other_room: '다른 방의 메시지에는 답장할 수 없어요',
  mention_not_member: '이 방에 없는 사람은 언급할 수 없어요',
};

const has = (k: string) => Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, k);

// 부분 문자열 검색은 not_member가 mention_not_member에 걸린다. [a-z_]+ 토큰을 떼어 표에 정확히 있는 첫 코드만 쓴다.
export function dbErrorMessage(err: { message: string } | null | undefined, fallback: string): string {
  for (const token of err?.message.match(/[a-z_]+/g) ?? []) if (has(token)) return ERROR_MESSAGES[token];
  return fallback;
}

// 상태 0(요청이 서버에 닿지 못함)이나 5xx는 "코드가 틀렸다"가 아니다. 호출한 쪽이 연결 문구를 고른다.
export const NETWORK_MESSAGE = '연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.';

// 엔진 실패 문구(살펴보기·거울): 서버 글은 내지 않고 상태(EngineError.status)로 고정 문구만(429·연결), 그 밖은 화면마다 다른 generic.
export function engineErrorCopy(e: unknown, generic: string): string {
  const s = (e as { status?: unknown } | null)?.status;
  if (s === 429) return '요청이 많아요. 잠시 뒤 다시 해 주세요.';
  if (s === 0 || s === 503) return NETWORK_MESSAGE;
  return generic;
}

// 읽기 실패 문구: 코드가 있는 DB 오류는 고정 문구(fallback 또는 아는 코드), 그 밖(연결 끊김 등)은 연결 문구. 서버 글은 내지 않는다.
export const loadErrorMessage = (e: unknown, fallback: string): string => ((e as { code?: string })?.code ? dbErrorMessage(e as { message: string }, fallback) : NETWORK_MESSAGE);
export const isUnreachable = (status: number | undefined): boolean => status === 0 || (status !== undefined && status >= 500);
