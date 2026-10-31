// 거울 탭의 순수 함수. 점수는 늘 "차이"로만 말한다(MASTER 거울 원칙).
import { engineErrorCopy } from './dbErrors';
import { EngineError, type MirrorTodayRes } from './engine';

export type Card = MirrorTodayRes['cards'][number];

const NATIVE = ['', '한', '두', '세', '네'];

/** base: 예측 맞히기는 '예측', 되돌려 받기는 '내 느낌'. 숫자 칸(1~5)의 차이라 0~4. */
export function gapLabel(gap: number | null | undefined, base: '예측' | '내 느낌'): string | null {
  if (gap == null) return null;
  if (gap === 0) return `${base}과 같았어요`;
  return `${base}과 ${NATIVE[gap] ?? gap} 칸 차이`;
}

/** 받침이 있으면 이라면, 없으면 라면. 한글이 아닌 끝 글자는 받침 없음으로 본다. */
export function relationIf(relation: string): string {
  const code = relation.charCodeAt(relation.length - 1);
  const hasFinal = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  return relation + (hasFinal ? '이라면' : '라면');
}

/** 고친 문장(b)의 어절 중 원문(a)에 없는 어절에 changed 표시. 어절 단위 LCS. */
export function changedWords(a: string, b: string): { text: string; changed: boolean }[] {
  const x = a.split(/\s+/).filter(Boolean);
  const y = b.split(/\s+/).filter(Boolean);
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { text: string; changed: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (j < y.length) {
    if (i < x.length && x[i] === y[j]) (out.push({ text: y[j], changed: false }), i++, j++);
    else if (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else out.push({ text: y[j++], changed: true });
  }
  return out;
}

/** 422: 서명된 카드가 바뀌었거나 낡았다. 다시 받아야 답할 수 있다. */
export const isStaleCard = (e: unknown) => e instanceof EngineError && e.status === 422;

/** 서버가 준 글은 보여 주지 않는다. 상태로 고정 문구만. */
export const mirrorErrorCopy = (e: unknown) => (isStaleCard(e) ? '카드가 바뀌었을 수도 있어요. 새로 받아 주세요.' : engineErrorCopy(e, '지금은 이 카드에 답하지 못했어요. 잠시 뒤 다시 해 주세요.'));
