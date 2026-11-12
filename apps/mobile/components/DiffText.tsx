import { Fragment } from 'react';

import { changedWords } from '../lib/mirror';
import type { Colors } from '../lib/theme';
import { AppText } from './AppText';

// 고친 문장에서 원문과 달라진 어절만 primary 글자 + 밑줄(MASTER). 밑줄이 있어 색만으로 전하지 않는다.
// base/changed: 말풍선(primary 바탕) 안에서는 둘 다 onPrimary로 둔다(밑줄이 달라진 어절을 알린다).
export function DiffText({ original, revised, base = 'text', changedColor = 'primary' }: { original: string; revised: string; base?: keyof Colors; changedColor?: keyof Colors }) {
  const words = changedWords(original, revised);
  const changed = words.filter((w) => w.changed).map((w) => w.text);
  const removed = original.split(/\s+/).filter(Boolean).length - words.filter((w) => !w.changed).length;
  // 밑줄·색은 눈에만 보인다. 화면 읽기 프로그램에는 고친 문장 전체와 바뀐 말을 이름으로 준다.
  // 이름은 role=img에 둔다(역할 없는 요소의 aria-label은 웹에서 읽히지 않을 수 있다). 말만 바꾼 것(바뀐 수 = 사라진 수)은 빠졌다고 하지 않는다.
  const notes = [changed.length ? `바뀐 말: ${changed.join(', ')}` : removed > 0 ? '빠진 말이 있어요' : '바뀐 말은 없어요'];
  if (changed.length && removed > changed.length) notes.push('빠진 말도 있어요');
  const sep = /[.!?…]$/.test(revised.trim()) ? ' ' : '. '; // 끝 부호가 없으면 문장과 안내가 붙지 않게
  return (
    <AppText selectable role="img" accessibilityLabel={`고친 문장: ${revised}${sep}${notes.join('. ')}`}>
      {words.map((w, i) => (
        <Fragment key={i}>
          {i ? ' ' : ''}
          <AppText color={w.changed ? changedColor : base} weight={w.changed ? '600' : '400'} style={w.changed ? { textDecorationLine: 'underline' } : undefined}>
            {w.text}
          </AppText>
        </Fragment>
      ))}
    </AppText>
  );
}
