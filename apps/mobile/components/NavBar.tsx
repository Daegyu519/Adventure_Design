import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import { Pressable, StyleSheet, View } from 'react-native';

import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { IconButton } from './IconButton';

// iOS식 위 막대: 가운데 제목(+작은 부제), 왼쪽 틴트 "‹ 대화", 오른쪽 "⋯"(방 정보). 불투명 바탕 + 머리카락 선.
export function NavBar({ title, subtitle, onBack, onMore, moreLabel = '방 정보' }: { title: string; subtitle?: string; onBack(): void; onMore(): void; moreLabel?: string }) {
  const { colors, space, bar } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, backgroundColor: bar, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
      <View style={{ flex: 1, alignItems: 'flex-start' }}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="뒤로"
          style={({ pressed }) => ({ minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', paddingLeft: space[0], opacity: pressed ? 0.5 : 1, ...focusRing(colors.primary) })}
        >
          <ChevronLeft color={colors.primary} size={26} />
          <AppText color="primary" style={{ marginLeft: -4 }} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            대화
          </AppText>
        </Pressable>
      </View>
      <View style={{ flexShrink: 1, alignItems: 'center', paddingHorizontal: space[1] }}>
        <AppText accessibilityRole="header" aria-level={1} weight="600" numberOfLines={1} style={{ letterSpacing: -0.16 }}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText color="textMuted" style={{ fontSize: 12, lineHeight: 14 }}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        <IconButton icon={Ellipsis} label={moreLabel} onPress={onMore} color="primary" />
      </View>
    </View>
  );
}
