import X from 'lucide-react-native/icons/x';
import { useEffect, useState } from 'react';
import { Animated, Pressable, View } from 'react-native';

import { MOTION_MS, useReducedMotion } from '../lib/motion';
import type { Hint } from '../lib/hintScheduler';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';

// 입력창 바로 위 힌트 한 줄(보낸 사람에게만). 보내기를 막지 않고 포커스를 가져가지 않는다.
// 읽어 주기는 화면의 say()가 한 번만 한다(여기에 live region을 두면 같은 말이 두 번 읽힌다).
// 색만으로 알리지 않는다: 점 + 제목 글자. 진동 없음.
export const HINT_TEXT_ID = 'tone-hint'; // 입력창의 aria-describedby 대상

export function HintBar({ hint, onDismiss, onOpenDetail, onFocusInside }: { hint: Hint | null; onDismiss(): void; onOpenDetail?(): void; onFocusInside?(inside: boolean): void }) {
  const { colors, space } = useTheme();
  const reduced = useReducedMotion();
  const [anim] = useState(() => new Animated.Value(1));
  const title = hint?.title ?? null;
  useEffect(() => {
    if (title === null || reduced) {
      anim.setValue(1);
      return;
    }
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: MOTION_MS, useNativeDriver: false }).start();
  }, [title, reduced, anim]);
  if (!hint) return null;
  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
        marginHorizontal: space[2],
        marginBottom: space[0],
        paddingLeft: space[2],
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[1],
        borderRadius: 14,
        backgroundColor: colors.hintBg,
      }}
    >
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.hintText }} />
      <AppText nativeID={HINT_TEXT_ID} numberOfLines={1} variant="small" style={{ flex: 1, color: colors.hintText, fontSize: 14.5, lineHeight: 20 }}>
        {hint.title}
      </AppText>
      {onOpenDetail ? (
        <Pressable onPress={onOpenDetail} onFocus={() => onFocusInside?.(true)} onBlur={() => onFocusInside?.(false)} accessibilityRole="button" accessibilityLabel="살펴보기" style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: space[0], ...focusRing(colors.primary) }}>
          <AppText variant="small" weight="600" style={{ color: colors.hintText }}>
            살펴보기 ›
          </AppText>
        </Pressable>
      ) : null}
      <Pressable onPress={onDismiss} onFocus={() => onFocusInside?.(true)} onBlur={() => onFocusInside?.(false)} accessibilityRole="button" accessibilityLabel="힌트 닫기" style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', ...focusRing(colors.primary) }}>
        <X color={colors.hintText} size={20} />
      </Pressable>
    </Animated.View>
  );
}
