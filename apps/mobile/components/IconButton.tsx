import type { LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { focusRing, useTheme, type Colors } from '../lib/theme';

type Props = { icon: LucideIcon; label: string; onPress(): void; color?: keyof Colors; disabled?: boolean; tabIndex?: 0 | -1; busy?: boolean; quiet?: boolean; circle?: { bg: keyof Colors; fg: keyof Colors; glow?: boolean } }; // circle: 40 동그라미 안에 아이콘(눌림 영역은 그대로 44)

// 아이콘만 있는 버튼. 44×44, 이름은 label. disabled여도 진짜 disabled를 걸지 않는다: 포커스가 있는 채로 꺼지면 키보드 사용자가 body로 튕긴다(Button과 같은 이유).
export function IconButton({ icon: Icon, label, onPress, color = 'text', disabled = false, tabIndex, busy = false, quiet = false, circle }: Props) {
  const { colors, fx } = useTheme();
  const [focused, setFocused] = useState(false);
  const hide = quiet && !focused; // 눈에 안 띄게 두되 키보드 포커스가 오면 보인다(마우스·터치는 말풍선 자체가 연다)
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      tabIndex={tabIndex}
      onFocus={quiet ? () => setFocused(true) : undefined}
      onBlur={quiet ? () => setFocused(false) : undefined}
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      aria-busy={busy || undefined}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: hide ? 0 : disabled && !circle?.glow ? 0.4 : pressed ? 0.8 : 1,
        ...(quiet ? { marginHorizontal: -22, pointerEvents: hide ? ('none' as const) : ('auto' as const) } : null),
        ...focusRing(colors.primary),
      })}
    >
      {circle ? (
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: disabled && circle.glow ? colors.fillDim : colors[circle.bg], alignItems: 'center', justifyContent: 'center', ...(circle.glow && !disabled ? { boxShadow: fx.soft } : null) }}>
          <Icon color={disabled && circle.glow ? colors.textMuted : colors[circle.fg]} size={20} />
        </View>
      ) : (
        <Icon color={colors[color]} size={24} />
      )}
    </Pressable>
  );
}
