import { engineErrorCopy } from './dbErrors';
import type { DetailReq } from './engine';

// 살펴보기 시트의 상수. 의도 어긋남 문구는 엔진이 만들어 주므로 앱에는 없다.
export type Intent = NonNullable<DetailReq['intent']>;
export const INTENTS: readonly Intent[] = ['단호하게', '미안하게', '가볍게'];

// 엔진 OPTION_LABELS와 같은 문자열. A/B는 표시 순서가 아니라 label로 정한다(확인을 못 넘긴 후보는 빠지므로 하나만 와도 B일 수 있다).
const OPTION_CHOICES: Record<string, 'A' | 'B'> = { '조금만 바꾼 문장': 'A', '가장 부드럽게 바꾼 문장': 'B' };
export const choiceOf = (label: string): 'A' | 'B' | null => OPTION_CHOICES[label] ?? null;

/** 서버가 준 글은 보여 주지 않는다. 상태로 고정 문구만. */
export const detailErrorCopy = (e: unknown) => engineErrorCopy(e, '지금은 살펴보기 어려워요. 잠시 뒤 다시 해 주세요.');
