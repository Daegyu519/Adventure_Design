export const TYPING_THROTTLE_MS = 2000;
export const TYPING_IDLE_MS = 3000;
export type PresenceState = Record<string, { user_id: string; typing: boolean }[]>;

// 나를 뺀, 지금 입력 중인 사람(같은 사람의 여러 기기는 한 명).
export function typingLabel(state: PresenceState, me: string, names: Record<string, string>): string | null {
  const ids = new Set(Object.values(state).flat().filter((p) => p.typing && p.user_id !== me).map((p) => p.user_id));
  if (ids.size === 0) return null;
  if (ids.size === 1) return `${names[[...ids][0]] ?? '상대'}님이 입력 중`;
  return `${ids.size}명이 입력 중`;
}
