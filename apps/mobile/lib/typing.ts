export const TYPING_THROTTLE_MS = 2000;
export const TYPING_IDLE_MS = 3000;
export type PresenceState = Record<string, { user_id: string; typing: boolean }[]>;

// 신원은 presenceState의 키(= 로그인한 내 id로 입장한 키)에서만 얻는다. 페이로드의 user_id는 보낸 사람이 정하므로 키와 다르면 버린다.
// names에 있는 사람(= 현재 방 멤버)만 보인다. 나는 뺀다. 같은 사람의 여러 기기는 한 명.
export function typingLabel(state: PresenceState, me: string, names: Record<string, string>): string | null {
  const ids = Object.entries(state)
    .filter(([key, list]) => key !== me && Object.prototype.hasOwnProperty.call(names, key) && list.some((p) => p.typing && p.user_id === key))
    .map(([key]) => key);
  if (ids.length === 0) return null;
  return ids.length === 1 ? `${names[ids[0]]}님이 입력 중` : `${ids.length}명이 입력 중`;
}
