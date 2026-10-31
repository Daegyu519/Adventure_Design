import { Platform, Share } from 'react-native';

import type { Checked } from './auth';
import { dbErrorMessage, isUnreachable, NETWORK_MESSAGE } from './dbErrors';

// rooms.relation·invites.relation의 check 값. 생성된 db.ts는 check 제약을 string으로만 주므로 값 목록은 여기 한 곳에 두고,
// 마이그레이션 SQL과 어긋나면 __tests__/invite.test.ts가 깨진다.
export const RELATIONS = ['친구', '팀원', '선후배', '기타'] as const;
export type Relation = (typeof RELATIONS)[number];

export const GROUP_MAX = 8; // room_members_cap 트리거의 그룹 상한
export const INVITE_CODE_LENGTH = 8; // create_invite가 만드는 코드 길이(A-Z0-9)

// 붙여 넣은 글에서 코드(영문 대문자·숫자 8자)를 꺼낸다. 보이지 않는 글자를 지우고 대문자로 바꾼 뒤,
// 공백·대시(- – —)를 지운 전체가 8자면 그것, 아니면 공유 문구("초대 코드: ABCD1234")에서 따로 떨어진 마지막 8자.
export function normalizeInviteCode(s: string): string | null {
  const t = s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').toUpperCase();
  const whole = t.replace(/[\s\-\u2013\u2014]+/g, '');
  if (new RegExp(`^[A-Z0-9]{${INVITE_CODE_LENGTH}}$`).test(whole)) return whole;
  const runs = [...t.matchAll(new RegExp(`(?:^|[^A-Z0-9])([A-Z0-9]{${INVITE_CODE_LENGTH}})(?=[^A-Z0-9]|$)`, 'g'))];
  return runs.at(-1)?.[1] ?? null;
}


// rooms.title은 Postgres char_length 1~30(코드포인트). JS 길이가 아니라 [...s]로 센다.
export function validateGroupTitle(s: string): Checked {
  const value = s.trim();
  const n = [...value].length;
  if (n === 0) return { ok: false, message: '방 이름을 적어 주세요' };
  if (n > 30) return { ok: false, message: '30자까지 쓸 수 있어요' };
  return { ok: true, value };
}

// 초대·방 RPC 한 번(create_invite·create_group·accept_invite). 성공이면 문자열 결과(코드·방 id), 아니면 화면에 낼 고정 문구만:
// 서버 글은 내지 않고(raise exception 코드로만 고른다, 모르는 코드는 fallback), 서버에 닿지 못했거나(상태 0·5xx·던짐) 응답이 이상하면 코드 탓을 하지 않는다.
export async function rpcText(
  rpc: PromiseLike<{ data: unknown; error: { message: string } | null; status: number }>,
  fallback: string,
): Promise<{ ok: true; data: string } | { ok: false; message: string }> {
  try {
    const { data, error, status } = await rpc;
    if (error || typeof data !== 'string' || !data) return { ok: false, message: isUnreachable(status) ? NETWORK_MESSAGE : dbErrorMessage(error, fallback) };
    return { ok: true, data };
  } catch {
    return { ok: false, message: NETWORK_MESSAGE };
  }
}
export const MAKE_FAILED = '코드를 만들지 못했어요. 잠시 뒤 다시 해 주세요.';

// 초대 코드 보내기. 웹 데스크톱에는 공유 창(navigator.share)이 없을 수 있다: 그때는 복사.
// 돌려주는 값은 화면에 낼 결과 문구(공유했거나 공유 창을 닫았으면 null).
export async function shareInviteCode(code: string): Promise<string | null> {
  const message = `초대 코드: ${code}`;
  try {
    if (Platform.OS !== 'web') await Share.share({ message });
    else if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') await navigator.share({ text: message });
    else {
      await navigator.clipboard.writeText(code);
      return '복사했어요';
    }
    return null;
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return null; // 공유 창을 닫은 것
    return '복사하지 못했을 수도 있어요. 위의 코드를 눌러 직접 복사해 주세요.';
  }
}
