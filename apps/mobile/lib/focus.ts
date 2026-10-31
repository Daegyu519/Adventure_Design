import type { ComponentRef, RefObject } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, type View } from 'react-native';

// 웹은 tabIndex=-1인 View에 focus(), 네이티브는 접근성 포커스. 실패해도 화면은 쓸 수 있어 조용히 넘어간다.
export function focusNode(ref: RefObject<ComponentRef<typeof View> | null>, inner?: string) {
  const node = ref.current;
  if (!node) return;
  try {
    if (Platform.OS === 'web') {
      const el = node as unknown as HTMLElement;
      (inner ? (el.querySelector(inner) as HTMLElement | null) : el)?.focus?.();
    } else {
      const h = findNodeHandle(node);
      if (h) AccessibilityInfo.setAccessibilityFocus(h);
    }
  } catch {}
}

/** delay 뒤 목표로 포커스. 웹은 Modal이 닫히며 자기 포커스 복원을 끝낸 뒤에 닿도록 닿을 때까지 50ms 간격으로 최대 10번(고정 지연 한 번에 기대지 않는다),
 * 네이티브는 한 번. delay 0 = 바로 첫 시도(동작 줄이기). 돌려준 함수로 남은 시도를 취소한다(effect 정리용). */
export function retryFocus(get: () => { focus(): void } | null, { delay }: { delay: number }): () => void {
  const web = Platform.OS === 'web' && typeof document !== 'undefined';
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    const el = get();
    el?.focus();
    if (web && document.activeElement !== el && ++tries < 10) timer = setTimeout(step, 50);
  };
  if (delay > 0) timer = setTimeout(step, delay);
  else step();
  return () => clearTimeout(timer);
}
