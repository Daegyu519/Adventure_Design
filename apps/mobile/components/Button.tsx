import { ActivityIndicator, Pressable, View } from 'react-native';

import { focusRing, useTheme, type Colors } from '../lib/theme';
import { AppText } from './AppText';

type Props = {
  label: string;
  onPress(): void;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
};

// MASTER 5장: 알약(999), 16/600, 높이 48(최소 44). 눌림은 투명도로만 보여 줘서 레이아웃이 안 움직인다.
export function Button({ label, onPress, kind = 'primary', disabled = false, loading = false, accessibilityLabel }: Props) {
  const { colors, radius, space } = useTheme();
  const inactive = disabled || loading;
  // 처리 중에는 disabled를 걸지 않는다: 진짜 disabled 요소는 포커스를 잃어 키보드 사용자가 body로 튕긴다(WCAG 2.4.3).
  // 대신 aria-disabled + onPress 무시. 화면 읽기 프로그램에는 이름에 "처리 중"을 붙여 알린다(aria-busy만으로는 거의 안 읽는다).
  const name = accessibilityLabel ?? label;
  const looks: Record<NonNullable<Props['kind']>, { bg: string; fg: keyof Colors; border: string }> = {
    primary: { bg: colors.primary, fg: 'onPrimary', border: colors.primary },
    secondary: { bg: colors.surface, fg: 'text', border: colors.border },
    ghost: { bg: 'transparent', fg: 'primary', border: 'transparent' },
    danger: { bg: 'transparent', fg: 'danger', border: 'transparent' }, // iOS 묶음 목록의 빨간 글자 줄(로그아웃)
  };
  const look = looks[kind];

  return (
    <Pressable
      onPress={loading ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={loading ? `${name}, 처리 중` : name}
      accessibilityState={{ disabled: inactive, busy: loading }}
      aria-disabled={inactive}
      aria-busy={loading} // react-native-web은 accessibilityState를 aria-*로 옮기지 않는다
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        paddingVertical: space[2],
        paddingHorizontal: space[5],
        borderRadius: radius.chip,
        borderWidth: 1,
        backgroundColor: look.bg,
        borderColor: look.border,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: inactive && !loading ? 0.4 : pressed ? 0.8 : 1,
        ...focusRing(colors.primary),
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
        {loading && <ActivityIndicator color={colors[look.fg]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden />}
        <AppText color={look.fg} weight="600">
          {label}
        </AppText>
      </View>
    </Pressable>
  );
}
