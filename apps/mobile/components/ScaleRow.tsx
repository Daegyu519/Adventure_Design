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
  words?: readonly string[]; // 칸마다 붙는 말. 고른 칸 위에 알약으로 따라온다
};

const DOT = 26;
const SIDE = 22; // 칸(폭 44)의 가운데까지

// 말의 온도(OOPS 거울): 따뜻함 → 차가움 막대 위 1~5칸(각 44 이상, radio). 고른 칸은 커지고 종이색, 위에 칸마다 다른 말이 붙는다.
// 선택은 색만으로 전하지 않는다(1.4.1): 크기 + 숫자 반전 + 말 알약 + checked 상태. 양끝 칸 이름에는 숫자와 끝 설명을 함께 넣는다.
export function ScaleRow({ value, onChange, lowLabel, highLabel, accessibilityLabel, disabled = false, words }: Props) {
  const { colors, radius, space, fx } = useTheme();
  const pick = (n: number) => !disabled && onChange(n);
  const word = value != null ? words?.[value - 1] : undefined;
  return (
    <View style={{ gap: space[0] }}>
      <View style={{ paddingTop: 30 }}>
        <View aria-hidden pointerEvents="none" style={{ position: 'absolute', left: SIDE, right: SIDE, top: 49, height: 10, borderRadius: 5, backgroundImage: fx.temp, opacity: 0.9 }} />
        {word && value != null ? (
          <View aria-hidden pointerEvents="none" style={{ position: 'absolute', top: 0, left: SIDE, right: SIDE }}>
            <View style={{ position: 'absolute', left: `${((value - 1) / 4) * 100}%`, width: 160, marginLeft: -80, alignItems: 'center' }}>
              <View style={{ paddingVertical: 3, paddingHorizontal: 10, borderRadius: radius.chip, backgroundColor: colors.hintBg, boxShadow: fx.chip }}>
                <AppText weight="700" style={{ color: colors.hintText, fontSize: 12, lineHeight: 18 }}>
                  {word}
                </AppText>
              </View>
            </View>
          </View>
        ) : null}
        <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {[1, 2, 3, 4, 5].map((n) => {
            const checked = n === value;
            const w = words?.[n - 1];
            return (
              <Pressable
                key={n}
                onPress={() => pick(n)}
                accessibilityRole="radio"
                accessibilityLabel={`${n}${w ? `, ${w}` : ''}${n === 1 ? `, ${lowLabel}` : n === 5 ? `, ${highLabel}` : ''}`}
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
                style={({ pressed }) => ({ width: 44, height: 48, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.8 : 1, ...focusRing(colors.accent) })}
              >
                <View
                  style={{
                    width: DOT,
                    height: DOT,
                    borderRadius: DOT / 2,
                    borderWidth: 2,
                    borderColor: checked ? colors.primary : colors.borderStrong,
                    backgroundColor: checked ? colors.primary : colors.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                    transform: [{ scale: checked ? 1.35 : 1 }],
                    ...(checked ? { boxShadow: fx.soft } : null),
                  }}
                >
                  <AppText weight="700" color={checked ? 'onPrimary' : 'textMuted'} style={{ fontSize: 12, lineHeight: 16 }}>
                    {String(n)}
                  </AppText>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View aria-hidden style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.glowSoft }} />
          <AppText variant="small" color="textMuted" style={{ fontSize: 12 }}>
            {lowLabel}
          </AppText>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.cool }} />
          <AppText variant="small" color="textMuted" style={{ fontSize: 12 }}>
            {highLabel}
          </AppText>
        </View>
      </View>
    </View>
  );
}
