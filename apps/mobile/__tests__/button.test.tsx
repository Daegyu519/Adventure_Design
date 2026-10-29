import { act } from 'react';
import { createRoot } from 'test-renderer';

import { Button } from '../components/Button';

async function setup(p: { loading?: boolean; disabled?: boolean }) {
  const onPress = jest.fn();
  const root = createRoot();
  await act(async () => {
    root.render(<Button label="참여하기" onPress={onPress} {...p} />);
  });
  const btn = () => root.container.queryAll((n) => n.props.accessibilityRole === 'button')[0];
  const press = () => act(async () => btn().props.onClick({ stopPropagation() {}, nativeEvent: {} }));
  return { onPress, btn, press };
}

test('Button loading: disabled를 걸지 않아(포커스 유지) aria-disabled·aria-busy만 켜고, 눌림은 무시한다', async () => {
  const { btn, press, onPress } = await setup({ loading: true });
  expect(btn().props.disabled).toBeFalsy();
  // jest의 네이티브 렌더러는 aria-* 속성을 버린다. aria-disabled·aria-busy는 웹 빌드(브라우저)에서 확인한다.
  expect(btn().props.accessibilityState).toMatchObject({ busy: true });
  await press();
  expect(onPress).not.toHaveBeenCalled();
});

test('Button loading: 이름에 "처리 중"을 붙이고 스피너는 읽는 쪽에서 숨긴다', async () => {
  const { btn } = await setup({ loading: true });
  expect(btn().props.accessibilityLabel).toBe('참여하기, 처리 중');
  const spinner = btn().queryAll((n) => n.props['aria-hidden'] === true && n.props.importantForAccessibility === 'no-hide-descendants');
  expect(spinner.length).toBeGreaterThan(0);
});

test('Button idle: 이름 그대로, 눌림 전달; disabled prop은 그대로 disabled', async () => {
  const idle = await setup({});
  expect(idle.btn().props.accessibilityLabel).toBe('참여하기');
  expect(idle.btn().props.accessibilityState).toMatchObject({ busy: false, disabled: false });
  await idle.press();
  expect(idle.onPress).toHaveBeenCalledTimes(1);
  const off = await setup({ disabled: true });
  expect(off.btn().props.accessibilityState.disabled).toBe(true);
});
