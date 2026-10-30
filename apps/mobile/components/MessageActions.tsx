import { Pressable, View } from 'react-native';

import { REACTION_LABELS, REACTIONS, type Emoji, type Msg } from '../lib/messages';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Button } from './Button';
import { Sheet } from './Sheet';

// 메시지 메뉴: 공감 6개 + 답장. 길게 누르기나 "메시지 메뉴" 버튼으로 연다(키보드·화면 읽기 프로그램용). Task 14가 털어놓기 항목을 더한다.
export function MessageActions(p: { visible: boolean; message: Msg | null; mine: boolean; myReaction: Emoji | null; onClose(): void; onReply(): void; onReact(e: Emoji): void }) {
  const { colors, radius, space, font } = useTheme();
  return (
    <Sheet visible={p.visible && p.message !== null} onClose={p.onClose} title="메시지">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[1] }}>
        {REACTIONS.map((e) => {
          const on = p.myReaction === e;
          return (
            <Pressable
              key={e}
              onPress={() => p.onReact(e)}
              accessibilityRole="button"
              accessibilityLabel={`공감: ${REACTION_LABELS[e]}`}
              accessibilityState={{ selected: on }}
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
