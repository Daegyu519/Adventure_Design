import { Pressable, View } from 'react-native';

import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';

type Props<T extends string> = {
  options: readonly T[];
  value: T | null;
  onChange(v: T | null): void;
  accessibilityLabel: string;
  allowNone?: boolean; // 고른 칩을 다시 누르면 선택을 지운다(null)
  labels?: Partial<Record<T, string>>; // 값과 다른 글을 보여 줄 때
};

// MASTER 5장: 칩은 높이 44(터치 영역), 모서리 999, 선택은 primary 바탕. 한 번에 하나만 고르는 묶음이라 radio.
// 선택은 바탕색과 함께 글자 색(onPrimary)·checked 상태로도 전한다. 눌림은 투명도로만 보여 줘 레이아웃이 안 움직인다.
export function ChipRow<T extends string>({ options, value, onChange, accessibilityLabel, allowNone = false, labels }: Props<T>) {
  const { colors, radius, space } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[1] }}>
      {options.map((o) => {
        const checked = o === value;
        const label = labels?.[o] ?? o;
        return (
          <Pressable
            key={o}
            onPress={() => onChange(checked && allowNone ? null : o)}
            accessibilityRole="radio"
            accessibilityLabel={label}
            accessibilityState={{ checked }}
            aria-checked={checked} // react-native-web은 accessibilityState를 aria-*로 옮기지 않는다
            style={({ pressed }) => ({
              minHeight: 44,
              minWidth: 44,
              paddingHorizontal: space[3],
              paddingVertical: space[1],
              borderRadius: radius.chip,
              borderWidth: 1,
              borderColor: checked ? colors.primary : colors.border,
              backgroundColor: checked ? colors.primary : colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.8 : 1,
              ...focusRing(colors.primary),
            })}
          >
            <AppText weight="600" color={checked ? 'onPrimary' : 'text'}>
              {label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
