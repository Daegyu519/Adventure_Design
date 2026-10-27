import { barHeights, formatRate, latestGap, weekLabel, weekSpoken, WEEKS_SHOWN } from '../report';

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
test('latestGap: last entry avg_gap with one decimal, labeled with its own week', () =>
  expect(latestGap([{ week: '2026-10-12', avg_gap: 1.25 }, { week: '2026-10-19', avg_gap: 0.8 }])).toBe('10/19 주 예측과 평균 0.8칸 차이'));
test('latestGap: an older last entry keeps its own week label', () =>
  expect(latestGap([{ week: '2026-10-12', avg_gap: 2 }])).toBe('10/12 주 예측과 평균 2.0칸 차이'));
test('latestGap: empty → null', () => expect(latestGap([])).toBeNull());
test('WEEKS_SHOWN matches the 5 weeks the engine returns', () => expect(WEEKS_SHOWN).toBe(5));
