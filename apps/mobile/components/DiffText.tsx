import { Fragment } from 'react';

import { changedWords } from '../lib/mirror';
import { AppText } from './AppText';

// 고친 문장에서 원문과 달라진 어절만 primary 글자 + 밑줄(MASTER). 밑줄이 있어 색만으로 전하지 않는다.
export function DiffText({ original, revised }: { original: string; revised: string }) {
  return (
    <AppText selectable>
      {changedWords(original, revised).map((w, i) => (
        <Fragment key={i}>
          {i ? ' ' : ''}
          <AppText color={w.changed ? 'primary' : 'text'} weight={w.changed ? '600' : '400'} style={w.changed ? { textDecorationLine: 'underline' } : undefined}>
            {w.text}
          </AppText>
        </Fragment>
      ))}
    </AppText>
  );
}
