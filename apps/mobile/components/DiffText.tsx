import { Fragment } from 'react';

import { changedWords } from '../lib/mirror';
import { AppText } from './AppText';

// 고친 문장에서 원문과 달라진 어절만 primary 글자 + 밑줄(MASTER). 밑줄이 있어 색만으로 전하지 않는다.
export function DiffText({ original, revised }: { original: string; revised: string }) {
  const words = changedWords(original, revised);
  const changed = words.filter((w) => w.changed).map((w) => w.text);
  const removed = original.split(/\s+/).filter(Boolean).length - words.filter((w) => !w.changed).length;
  // 밑줄·색은 눈에만 보인다. 화면 읽기 프로그램에는 고친 문장 전체와 바뀐 말을 이름으로 준다(글자 조각은 가린다).
  const note = changed.length ? `바뀐 말: ${changed.join(', ')}` : removed > 0 ? '빠진 말이 있어요' : '바뀐 말은 없어요';
  return (
    <AppText selectable accessible accessibilityLabel={`고친 문장: ${revised}${changed.length ? ' ' : '. '}${note}`}>
      {words.map((w, i) => (
        <Fragment key={i}>
          {i ? ' ' : ''}
          <AppText aria-hidden color={w.changed ? 'primary' : 'text'} weight={w.changed ? '600' : '400'} style={w.changed ? { textDecorationLine: 'underline' } : undefined}>
            {w.text}
          </AppText>
        </Fragment>
      ))}
    </AppText>
  );
}
