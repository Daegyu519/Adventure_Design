import { Pressable, View } from 'react-native';

import { focusRing, useTheme } from '../lib/theme';
import type { Member } from '../lib/rooms';
import { AppText } from './AppText';

type Props = { candidates: Pick<Member, 'user_id' | 'name'>[]; onSelect(name: string): void };

// 입력창 위 멘션 후보. 줄마다 44pt. 고르면 목록이 사라지므로 부른 쪽이 포커스를 입력창으로 돌려준다.
export function MentionPicker({ candidates, onSelect }: Props) {
  const { colors, space } = useTheme();
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
      {candidates.map((c) => (
        <Pressable
          key={c.user_id}
          onPress={() => onSelect(c.name)}
          accessibilityRole="button"
          accessibilityLabel={`${c.name} 언급`}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[3], ...focusRing(colors.primary) }}
        >
          <AppText accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{`@${c.name}`}</AppText>
        </Pressable>
      ))}
    </View>
  );
}
