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
