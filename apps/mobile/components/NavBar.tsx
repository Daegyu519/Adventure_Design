import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import { Pressable, StyleSheet, View } from 'react-native';

import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Avatar } from './Avatar';
import { IconButton } from './IconButton';

// OOPS 위 막대: 왼쪽 ‹ 뒤로, 둥근 아바타 + 이름(17/700) + 부제(12), 오른쪽 "⋯"(방 정보). 불투명 바탕 + 머리카락 선.
export function NavBar({ title, subtitle, onBack, onMore, moreLabel = '방 정보' }: { title: string; subtitle?: string; onBack(): void; onMore(): void; moreLabel?: string }) {
  const { colors, space, bar } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 60, paddingLeft: space[0], backgroundColor: bar, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="뒤로"
        style={({ pressed }) => ({ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1, ...focusRing(colors.primary) })}
      >
        <ChevronLeft color={colors.text} size={26} />
      </Pressable>
      <Avatar name={title} size={40} />
      <View style={{ flex: 1, minWidth: 0, marginLeft: space[1] + 2, gap: 1 }}>
        <AppText accessibilityRole="header" aria-level={1} weight="700" numberOfLines={1} style={{ fontSize: 17, lineHeight: 22 }}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText color="textMuted" numberOfLines={1} style={{ fontSize: 12, lineHeight: 16 }}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      <IconButton icon={Ellipsis} label={moreLabel} onPress={onMore} color="text" />
    </View>
  );
}
