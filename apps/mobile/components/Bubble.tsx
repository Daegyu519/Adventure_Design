import { View } from 'react-native';

import { formatStamp, type Msg } from '../lib/messages';
import { useTheme } from '../lib/theme';
import { AppText } from './AppText';

// MASTER 5장: 꼬리 없음, 모서리 18, 최대 너비 75%. 내 것 오른쪽 primary, 받은 것 왼쪽 bubbleOther. 시간은 말풍선 옆(13, textMuted).
// 사진 메시지는 Task 11 전까지 "사진" 글자.
export function Bubble({ message, mine, senderName }: { message: Msg; mine: boolean; senderName?: string }) {
  const { colors, radius, space } = useTheme();
  const body = message.text || (message.image_path ? '사진' : '');
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', alignItems: mine ? 'flex-end' : 'flex-start' }}>
      {senderName ? (
        <AppText variant="small" color="textMuted" style={{ marginBottom: space[0] }}>
          {senderName}
        </AppText>
      ) : null}
      <View style={{ flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: space[1] }}>
        <View
          style={{
            flexShrink: 1,
            maxWidth: '88%',
            paddingVertical: space[1],
            paddingHorizontal: space[2],
            borderRadius: radius.bubble,
            backgroundColor: mine ? colors.primary : colors.bubbleOther,
          }}
        >
          <AppText selectable color={mine ? 'onPrimary' : 'onBubbleOther'}>
            {body}
          </AppText>
        </View>
        <AppText variant="small" color="textMuted">
          {formatStamp(message.created_at)}
        </AppText>
      </View>
    </View>
  );
}
