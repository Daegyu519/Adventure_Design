import { ActivityIndicator, Pressable, View } from 'react-native';

import { useTheme, type Colors } from '../lib/theme';
import { AppText } from './AppText';

type Props = {
  label: string;
  onPress(): void;
  kind?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
};

// MASTER 5장: 알약(999), 16/600, 높이 48(최소 44). 눌림은 투명도로만 보여 줘서 레이아웃이 안 움직인다.
export function Button({ label, onPress, kind = 'primary', disabled = false, loading = false, accessibilityLabel }: Props) {
  const { colors, radius, space } = useTheme();
  const inactive = disabled || loading;
  const looks: Record<NonNullable<Props['kind']>, { bg: string; fg: keyof Colors; border: string }> = {
    primary: { bg: colors.primary, fg: 'onPrimary', border: colors.primary },
    secondary: { bg: colors.surface, fg: 'text', border: colors.border },
    ghost: { bg: 'transparent', fg: 'primary', border: 'transparent' },
  };
  const look = looks[kind];

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
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
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
        {loading && <ActivityIndicator color={colors[look.fg]} />}
        <AppText color={look.fg} weight="600">
          {label}
        </AppText>
      </View>
    </Pressable>
  );
}
