import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useTheme } from '../lib/theme';
import { AppText } from './AppText';

// iOS 묶음 목록: 작은 라벨(13, textMuted) 아래 둥근(12) 칸. 칸 색은 theme.grouped.cell, 화면 바탕은 theme.grouped.screen.
export function GroupedSection({ title, children }: { title: string; children: ReactNode }) {
  const { colors, space, grouped } = useTheme();
  return (
    <View style={{ gap: 7 }}>
      <AppText accessibilityRole="header" aria-level={2} color="textMuted" style={{ fontSize: 13, lineHeight: 18, paddingHorizontal: space[3] + space[1] }}>
        {title}
      </AppText>
      <View style={{ marginHorizontal: space[3], backgroundColor: grouped.cell, borderRadius: 12, paddingHorizontal: space[3], paddingVertical: space[0], gap: space[0], borderColor: colors.border, borderWidth: 0 }}>{children}</View>
    </View>
  );
}

export function InfoRow({ label, value }: { label: string; value: string }) {
  const { space } = useTheme();
  return (
    <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3] }}>
      <AppText>{label}</AppText>
      <AppText color="textMuted" style={{ flexShrink: 1, textAlign: 'right' }}>
        {value}
      </AppText>
    </View>
  );
}
