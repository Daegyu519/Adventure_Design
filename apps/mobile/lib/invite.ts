import type { Checked } from './auth';
import { dbErrorMessage, isUnreachable, NETWORK_MESSAGE } from './dbErrors';

// rooms.relation·invites.relation의 check 값. 생성된 db.ts는 check 제약을 string으로만 주므로 값 목록은 여기 한 곳에 두고,
// 마이그레이션 SQL과 어긋나면 __tests__/invite.test.ts가 깨진다.
export const RELATIONS = ['친구', '팀원', '선후배', '기타'] as const;
export type Relation = (typeof RELATIONS)[number];

export const GROUP_MAX = 8; // room_members_cap 트리거의 그룹 상한
export const INVITE_CODE_LENGTH = 8; // create_invite가 만드는 코드 길이(A-Z0-9)

// 붙여 넣은 코드의 공백·하이픈을 지우고 대문자로 바꾼 뒤 DB 규칙(영문 대문자·숫자 8자)일 때만 돌려준다.
export function normalizeInviteCode(s: string): string | null {
  const t = s.replace(/[\s-]+/g, '').toUpperCase();
  return new RegExp(`^[A-Z0-9]{${INVITE_CODE_LENGTH}}$`).test(t) ? t : null;
}

export const inviteErrorMessage = (err: { message: string } | null): string => dbErrorMessage(err, '코드를 확인해 주세요');

// rooms.title은 Postgres char_length 1~30(코드포인트). JS 길이가 아니라 [...s]로 센다.
export function validateGroupTitle(s: string): Checked {
  const value = s.trim();
  const n = [...value].length;
  if (n === 0) return { ok: false, message: '방 이름을 적어 주세요' };
  if (n > 30) return { ok: false, message: '30자까지 쓸 수 있어요' };
  return { ok: true, value };
}

// 그룹 방의 초대 코드를 만든다(rooms/new.tsx의 create_invite 호출과 같은 모양). 성공이면 코드, 아니면 화면에 낼 고정 문구만.
// 서버에 닿지 못했거나(상태 0·5xx·던짐) 응답이 이상하면 코드 탓을 하지 않는다.
export async function createGroupInvite(
  rpc: PromiseLike<{ data: unknown; error: { message: string } | null; status: number }>,
): Promise<{ ok: true; code: string } | { ok: false; message: string }> {
  try {
    const { data, error, status } = await rpc;
    if (error || typeof data !== 'string' || !data) return { ok: false, message: isUnreachable(status) ? NETWORK_MESSAGE : dbErrorMessage(error, '코드를 만들지 못했어요. 잠시 뒤 다시 해 주세요.') };
    return { ok: true, code: data };
  } catch {
    return { ok: false, message: NETWORK_MESSAGE };
  }
}
