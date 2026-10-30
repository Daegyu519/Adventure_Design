import { activeMentionQuery, extractMentions, insertMention, splitMentions } from '../mentions';

const ME = 'me', J = 'j', J2 = 'j2';
test('activeMentionQuery: after @ at word start', () => expect(activeMentionQuery('회의 @지', 5)).toBe('지'));
test('activeMentionQuery: bare @ → empty query', () => expect(activeMentionQuery('@', 1)).toBe(''));
test('activeMentionQuery: email-like or after space → null', () => {
  expect(activeMentionQuery('a@b', 3)).toBeNull();
  expect(activeMentionQuery('@지은 ', 4)).toBeNull();
});
test('activeMentionQuery uses text before the cursor only', () => expect(activeMentionQuery('@지은 안녕', 2)).toBe('지'));
test('insertMention replaces the query', () => expect(insertMention('회의 @지', 5, '지은')).toEqual({ text: '회의 @지은 ', cursor: 7 }));
test('insertMention keeps text after the cursor', () => expect(insertMention('@지 안녕', 2, '지은')).toEqual({ text: '@지은  안녕', cursor: 4 }));
test('extractMentions prefers the longest name, once, not me', () => {
  expect(extractMentions('@지은이 왔어 @지은이', [{ user_id: J, name: '지은' }, { user_id: J2, name: '지은이' }], ME)).toEqual([J2]);
  expect(extractMentions('@나 안녕', [{ user_id: ME, name: '나' }], ME)).toEqual([]);
});
test('extractMentions: name must end at space/punctuation/end, @ at word start', () => {
  const m = [{ user_id: J, name: '지은' }];
  expect(extractMentions('@지은이', m, ME)).toEqual([]);
  expect(extractMentions('a@지은', m, ME)).toEqual([]);
  expect(extractMentions('@지은, 안녕', m, ME)).toEqual([J]);
});
test('splitMentions marks @name segments', () =>
  expect(splitMentions('@지은 안녕', ['지은'])).toEqual([{ text: '@지은', mention: true }, { text: ' 안녕', mention: false }]));
test('splitMentions without mentions is one segment', () => expect(splitMentions('안녕', ['지은'])).toEqual([{ text: '안녕', mention: false }]));
test('longest name wins when one name is a prefix of another at a word boundary', () => {
  const m = [{ user_id: J, name: '김' }, { user_id: J2, name: '김 지은' }];
  expect(extractMentions('@김 지은 안녕', m, ME)).toEqual([J2]);
  expect(splitMentions('@김 지은 안녕', ['김', '김 지은'])[0]).toEqual({ text: '@김 지은', mention: true });
});
