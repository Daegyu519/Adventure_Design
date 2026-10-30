import { Pressable, View } from 'react-native';

import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';

type Props = {
  value: number | null;
  onChange(v: number): void;
  lowLabel: string;
  highLabel: string;
  accessibilityLabel: string;
  disabled?: boolean;
};

// MASTER 거울 카드: 1~5칸(각 44 이상, radio), 양끝 설명, 고른 칸은 mirror 바탕. 칸은 숫자 글자가 있어 색만으로 전하지 않는다.
export function ScaleRow({ value, onChange, lowLabel, highLabel, accessibilityLabel, disabled = false }: Props) {
  const { colors, radius, space } = useTheme();
  const pick = (n: number) => !disabled && onChange(n);
  return (
    <View style={{ gap: space[0] }}>
      <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={{ flexDirection: 'row', gap: space[1] }}>
        {[1, 2, 3, 4, 5].map((n) => {
          const checked = n === value;
          return (
            <Pressable
              key={n}
              onPress={() => pick(n)}
              accessibilityRole="radio"
              accessibilityLabel={String(n)}
              accessibilityState={{ checked, disabled }}
              aria-checked={checked}
              // react-native-web의 Pressable은 radio에서 Space를 누름으로 바꿔 주지 않는다(ChipRow와 같은 처리, WCAG 2.1.1).
              {...({
                onKeyDown: (e: { key: string; preventDefault(): void }) => {
                  if (e.key === ' ') {
                    e.preventDefault();
                    pick(n);
                  }
                },
              } as object)}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 48,
                minWidth: 44,
                borderRadius: radius.card - 4,
                borderWidth: 1,
                borderColor: checked ? colors.mirror : colors.border,
                backgroundColor: checked ? colors.mirror : colors.background,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
                ...focusRing(colors.mirror),
              })}
            >
              <AppText weight="600" color={checked ? 'onMirror' : 'text'}>
                {String(n)}
              </AppText>
            </Pressable>
          );
        })}
      </View>
      <View aria-hidden style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <AppText variant="small" color="textMuted">
          {lowLabel}
        </AppText>
        <AppText variant="small" color="textMuted">
          {highLabel}
        </AppText>
      </View>
    </View>
  );
}
