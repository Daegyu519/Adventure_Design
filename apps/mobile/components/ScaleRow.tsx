import Check from 'lucide-react-native/icons/check';
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

// MASTER 거울 카드: 1~5칸(각 44 이상, radio), 양끝 설명, 고른 칸은 종이색(primary) 바탕 + 글로우(OOPS).
// 선택은 색만으로 전하지 않는다(1.4.1): 굵은 테두리(2) + 체크 아이콘. 양끝 칸의 이름에는 눈에 보이는 숫자와 끝 설명을 함께 넣어 화면 읽기 프로그램이 1·5의 뜻을 알게 한다.
export function ScaleRow({ value, onChange, lowLabel, highLabel, accessibilityLabel, disabled = false }: Props) {
  const { colors, radius, space, fx } = useTheme();
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
              accessibilityLabel={n === 1 ? `1, ${lowLabel}` : n === 5 ? `5, ${highLabel}` : String(n)}
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
                borderRadius: radius.card - 6,
                borderWidth: checked ? 2 : 1.5,
                borderColor: checked ? colors.primary : colors.borderStrong,
                backgroundColor: checked ? colors.primary : 'transparent',
                ...(checked ? { boxShadow: fx.soft } : null),
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
                ...focusRing(colors.accent),
              })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                {checked && <Check color={colors.onPrimary} size={14} aria-hidden />}
                <AppText weight="700" color={checked ? 'onPrimary' : 'text'}>
                  {String(n)}
                </AppText>
              </View>
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
