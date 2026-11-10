import BellOff from 'lucide-react-native/icons/bell-off';
import { Pressable, View } from 'react-native';

import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Avatar } from './Avatar';

type Props = { title: string; preview: string; time?: string; unread: number; muted: boolean; accessibilityLabel: string; onPress(): void };

// 대화 목록 한 줄(OOPS): 둥근 아바타 50, 이름 16/700 + 시각, 미리보기 + 안 읽은 수 배지(글로우). 구분선 없음. 높이 ≥ 64.
export function ChatRow({ title, preview, time, unread, muted, accessibilityLabel, onPress }: Props) {
  const { colors, space, radius, fx } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({ minHeight: 72, flexDirection: 'row', alignItems: 'center', paddingLeft: space[3] + 4, backgroundColor: pressed ? colors.surface : 'transparent', ...focusRing(colors.primary) })}
    >
      <Avatar name={title} size={50} />
      <View style={{ flex: 1, minHeight: 72, justifyContent: 'center', gap: 3, marginLeft: space[2] + 2, paddingRight: space[3] + 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space[1] }}>
          <AppText weight="700" numberOfLines={1} style={{ flexShrink: 1, flex: 1 }}>
            {title}
          </AppText>
          {muted && <BellOff accessibilityLabel="알림 꺼짐" color={colors.textMuted} size={14} />}
          {time ? (
            <AppText color="textMuted" style={{ fontSize: 14, lineHeight: 20 }}>
              {time}
            </AppText>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
          <AppText color="textMuted" numberOfLines={1} style={{ flex: 1, fontSize: 15, lineHeight: 20 }}>
            {preview}
          </AppText>
          {unread > 0 && (
            <View accessibilityLabel={`안 읽은 메시지 ${unread}개`} style={{ minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: radius.chip, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', boxShadow: fx.soft }}>
              <AppText color="onPrimary" weight="700" style={{ fontSize: 13, lineHeight: 16 }}>
                {unread > 99 ? '99+' : unread}
              </AppText>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}
