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

// ---- 카드 덱(한 장씩) ----
/** 칸마다 붙는 말(평가하지 않고 느낌만). 역할극에는 칸이 없다. */
export const SCALE_WORDS: Partial<Record<Card['kind'], readonly string[]>> = {
  receive: ['포근해요', '무난해요', '살짝 서늘해요', '차가워요', '얼음장 같아요'],
  predict: ['편하게 읽혀요', '괜찮게 읽혀요', '살짝 걸려요', '꽤 불편해요', '많이 불편해요'],
};

/** 마무리 격려: 두 줄로 직접 끊는다(의미가 줄 사이에서 갈라지지 않게). 점수·평가 없이 한 일을 따뜻하게 짚는다. */
export const CHEERS: readonly (readonly [string, string])[] = [
  ['따뜻한 말에', '오늘도 한 걸음 가까워졌어요'],
  ['보내기 전의 한 번,', '오늘도 잊지 않았어요'],
  ['내 말이 닿을 마음을', '한 번 더 헤아려 본 하루예요'],
  ['말 한마디를 고르는 마음이', '오늘도 조금 자랐어요'],
];
export const pickCheer = (seed: number) => CHEERS[Math.abs(Math.trunc(seed)) % CHEERS.length];

/** 마무리 "오늘 한 일" 한 줄(한 줄에 들어가는 길이). 점수가 아니라 한 일. */
export function didLine(kind: Card['kind'], r: { choice?: 'keep' | 'a' | null; gap?: number | null }): string {
  if (kind === 'roleplay') return r.choice === 'a' ? '부드러운 문장으로 바꿔 봤어요' : '내 답장을 다시 읽어 봤어요';
  if (kind === 'receive') return '받는 쪽 마음으로 느껴 봤어요';
  return r.gap === 0 ? '상대의 읽힘을 꼭 맞게 짐작했어요' : '상대의 읽힘을 헤아려 봤어요';
}

/** 받는 쪽 칸은 엔진이 숨긴다(차이만 준다). 내 칸에서 gap만큼 떨어진 칸 후보(1~5 안)만 돌려준다. */
export function gapCandidates(value: number, gap: number): number[] {
  const c = gap === 0 ? [value] : [value - gap, value + gap];
  return c.filter((v) => v >= 1 && v <= 5);
}

/** 은/는: 받침 있으면 은, 없으면 는. 한글이 아니면 는. */
export function eunNeun(word: string): string {
  const code = word.charCodeAt(word.length - 1);
  const hasFinal = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  return word + (hasFinal ? '은' : '는');
}
