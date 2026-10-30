import { Platform, Pressable, View } from 'react-native';

import { focusRing, useTheme } from '../lib/theme';
import type { Member } from '../lib/rooms';
import { AppText } from './AppText';

export const MENTION_LIST_ID = 'mention-list';
export const mentionOptionId = (i: number) => `mention-opt-${i}`;
export const MAX_SHOWN = 4; // 이 이상은 목록이 대화를 밀어내므로 이름을 더 치게 한다
type Props = { candidates: Pick<Member, 'user_id' | 'name'>[]; active: number; onSelect(name: string): void };

// 입력창(combobox)이 가리키는 listbox. 키보드는 입력창에서 ↑↓·Enter·Tab·Esc로 다루므로 행은 탭 순서 밖(웹 tabIndex -1)이다.
// 줄마다 44pt. 고르면 목록이 사라지므로 부른 쪽이 포커스를 입력창으로 돌려준다.
export function MentionPicker({ candidates, active, onSelect }: Props) {
  const { colors, space } = useTheme();
  const web = Platform.OS === 'web';
  return (
    <View {...({ role: 'listbox' } as object)} nativeID={MENTION_LIST_ID} aria-label="멘션 후보" style={{ borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
      {candidates.map((c, i) => (
        <Pressable
          key={c.user_id}
          nativeID={mentionOptionId(i)}
          role="option"
          aria-selected={i === active}
          tabIndex={web ? -1 : undefined}
          onPress={() => onSelect(c.name)}
          accessibilityRole={web ? undefined : 'button'}
          accessibilityLabel={`${c.name} 언급`}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[3], backgroundColor: i === active ? colors.bubbleOther : 'transparent', ...focusRing(colors.primary) }}
        >
          <AppText accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{`@${c.name}`}</AppText>
        </Pressable>
      ))}
    </View>
  );
}
