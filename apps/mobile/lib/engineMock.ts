// EXPO_PUBLIC_ENGINE_URL이 없을 때 쓰는 가짜 엔진. 모양은 생성 타입 그대로, 값은 고정 예시다.
import { abortError } from './abort';
import type { DetailRes, Engine } from './engine';

const MOCK_DELAY_MS = 300;

// 엔진 응답처럼 조금 늦게 돌려주되, 호출자가 끊으면 바로 AbortError.
function wait(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, MOCK_DELAY_MS);
    signal?.addEventListener('abort', onAbort);
  });
}

const READINGS: DetailRes['readings'] = { 차갑게: '자주', 성의없게: '가끔', 화나게: '드물어요', 무난하게: '가끔', 따뜻하게: '드물어요' };
const INTENT_PREFIX: Record<string, string> = { 미안하게: '미안하지만 ', 가볍게: '앗 ', 단호하게: '' };
// ARCHITECTURE 6-5 상세 각주
const FOOTNOTE = '비슷한 대화에서 모인 반응을 바탕으로 한 조언이라 틀릴 수도 있어요. 누가 어떤 반응을 남겼는지는 알 수 없어요.';

const softer = (text: string, intent?: string | null) => ({
  label: '조금만 바꾼 문장', // 엔진 OPTION_LABELS[0]
  text: (intent ? INTENT_PREFIX[intent] ?? '' : '') + text + ' 다음엔 같이 맞춰 볼게요.',
  keep: ['거절하는 뜻'],
  change: ['다음을 약속하는 말을 더했어요'],
});

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 이번 주 월요일을 포함한 최근 5주(오래된 것부터)
function lastFiveMondays() {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return [4, 3, 2, 1, 0].map((i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() - 7 * i);
    return ymd(d);
  });
}

export function createMockEngine(): Engine {
  return {
    isMock: true,

    async hint(b, o) {
      await wait(o?.signal);
      const t = b.text.trim();
      const cold = t.endsWith('.') || /안 돼|싫|알아서/.test(t);
      return {
        seq: b.seq,
        hint: cold ? { title: '차갑게 느껴질 수도 있어요', detail: '이유 없이 거절하는 말로 읽힐 수도 있어요' } : null,
        trace_id: 'mock',
      };
    },

    async detail(b, o) {
      await wait(o?.signal);
      return {
        alert: true,
        top_reading: '차갑게',
        readings: READINGS,
        why: ['이유 없이 짧게 끊으면 거절이 차갑게 읽힐 수도 있어요', '마침표로 끝나면 대화를 닫는 말처럼 느껴질 수도 있어요'],
        options: [
          softer(b.text, b.intent),
          { label: '가장 부드럽게 바꾼 문장', text: '미안해요, ' + b.text, keep: ['거절하는 뜻'], change: ['사과로 시작해요'] }, // OPTION_LABELS[1]
        ],
        mismatch: b.intent === '미안하게' ? '미안하게 말하려던 것과 달리 차갑게 읽힐 수도 있어요' : null,
        footnote: FOOTNOTE,
        trace_id: 'mock',
      };
    },

    async feedback(_b, o) {
      await wait(o?.signal);
      return { ack: '남겨 주셔서 고마워요. 누가 남겼는지는 드러나지 않아요.' };
    },

    async stats(o) {
      await wait(o?.signal);
      const weeks = lastFiveMondays();
      return {
        hints: 12,
        details: 5,
        fixed: 4,
        fix_rate: 0.33,
        hints_by_week: [1, 0, 3, 5, 3].map((count, i) => ({ week: weeks[i], count })),
        predict_gap_trend: [
          { week: weeks[3], avg_gap: 1.5 },
          { week: weeks[4], avg_gap: 0.8 },
        ],
      };
    },

    async mirrorToday(o) {
      await wait(o?.signal);
      return {
        cards: [
          { card_id: 'mock-roleplay', kind: 'roleplay', persona: '민지', relation: '팀원', situation: '발표 전날, 자료 정리를 나누는 중', message: '혹시 오늘 밤까지 자료 정리 같이 해 줄 수 있어요?' },
          { card_id: 'mock-receive', kind: 'receive', persona: '민지', relation: '팀원', situation: '회의 시간을 다시 잡는 중', message: '안 돼요. 다들 맞춰서 하는 중이에요.' },
          { card_id: 'mock-predict', kind: 'predict', persona: '민지', relation: '선배', situation: '마감을 앞두고 역할을 정하는 중', message: '알아서 해 주세요.' },
        ],
      };
    },

    async mirrorAnswer(b, o) {
      await wait(o?.signal);
      if (b.reply != null) {
        return { readings: READINGS, inner_voice: '바쁜 건 알겠는데, 조금 서운할 수도 있어요', options: [softer(b.reply)] };
      }
      if (b.score != null) {
        return { readings: READINGS, reveal: '이건 지난주 목요일에 당신이 팀원에게 보낸 문장이에요', gap: Math.abs(b.score - 4) };
      }
      return { readings: READINGS, gap: Math.abs((b.predicted ?? 3) - 3) };
    },
  };
}
