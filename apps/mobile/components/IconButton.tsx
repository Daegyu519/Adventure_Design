import type { LucideIcon } from 'lucide-react-native';
import { Pressable } from 'react-native';

import { focusRing, useTheme, type Colors } from '../lib/theme';

type Props = { icon: LucideIcon; label: string; onPress(): void; color?: keyof Colors; disabled?: boolean; tabIndex?: 0 | -1 };

// 아이콘만 있는 버튼. 44×44, 이름은 label. disabled여도 진짜 disabled를 걸지 않는다: 포커스가 있는 채로 꺼지면 키보드 사용자가 body로 튕긴다(Button과 같은 이유).
export function IconButton({ icon: Icon, label, onPress, color = 'text', disabled = false, tabIndex }: Props) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      tabIndex={tabIndex}
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
        ...focusRing(colors.primary),
      })}
    >
      <Icon color={colors[color]} size={24} />
    </Pressable>
  );
}
