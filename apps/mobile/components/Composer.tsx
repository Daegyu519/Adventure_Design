import Send from 'lucide-react-native/icons/send';
import { Platform, TextInput, View } from 'react-native';

import { shouldSubmitOnKey } from '../lib/composer';
import { focusRing, useTheme } from '../lib/theme';
import { IconButton } from './IconButton';

// MASTER 4·5장: 입력창 모서리 22, 최소 높이 44. 웹은 Enter로 보내고 Shift+Enter는 줄바꿈, 한글 조합 중 Enter는 보내지 않는다.
// 입력창은 보낸 뒤에도 그대로 있어서 포커스를 잃지 않는다. 글이 비면 보내기는 aria-disabled(진짜 disabled 아님).
export function Composer({ value, onChangeText, onSend }: { value: string; onChangeText(t: string): void; onSend(): void }) {
  const { colors, radius, space, font } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space[1], paddingHorizontal: space[3], paddingVertical: space[1], borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background }}>
      <TextInput
        accessibilityLabel="메시지 입력"
        multiline
        maxLength={2000}
        value={value}
        onChangeText={onChangeText}
        placeholder="메시지"
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.primary}
        onKeyPress={
          Platform.OS === 'web'
            ? (e) => {
                if (shouldSubmitOnKey(e.nativeEvent as Parameters<typeof shouldSubmitOnKey>[0])) {
                  e.preventDefault();
                  onSend();
                }
              }
            : undefined
        }
        style={{
          flex: 1,
          minHeight: 44,
          maxHeight: 140,
          paddingHorizontal: space[3],
          paddingVertical: space[2],
          borderWidth: 1,
          borderColor: colors.textMuted,
          borderRadius: radius.input,
          backgroundColor: colors.surface,
          color: colors.text,
          fontFamily: font.family,
          fontSize: font.body,
          ...focusRing(colors.primary),
        }}
      />
      <IconButton icon={Send} label="보내기" color="primary" disabled={value.trim() === ''} onPress={onSend} />
    </View>
  );
}
