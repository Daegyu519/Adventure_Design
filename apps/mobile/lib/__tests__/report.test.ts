import { barHeights, formatRate, gapTile, kstDate, thisWeekCount, weekLabel, weekSpoken, weekStart, WEEKS_SHOWN } from '../report';

test('formatRate rounds to whole percent', () => expect(formatRate(0.375)).toBe('38%'));
test('formatRate: null or NaN → dash', () => {
  expect(formatRate(null)).toBe('–');
  expect(formatRate(NaN)).toBe('–');
});
test('barHeights: tallest gets maxPx, nonzero at least 4px', () => expect(barHeights([0, 1, 10], 100)).toEqual([0, 10, 100]));
test('barHeights: all zero → zeros, no NaN', () => expect(barHeights([0, 0], 100)).toEqual([0, 0]));
test('barHeights: tiny nonzero is clamped to 4', () => expect(barHeights([1, 100], 100)[0]).toBe(4));
test('weekLabel', () => expect(weekLabel('2026-10-19')).toBe('10/19'));
test('weekLabel: no zero padding, cut from the string (no timezone shift)', () => expect(weekLabel('2026-09-05')).toBe('9/5'));
test('weekSpoken reads month and day for screen readers', () => expect(weekSpoken('2026-10-19')).toBe('10월 19일'));
test('WEEKS_SHOWN matches the 5 weeks the engine returns', () => expect(WEEKS_SHOWN).toBe(5));

test('gapTile: last entry avg_gap with one decimal, caption carries its own week', () =>
  expect(gapTile([{ week: '2026-10-12', avg_gap: 1.25 }, { week: '2026-10-19', avg_gap: 0.8 }])).toEqual({ value: '0.8칸', label: '10/19 주 예측과의 차이' }));
test('gapTile: an older last entry keeps its own week and a whole gap keeps one decimal', () =>
  expect(gapTile([{ week: '2026-10-12', avg_gap: 2 }])).toEqual({ value: '2.0칸', label: '10/12 주 예측과의 차이' }));
test('gapTile: no trend → dash and a caption without a week', () => expect(gapTile([])).toEqual({ value: '–', label: '예측과의 차이' }));

test('kstDate: a UTC evening is already the next day in KST', () => {
  expect(kstDate(new Date('2026-10-27T15:30:00Z'))).toBe('2026-10-28');
  expect(kstDate(new Date('2026-10-27T14:59:59Z'))).toBe('2026-10-27');
});
test('weekStart: Monday of the ISO week, across a month boundary and for a Sunday', () => {
  expect(weekStart('2026-10-26')).toBe('2026-10-26'); // 월
  expect(weekStart('2026-10-28')).toBe('2026-10-26'); // 수
  expect(weekStart('2026-11-01')).toBe('2026-10-26'); // 일은 앞 주
  expect(weekStart('2026-11-03')).toBe('2026-11-02'); // 달이 바뀐 주
});
test('thisWeekCount: count of the KST week that contains today', () => {
  const byWeek = [{ week: '2026-10-26', count: 5 }, { week: '2026-11-02', count: 4 }];
  expect(thisWeekCount(byWeek, '2026-11-04')).toBe(4);
  expect(thisWeekCount(byWeek, '2026-11-01')).toBe(5); // 일요일은 앞 주
});
test('thisWeekCount: this week missing → 0', () => expect(thisWeekCount([{ week: '2026-10-26', count: 5 }], '2026-11-09')).toBe(0));
