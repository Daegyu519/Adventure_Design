import Ellipsis from 'lucide-react-native/icons/ellipsis';
import { Pressable, View } from 'react-native';

import { formatStamp, REACTION_LABELS, type Emoji, type Msg, type ReactionSummary } from '../lib/messages';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { IconButton } from './IconButton';

export const firstLine = (m: Pick<Msg, 'text' | 'image_path'>) => m.text.split('\n')[0] || (m.image_path ? '사진' : '');

type Props = {
  message: Msg;
  mine: boolean;
  senderName?: string;
  quoted?: Msg | null;
  quotedName?: string;
  reactions: ReactionSummary[];
  unread: number;
  onLongPress(): void;
  onMore?(): void;
  onQuotePress?(): void;
  onReactionPress(e: Emoji): void;
};

// MASTER 5장: 꼬리 없음, 모서리 18, 최대 너비 75%. 내 것 오른쪽 primary, 받은 것 왼쪽 bubbleOther. 시간은 말풍선 옆(13, textMuted).
// 길게 누르기만으로는 부족해서(키보드·화면 읽기 프로그램) "메시지 메뉴" 버튼과 접근성 동작을 같이 둔다.
// 사진 메시지는 Task 11 전까지 "사진" 글자.
export function Bubble({ message, mine, senderName, quoted, quotedName, reactions, unread, onLongPress, onMore, onQuotePress, onReactionPress }: Props) {
  const { colors, radius, space } = useTheme();
  const body = message.text || (message.image_path ? '사진' : '');
  const edge = mine ? 'flex-end' : 'flex-start';
  return (
    <View style={{ alignSelf: edge, maxWidth: '85%', alignItems: edge }}>
      {senderName ? (
        <AppText variant="small" color="textMuted" style={{ marginBottom: space[0] }}>
          {senderName}
        </AppText>
      ) : null}
      {message.reply_to !== null && (
        <Pressable
          onPress={quoted ? onQuotePress : undefined}
          accessibilityRole={quoted ? 'button' : undefined}
          accessibilityLabel={quoted ? `${quotedName ?? '상대'}의 메시지로 이동: ${firstLine(quoted)}` : undefined}
          style={{ minHeight: quoted ? 44 : undefined, justifyContent: 'center', marginBottom: space[0], paddingLeft: space[1], borderLeftWidth: 2, borderLeftColor: colors.primary, ...focusRing(colors.primary) }}
        >
          <AppText variant="small" color="textMuted" weight="600" numberOfLines={1}>
            {quoted ? (quotedName ?? '상대') : '원래 메시지'}
          </AppText>
          <AppText variant="small" color="textMuted" numberOfLines={1}>
            {quoted ? firstLine(quoted) : '불러오는 중이거나 볼 수 없어요'}
          </AppText>
        </Pressable>
      )}
      <View style={{ flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: space[1] }}>
        <Pressable
          onLongPress={onLongPress}
          accessibilityActions={[{ name: 'menu', label: '메시지 메뉴' }]}
          onAccessibilityAction={(e) => e.nativeEvent.actionName === 'menu' && onMore?.()}
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
        </Pressable>
        <View style={{ alignItems: edge }}>
          {unread > 0 && (
            <AppText variant="small" color="textMuted" accessibilityLabel={`안 읽은 사람 ${unread}명`}>
              {unread}
            </AppText>
          )}
          <AppText variant="small" color="textMuted">
            {formatStamp(message.created_at)}
          </AppText>
        </View>
        {onMore && <IconButton icon={Ellipsis} label="메시지 메뉴" onPress={onMore} color="textMuted" />}
      </View>
      {reactions.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[0], marginTop: space[0] }}>
          {reactions.map((r) => (
            <Pressable
              key={r.emoji}
              onPress={() => onReactionPress(r.emoji)}
              accessibilityRole="button"
              accessibilityLabel={`${REACTION_LABELS[r.emoji]} ${r.count}명${r.mine ? ', 나도 공감함' : ''}`}
              accessibilityState={{ selected: r.mine }}
              aria-pressed={r.mine}
              style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[1], borderRadius: radius.chip, borderWidth: r.mine ? 2 : 1, borderColor: r.mine ? colors.primary : colors.border, backgroundColor: colors.surface, ...focusRing(colors.primary) }}
            >
              <AppText variant="small" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{`${r.emoji} ${r.count}`}</AppText>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
