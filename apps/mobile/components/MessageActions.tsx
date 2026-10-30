import { Platform, Pressable, View } from 'react-native';

import { REACTION_LABELS, REACTIONS, type Emoji, type Msg } from '../lib/messages';
import { firstLine } from './Bubble';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Button } from './Button';
import { Sheet } from './Sheet';

// 메시지 메뉴: 공감 6개 + 답장. 길게 누르기나 "메시지 메뉴" 버튼으로 연다(키보드·화면 읽기 프로그램용). Task 14가 털어놓기 항목을 더한다.
export function MessageActions(p: { senderName?: string; visible: boolean; message: Msg | null; mine: boolean; myReaction: Emoji | null; onClose(): void; onReply(): void; onReact(e: Emoji): void }) {
  const { colors, radius, space, font } = useTheme();
  return (
    <Sheet initialFocus="sheet-first-reaction" visible={p.visible && p.message !== null} onClose={p.onClose} title={p.message ? `${p.senderName ?? '상대'}의 메시지: ${firstLine(p.message)}` : '메시지'}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[1] }}>
        {REACTIONS.map((e) => {
          const on = p.myReaction === e;
          return (
            <Pressable
              key={e}
              nativeID={e === REACTIONS[0] ? 'sheet-first-reaction' : undefined}
              onPress={() => p.onReact(e)}
              accessibilityRole="button"
              accessibilityLabel={`공감: ${REACTION_LABELS[e]}`}
              accessibilityState={Platform.OS === 'web' ? undefined : { selected: on }} // 웹은 role=button에 aria-selected가 맞지 않아 aria-pressed만
              aria-pressed={on}
              style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.chip, borderWidth: on ? 2 : 1, borderColor: on ? colors.primary : colors.border, backgroundColor: colors.surface, ...focusRing(colors.primary) }}
            >
              <AppText style={{ fontSize: font.body + 4 }} importantForAccessibility="no" accessibilityElementsHidden>
                {e}
              </AppText>
            </Pressable>
          );
        })}
      </View>
      <Button label="답장" kind="secondary" onPress={p.onReply} />
    </Sheet>
  );
}
