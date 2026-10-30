import { act } from 'react';
import { createRoot } from 'test-renderer';

import { DiffText } from '../components/DiffText';

async function label(original: string, revised: string) {
  const root = createRoot();
  await act(async () => {
    root.render(<DiffText original={original} revised={revised} />);
  });
  return root.container.queryAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.role === 'img')[0]?.props.accessibilityLabel as string;
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

test('DiffText: 끝에 문장부호가 없어도 문장과 바뀐 말 사이가 구분된다', async () => {
  expect(await label('안 돼요', '미안해요 안 돼요')).toBe('고친 문장: 미안해요 안 돼요. 바뀐 말: 미안해요');
});
test('DiffText: 바뀐 말과 빠진 말이 함께 있으면 둘 다 알린다(말만 바꾼 경우는 빠졌다고 하지 않는다)', async () => {
  expect(await label('가 나 다', '가 라')).toBe('고친 문장: 가 라. 바뀐 말: 라. 빠진 말도 있어요');
  expect(await label('가 나', '가 라')).toBe('고친 문장: 가 라. 바뀐 말: 라');
});
test('DiffText: 이름은 role=img 하나에 있고, 탭으로 멈추는 곳이 아니며, 글자 조각은 가리지 않는다', async () => {
  const root = createRoot();
  await act(async () => {
    root.render(<DiffText original="안 돼요" revised="미안해요 안 돼요" />);
  });
  const img = root.container.queryAll((n) => n.props.role === 'img');
  expect(img).toHaveLength(1);
  expect(img[0].props.accessible).toBeUndefined();
  expect(img[0].props.tabIndex).toBeUndefined();
  expect(root.container.queryAll((n) => n.props['aria-hidden'] === true)).toHaveLength(0);
});
