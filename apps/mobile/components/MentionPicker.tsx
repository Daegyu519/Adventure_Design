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
    <View {...(web ? ({ role: 'listbox', nativeID: MENTION_LIST_ID, 'aria-label': '멘션 후보' } as object) : {})} style={{ borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
      {candidates.map((c, i) => (
        <Pressable
          key={c.user_id}
          {...(web ? ({ role: 'option', nativeID: mentionOptionId(i), tabIndex: -1, 'aria-selected': i === active } as object) : {})}
          accessibilityState={{ selected: i === active }}
          onPress={() => onSelect(c.name)}
          accessibilityRole={web ? undefined : 'button'}
          accessibilityLabel={`${c.name} 언급`}
          // 활성 줄은 색만으로 알리지 않는다(바탕 대비가 1:1에 가깝다): 왼쪽 막대 + 굵은 글자. 다른 줄은 투명 막대로 자리를 맞춘다.
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[3], borderLeftWidth: 3, borderLeftColor: i === active ? colors.primary : 'transparent', backgroundColor: i === active ? colors.bubbleOther : 'transparent', ...focusRing(colors.primary) }}
        >
          <AppText weight={i === active ? '600' : '400'} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{`@${c.name}`}</AppText>
        </Pressable>
      ))}
    </View>
  );
}
