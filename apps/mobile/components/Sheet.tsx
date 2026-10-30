import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Modal, Platform, Pressable, View } from 'react-native';

import { MOTION_MS, useReducedMotion } from '../lib/motion';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Button } from './Button';

// 아래에서 올라오는 시트. 배경(colors.text + opacity 0.4)을 누르면 닫힘, Android 뒤로·웹 Esc도 onRequestClose로 닫힌다.
// 웹의 Modal은 포커스를 안에 가두고 닫을 때 원래 자리로 돌려준다.
export function Sheet({ visible, onClose, title, children, initialFocus }: { visible: boolean; onClose(): void; title?: string; children: ReactNode; initialFocus?: string }) {
  const { colors, radius, space } = useTheme();
  const reduced = useReducedMotion();
  const [t] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!visible) return;
    if (reduced) return t.setValue(1);
    t.setValue(0);
    Animated.timing(t, { toValue: 1, duration: MOTION_MS, useNativeDriver: true }).start();
  }, [visible, reduced, t]);
  // 웹 Modal은 포커스를 안에 가두지만 처음 포커스를 첫 포커스 요소(배경)에 둔다. 첫 공감 버튼(nativeID)으로 옮긴다.
  useEffect(() => {
    if (!visible || !initialFocus || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const id = setTimeout(() => document.getElementById(initialFocus)?.focus(), 30);
    return () => clearTimeout(id);
  }, [visible, initialFocus]);
  return (
    <Modal transparent animationType="none" visible={visible} onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="닫기"
          onPress={onClose}
          // 마우스·터치용 닫기. 키보드·화면 읽기 프로그램은 시트 끝의 "닫기" 버튼과 Esc를 쓴다(배경은 탭 순서와 읽기 밖).
          tabIndex={-1}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.text, opacity: 0.4, ...focusRing(colors.primary) }}
        />
        <Animated.View
          role="dialog"
          aria-modal
          aria-label={title}
          accessibilityViewIsModal
          style={{
            opacity: t,
            transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
            backgroundColor: colors.background,
            borderTopLeftRadius: radius.sheet,
            borderTopRightRadius: radius.sheet,
            padding: space[3],
            gap: space[2],
          }}
        >
          {title ? (
            <AppText accessibilityRole="header" weight="600">
              {title}
            </AppText>
          ) : null}
          {children}
          <Button label="닫기" kind="ghost" onPress={onClose} />
        </Animated.View>
      </View>
    </Modal>
  );
}
