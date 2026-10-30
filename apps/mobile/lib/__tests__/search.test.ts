import { highlight, ilikePattern, keepMatches } from '../search';

test('ilikePattern escapes % and _', () => {
  expect(ilikePattern('50%')).toBe('%50\\%%');
  expect(ilikePattern('a_b')).toBe('%a\\_b%');
});
test('ilikePattern escapes backslash', () => expect(ilikePattern('a\\b')).toBe('%a\\\\b%'));
test('ilikePattern: blank → null', () => expect(ilikePattern('  ')).toBeNull());
test('highlight is case-insensitive and lossless', () => {
  const s = highlight('Hello hello', 'HELLO');
  expect(s.filter((x) => x.match).length).toBe(2);
  expect(s.map((x) => x.text).join('')).toBe('Hello hello');
});
test('highlight: blank query is one plain part', () => expect(highlight('abc', ' ')).toEqual([{ text: 'abc', match: false }]));
test('keepMatches drops PostgREST * wildcard false positives', () => {
  const rows = [{ text: 'a*b' }, { text: 'axb' }];
  expect(keepMatches(rows, 'a*b')).toEqual([{ text: 'a*b' }]);
});
