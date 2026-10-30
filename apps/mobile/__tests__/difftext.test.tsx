import { act } from 'react';
import { createRoot } from 'test-renderer';

import { DiffText } from '../components/DiffText';

async function label(original: string, revised: string) {
  const root = createRoot();
  await act(async () => {
    root.render(<DiffText original={original} revised={revised} />);
  });
  return root.container.queryAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessible)[0]?.props.accessibilityLabel as string;
}

test('DiffText: 읽어 주는 이름에 고친 문장과 바뀐 말이 나온다', async () => {
  expect(await label('안 돼요. 알아서 하세요.', '미안해요. 안 돼요. 같이 하세요.')).toBe('고친 문장: 미안해요. 안 돼요. 같이 하세요. 바뀐 말: 미안해요., 같이');
});
test('DiffText: 말이 빠지기만 했으면 빠진 말이 있다고 알린다', async () => {
  expect(await label('안 돼요 지금은', '안 돼요')).toBe('고친 문장: 안 돼요. 빠진 말이 있어요');
});
test('DiffText: 같으면 바뀐 말 없음', async () => {
  expect(await label('네', '네')).toBe('고친 문장: 네. 바뀐 말은 없어요');
});
