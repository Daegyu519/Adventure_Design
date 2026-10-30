import Send from 'lucide-react-native/icons/send';
import X from 'lucide-react-native/icons/x';
import { useEffect, useRef, type ComponentRef, type RefObject } from 'react';
import { Platform, TextInput, View } from 'react-native';

import { shouldSubmitOnKey } from '../lib/composer';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { IconButton } from './IconButton';

// MASTER 4·5장: 입력창 모서리 22, 최소 높이 44. 웹은 Enter로 보내고 Shift+Enter는 줄바꿈, 한글 조합 중 Enter는 보내지 않는다.
// 입력창은 보낸 뒤에도 그대로 있어서 포커스를 잃지 않는다. 글이 비면 보내기는 aria-disabled(진짜 disabled 아님).
// 답장 막대: 답장 대상을 고르면 입력창으로, 취소하면(막대가 사라지므로) 입력창으로 포커스를 옮긴다.
export type InputHandle = ComponentRef<typeof TextInput>;
type Props = {
  value: string;
  onChangeText(t: string): void;
  onSend(): void;
  replyTo: { id: number; name: string; text: string } | null;
  onCancelReply(): void;
  inputRef?: RefObject<InputHandle | null>;
};
export function Composer({ value, onChangeText, onSend, replyTo, onCancelReply, inputRef }: Props) {
  const { colors, radius, space, font } = useTheme();
  const own = useRef<InputHandle>(null);
  const ref = inputRef ?? own;
  const replyId = replyTo?.id ?? null;
  useEffect(() => {
    // 시트가 닫히며 포커스를 돌려주는 것보다 나중에 입력창으로. 같은 사람의 다른 메시지로 바꿔도 다시 온다.
    if (replyId !== null) {
      const id = setTimeout(() => ref.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [replyId, ref]);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background }}>
      {replyTo && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: space[3], paddingRight: space[1] }}>
          <AppText variant="small" color="textMuted" numberOfLines={1} style={{ flex: 1 }}>
            {`${replyTo.name}에게 답장 · ${replyTo.text}`}
          </AppText>
          <IconButton
            icon={X}
            label="답장 취소"
            onPress={() => {
              onCancelReply();
              ref.current?.focus();
            }}
          />
        </View>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space[1], paddingHorizontal: space[3], paddingVertical: space[1] }}>
        <TextInput
          ref={ref}
          accessibilityLabel={replyTo ? `메시지 입력, ${replyTo.name}에게 답장 중` : '메시지 입력'}
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
    </View>
  );
}
