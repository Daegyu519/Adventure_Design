import { EngineError } from '../engine';
import { changedWords, gapLabel, isStaleCard, mirrorErrorCopy, relationIf } from '../mirror';

jest.mock('../supabase', () => ({ supabase: null }));

test('gapLabel 0', () => expect(gapLabel(0, '예측')).toBe('예측과 같았어요'));
test('gapLabel uses native numerals', () => {
  expect(gapLabel(1, '예측')).toBe('예측과 한 칸 차이');
  expect(gapLabel(2, '예측')).toBe('예측과 두 칸 차이');
});
test('gapLabel receive card', () => expect(gapLabel(4, '내 느낌')).toBe('내 느낌과 네 칸 차이'));
test('gapLabel missing → null', () => {
  expect(gapLabel(undefined, '예측')).toBeNull();
  expect(gapLabel(null, '예측')).toBeNull();
});
test('relationIf picks 이라면/라면 by final consonant', () => {
  expect(relationIf('팀원')).toBe('팀원이라면');
  expect(relationIf('선배')).toBe('선배라면');
  expect(relationIf('친구')).toBe('친구라면');
  expect(relationIf('PM')).toBe('PM라면');
});

test('changedWords marks only the words that differ from the original', () => {
  expect(changedWords('안 돼요. 알아서 하세요.', '미안해요. 안 돼요. 같이 하세요.')).toEqual([
    { text: '미안해요.', changed: true },
    { text: '안', changed: false },
    { text: '돼요.', changed: false },
    { text: '같이', changed: true },
    { text: '하세요.', changed: false },
  ]);
});
test('changedWords: identical text → nothing changed', () => {
  expect(changedWords('네 알겠어요', '네 알겠어요').every((w) => !w.changed)).toBe(true);
});

test('mirrorErrorCopy: fixed Korean copy by status, never the error message', () => {
  expect(mirrorErrorCopy(new EngineError(429, 'SERVER SECRET'))).toBe('요청이 많아요. 잠시 뒤 다시 해 주세요.');
  expect(mirrorErrorCopy(new EngineError(503, 'SERVER SECRET'))).toBe('연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.');
  expect(mirrorErrorCopy(new EngineError(0, 'timeout'))).toBe('연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 주세요.');
  expect(mirrorErrorCopy(new EngineError(422, 'bad_card'))).toBe('카드가 바뀌었을 수도 있어요. 새로 받아 주세요.');
  expect(isStaleCard(new EngineError(422))).toBe(true);
  expect(isStaleCard(new EngineError(429))).toBe(false);
  expect(mirrorErrorCopy(new Error('x'))).toBe('지금은 이 카드에 답하지 못했어요. 잠시 뒤 다시 해 주세요.');
});

// T-22: 살펴보기 시트도 같은 어절 비교(changedWords)를 쓴다.
const changed = (o: string, c: string) => changedWords(o, c).filter((s) => s.changed).map((s) => s.text);
test('changedWords spec example (살펴보기): only changed 어절', () =>
  expect(changed('안 돼요. 다들 맞춰서 하는 중이에요.', '지금은 어려워요. 다들 맞춰서 하는 중이라서요.')).toEqual(['지금은', '어려워요.', '중이라서요.']));
test('changedWords: punctuation attached to a word counts as a change', () => expect(changed('중이에요.', '중이에요')).toEqual(['중이에요']));
test('changedWords: repeated words are matched once', () => expect(changed('네 네 알겠어요', '네 알겠어요')).toEqual([]));
test('changedWords: empty original → every word changed', () => expect(changed('', '고마워요 정말')).toEqual(['고마워요', '정말']));

describe('카드 덱 도우미', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('../mirror') as typeof import('../mirror');
  test('격려 문구는 두 줄이고 어느 시드든 하나를 고른다(점수·순위 말 없음)', () => {
    for (const s of [0, 1, 7, -3, 2.9]) {
      const c = m.pickCheer(s);
      expect(c).toHaveLength(2);
      expect(c.join(' ')).not.toMatch(/점|등|순위|연속|최고/);
    }
  });
  test('gapCandidates: 차이만큼 떨어진 칸 후보, 1~5 밖은 뺀다', () => {
    expect(m.gapCandidates(3, 0)).toEqual([3]);
    expect(m.gapCandidates(3, 1)).toEqual([2, 4]);
    expect(m.gapCandidates(1, 2)).toEqual([3]);
    expect(m.gapCandidates(5, 4)).toEqual([1]);
  });
  test('칸마다 붙는 말은 5개', () => {
    expect(m.SCALE_WORDS.receive).toHaveLength(5);
    expect(m.SCALE_WORDS.predict).toHaveLength(5);
  });
  test('didLine·은는', () => {
    expect(m.didLine('predict', { gap: 0 })).toContain('꼭 맞게');
    expect(m.didLine('roleplay', { choice: 'a' })).toContain('바꿔');
    expect(m.eunNeun('선배')).toBe('선배는');
    expect(m.eunNeun('팀원')).toBe('팀원은');
  });
});
