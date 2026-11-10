import X from 'lucide-react-native/icons/x';
import { useEffect, useState } from 'react';
import { Animated, Image, Pressable, View } from 'react-native';

import { MOTION_MS, useReducedMotion } from '../lib/motion';
import type { Hint } from '../lib/hintScheduler';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';

// 입력창 바로 위 힌트 한 줄(보낸 사람에게만). 보내기를 막지 않고 포커스를 가져가지 않는다.
// 읽어 주기는 화면의 say()가 한 번만 한다(여기에 live region을 두면 같은 말이 두 번 읽힌다).
// OOPS 시안: 아이보리 카드(글로우) + 마크 + 제목·이유 + 어두운 "살펴보기". 색만으로 알리지 않는다(제목 글자). 진동 없음.
export const HINT_TEXT_ID = 'tone-hint'; // 입력창의 aria-describedby 대상

export function HintBar({ hint, onDismiss, onOpenDetail, onFocusInside }: { hint: Hint | null; onDismiss(): void; onOpenDetail?(): void; onFocusInside?(inside: boolean): void }) {
  const { colors, space, radius, fx } = useTheme();
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
        marginHorizontal: space[2] - 2,
        marginBottom: space[1] + 2,
        paddingVertical: space[1],
        paddingLeft: space[2] - 2,
        paddingRight: space[0] + 2,
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[1] + 4,
        borderRadius: radius.card - 2,
        backgroundColor: colors.hintBg,
        boxShadow: fx.bloom,
      }}
    >
      <Image source={require('../assets/images/oops-mark.png')} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden alt="" style={{ width: 34, height: 34, borderRadius: 9 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText nativeID={HINT_TEXT_ID} numberOfLines={2} weight="700" style={{ color: colors.hintText, fontSize: 14, lineHeight: 20 }}>
          {hint.title}
        </AppText>
        {hint.detail ? (
          <AppText numberOfLines={2} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ color: colors.hintText, opacity: 0.75, fontSize: 12, lineHeight: 17 }}>
            {hint.detail}
          </AppText>
        ) : null}
      </View>
      {onOpenDetail ? (
        <Pressable onPress={onOpenDetail} onFocus={() => onFocusInside?.(true)} onBlur={() => onFocusInside?.(false)} accessibilityRole="button" accessibilityLabel="살펴보기" style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', ...focusRing(colors.hintText) }}>
          <View style={{ height: 36, paddingHorizontal: space[1] + 4, borderRadius: 12, backgroundColor: colors.hintText, alignItems: 'center', justifyContent: 'center' }}>
            <AppText variant="small" weight="700" style={{ color: colors.hintBg }}>
              살펴보기
            </AppText>
          </View>
        </Pressable>
      ) : null}
      <Pressable onPress={onDismiss} onFocus={() => onFocusInside?.(true)} onBlur={() => onFocusInside?.(false)} accessibilityRole="button" accessibilityLabel="힌트 닫기" style={{ minHeight: 44, minWidth: 36, alignItems: 'center', justifyContent: 'center', ...focusRing(colors.hintText) }}>
        <X color={colors.hintText} size={18} />
      </Pressable>
    </Animated.View>
  );
}
