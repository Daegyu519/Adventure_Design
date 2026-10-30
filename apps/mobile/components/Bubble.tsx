import Ellipsis from 'lucide-react-native/icons/ellipsis';
import { Image, Platform, Pressable, View } from 'react-native';

import { formatStamp, REACTION_LABELS, type Emoji, type Msg, type ReactionSummary } from '../lib/messages';
import { useSignedUrl } from '../lib/images';
import { splitMentions } from '../lib/mentions';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Button } from './Button';
import { IconButton } from './IconButton';

export const firstLine = (m: Pick<Msg, 'text' | 'image_path'>) => m.text.split('\n')[0] || (m.image_path ? '사진' : '');

type Props = {
  message: Msg;
  mine: boolean;
  senderName?: string;
  speaker: string; // 화면 읽기 프로그램용 보낸 사람("나" 또는 이름)
  mentionNames?: string[]; // 그룹 방 멤버 이름: 글 속 @이름을 굵게
  mentionsMe?: boolean; // 내가 언급됨: 합친 이름에 "나를 언급"
  quoted?: Msg | null;
  quotedName?: string;
  quoteFailed?: boolean;
  reactions: ReactionSummary[];
  unread: number;
  unreadText: string; // "안 읽은 사람 2명" / "상대가 안 읽음" / ''
  active: boolean; // 웹: 목록에서 탭 순서에 있는 한 메시지(roving tabindex)
  onNavigate(dir: -1 | 1): void; // -1 = 위(더 오래된) 메시지
  onLongPress(): void;
  onMore(): void;
  onQuotePress?(): void;
  onQuoteRetry?(): void;
  onReactionPress(e: Emoji): void;
};

const PHOTO = { w: 240, h: 180 }; // 최대 너비 240. 불러오는 동안 자리 상자도 같은 크기라 목록이 흔들리지 않는다
const HIDDEN = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true } as const;

// MASTER 5장: 꼬리 없음, 모서리 18, 최대 너비 75%. 내 것 오른쪽 primary, 받은 것 왼쪽 bubbleOther. 시간은 말풍선 옆(13, textMuted).
// 접근성: 본문 하나가 "보낸 사람, 글, 시각, 안 읽은 수"를 한 이름으로 갖는다(시각·숫자 노드는 따로 읽히지 않게 숨김).
// 웹은 roving tabindex: 활성 메시지의 본문·메뉴·인용·칩만 탭 순서에 있고, ↑/↓로 메시지를 옮기며 Enter·Shift+F10·ContextMenu로 메뉴를 연다.
// 네이티브는 길게 누르기 + 접근성 동작("메시지 메뉴"). 사진 메시지는 말풍선 안에 그림(대체 글 "<보낸 사람>이 보낸 사진"), 합친 이름에는 "사진"(+글). 멘션은 "나를 언급"이 붙는다.
export function Bubble({ message, mine, senderName, speaker, mentionNames = [], mentionsMe = false, quoted, quotedName, quoteFailed, reactions, unread, unreadText, active, onNavigate, onLongPress, onMore, onQuotePress, onQuoteRetry, onReactionPress }: Props) {
  const { colors, radius, space } = useTheme();
  const web = Platform.OS === 'web';
  const tabIndex = web ? (active ? 0 : -1) : undefined;
  const url = useSignedUrl(message.image_path);
  const body = message.image_path ? (message.text ? `사진, ${message.text}` : '사진') : message.text;
  const alt = mine ? '내가 보낸 사진' : `${speaker}님이 보낸 사진`;
  const parts = message.text && mentionNames.length ? splitMentions(message.text, mentionNames) : null;
  const stamp = formatStamp(message.created_at);
  const edge = mine ? 'flex-end' : 'flex-start';
  const onKeyDown = web
    ? {
        onKeyDown: (e: { key: string; shiftKey?: boolean; preventDefault(): void }) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onNavigate(e.key === 'ArrowUp' ? -1 : 1);
          } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            onMore();
          }
        },
      }
    : {};
  return (
    <View nativeID={`msg-${message.id}`} style={{ alignSelf: edge, maxWidth: '85%', alignItems: edge }} {...(onKeyDown as object)}>
      {senderName ? (
        <AppText variant="small" color="textMuted" style={{ marginBottom: space[0] }}>
          {senderName}
        </AppText>
      ) : null}
      {message.reply_to !== null &&
        (quoted ? (
          <Pressable
            onPress={onQuotePress}
            tabIndex={tabIndex}
            accessibilityRole="button"
            accessibilityLabel={`답장 대상 ${quotedName ?? '상대'}: ${firstLine(quoted)}`}
            accessibilityHint="누르면 원문으로 이동"
            style={{ minHeight: 44, justifyContent: 'center', marginBottom: space[0], paddingLeft: space[1], borderLeftWidth: 2, borderLeftColor: colors.primary, ...focusRing(colors.primary) }}
          >
            <AppText variant="small" color="textMuted" weight="600" numberOfLines={1}>
              {quotedName ?? '상대'}
            </AppText>
            <AppText variant="small" color="textMuted" numberOfLines={1}>
              {firstLine(quoted)}
            </AppText>
          </Pressable>
        ) : (
          <View style={{ marginBottom: space[0], paddingLeft: space[1], borderLeftWidth: 2, borderLeftColor: colors.primary, alignItems: edge }}>
            <AppText variant="small" color="textMuted" weight="600">
              원래 메시지
            </AppText>
            <AppText variant="small" color="textMuted">
              {quoteFailed ? '원래 메시지를 불러오지 못했어요' : '불러오는 중이에요'}
            </AppText>
            {quoteFailed && onQuoteRetry ? <Button label="원래 메시지 다시 불러오기" kind="ghost" onPress={onQuoteRetry} /> : null}
          </View>
        ))}
      <View style={{ flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: space[1] }}>
        <Pressable
          nativeID={`msg-body-${message.id}`}
          onPress={web ? onMore : undefined}
          onLongPress={onLongPress}
          tabIndex={tabIndex}
          accessibilityRole="button"
          accessibilityLabel={[speaker, body, stamp, unreadText, mentionsMe ? '나를 언급' : ''].filter(Boolean).join(', ')}
          accessibilityHint="메시지 메뉴 열기"
          accessibilityActions={[{ name: 'menu', label: '메시지 메뉴' }]}
          onAccessibilityAction={(e) => e.nativeEvent.actionName === 'menu' && onMore()}
          style={{
            flexShrink: 1,
            maxWidth: '88%',
            paddingVertical: space[1],
            paddingHorizontal: space[2],
            borderRadius: radius.bubble,
            backgroundColor: mine ? colors.primary : colors.bubbleOther,
            ...focusRing(colors.primary),
          }}
        >
          {message.image_path ? (
            url ? (
              <Image source={{ uri: url }} accessibilityLabel={alt} alt={alt} resizeMode="cover" style={{ width: PHOTO.w, height: PHOTO.h, maxWidth: '100%', borderRadius: radius.bubble - 4, marginBottom: message.text ? space[1] : 0 }} />
            ) : (
              <View accessibilityLabel="사진 불러오는 중" style={{ width: PHOTO.w, height: PHOTO.h, maxWidth: '100%', borderRadius: radius.bubble - 4, backgroundColor: colors.surface, marginBottom: message.text ? space[1] : 0 }} />
            )
          ) : null}
          {message.text ? (
            <AppText selectable color={mine ? 'onPrimary' : 'onBubbleOther'}>
              {(parts ?? [{ text: message.text, mention: false }]).map((p, i) =>
                p.mention ? (
                  <AppText key={i} weight="700" color={mine ? 'onPrimary' : 'primary'} style={mine ? { textDecorationLine: 'underline' } : undefined}>
                    {p.text}
                  </AppText>
                ) : (
                  p.text
                ),
              )}
            </AppText>
          ) : null}
        </Pressable>
        <View style={{ alignItems: edge }} {...HIDDEN}>
          {unread > 0 && (
            <AppText variant="small" color="textMuted">
              {unread}
            </AppText>
          )}
          <AppText variant="small" color="textMuted">
            {stamp}
          </AppText>
        </View>
        <IconButton icon={Ellipsis} label="메시지 메뉴" onPress={onMore} color="textMuted" tabIndex={tabIndex} />
      </View>
      {reactions.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[0], marginTop: space[0] }}>
          {reactions.map((r) => (
            <Pressable
              key={r.emoji}
              onPress={() => onReactionPress(r.emoji)}
              tabIndex={tabIndex}
              accessibilityRole="button"
              accessibilityLabel={`공감 ${REACTION_LABELS[r.emoji]} ${r.count}명${r.mine ? ', 내가 누름' : ''}`}
              accessibilityState={web ? undefined : { selected: r.mine }} // 웹은 role=button에 aria-selected가 맞지 않아 aria-pressed만
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
