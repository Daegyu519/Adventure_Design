import ImagePlus from 'lucide-react-native/icons/image-plus';
import Send from 'lucide-react-native/icons/send';
import X from 'lucide-react-native/icons/x';
import { useEffect, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { Platform, TextInput, View } from 'react-native';

import { shouldSubmitOnKey } from '../lib/composer';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { IconButton } from './IconButton';
import { MAX_SHOWN, MENTION_LIST_ID, MentionPicker, mentionOptionId } from './MentionPicker';
import type { Member } from '../lib/rooms';

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
  onPickImage?(): void;
  typingLabel?: string | null; // "지은님이 입력 중". 입력창 위 polite 영역(바뀔 때만 읽힌다)
  mentionCandidates?: Pick<Member, 'user_id' | 'name'>[] | null; // null = 목록 없음
  onSelectMention?(name: string): void;
  onSelectionChange?(cursor: number): void;
  selection?: { start: number; end: number }; // 멘션을 넣은 뒤 커서를 옮길 때만
  onBlur?(): void;
  say?(t: string): void; // 화면의 useAnnounce().say: 입력 중·멘션 후보 수 안내
  photoBusy?: boolean; // 사진을 올리는 중: 사진 버튼이 aria-busy(진짜 disabled 아님)
};
export function Composer({ value, onChangeText, onSend, replyTo, onCancelReply, inputRef, onPickImage, typingLabel, mentionCandidates, onSelectMention, onSelectionChange, selection, onBlur, photoBusy, say }: Props) {
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
  const [active, setActive] = useState(0);
  const [lastCount, setLastCount] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null); // Esc로 닫은 시점의 글. 글이 바뀌면 다시 열린다
  const shown = (mentionCandidates ?? []).slice(0, MAX_SHOWN);
  const picking = shown.length > 0 && dismissed !== value && !!onSelectMention;
  const safeActive = Math.min(active, Math.max(shown.length - 1, 0));
  const count = picking ? shown.length : 0;
  // 렌더 중 상태 조정(effect 아님): 글이 바뀌면 Esc로 닫은 것을 풀고, 후보 수가 바뀌면 활성 후보를 처음으로.
  if (dismissed !== null && dismissed !== value) setDismissed(null);
  if (count !== lastCount) {
    setLastCount(count);
    setActive(0);
  }
  // 열릴 때와 후보 수가 바뀔 때만 한 번 알린다(글자마다 읽지 않는다).
  const mentionSay = count ? `멘션 후보 ${count}명, 위아래 화살표로 고르세요` : '';
  // 안내는 한 줄로만(say): 새 입력 중 문구가 생길 때, 후보 목록이 열릴 때·후보 수가 바뀔 때. 글자마다 읽지 않는다.
  useEffect(() => {
    if (typingLabel) say?.(typingLabel);
  }, [typingLabel, say]);
  useEffect(() => {
    if (mentionSay) say?.(mentionSay);
  }, [mentionSay, say]);
  const choose = (name: string) => {
    onSelectMention?.(name);
    ref.current?.focus(); // 목록이 사라져도 포커스가 body로 떨어지지 않게
  };
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background }}>
      {typingLabel ? (
        <AppText variant="small" color="textMuted" style={{ paddingHorizontal: space[3], paddingTop: space[0] }}>
          {typingLabel}
        </AppText>
      ) : null}
      {picking ? <MentionPicker candidates={shown} active={safeActive} onSelect={choose} /> : null}
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
        {onPickImage ? <IconButton icon={ImagePlus} label="사진 보내기" onPress={onPickImage} busy={photoBusy} disabled={photoBusy} /> : null}
        <TextInput
          ref={ref}
          accessibilityLabel={replyTo ? `메시지 입력, ${replyTo.name}에게 답장 중` : '메시지 입력'}
          multiline
          maxLength={2000}
          value={value}
          onChangeText={onChangeText}
          onSelectionChange={(e) => onSelectionChange?.(e.nativeEvent.selection.start)}
          selection={selection}
          onBlur={onBlur}
          placeholder="메시지"
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.primary}
          {...(Platform.OS === 'web'
            ? {
                role: 'combobox',
                'aria-expanded': picking,
                'aria-controls': picking ? MENTION_LIST_ID : undefined,
                'aria-autocomplete': 'list',
                'aria-activedescendant': picking ? mentionOptionId(safeActive) : undefined,
              }
            : {})}
          onKeyPress={
            Platform.OS === 'web'
              ? (e) => {
                  const k = e.nativeEvent as Parameters<typeof shouldSubmitOnKey>[0];
                  // 목록이 열려 있으면 보내기보다 먼저 목록 키로 쓴다(Enter가 "@민"을 보내면 안 된다). 한글 조합 중 키는 건드리지 않는다.
                  if (picking && !k.isComposing && k.keyCode !== 229) {
                    const move = (d: number) => {
                      e.preventDefault();
                      setActive((safeActive + d + shown.length) % shown.length);
                    };
                    if (k.key === 'ArrowDown') return move(1);
                    if (k.key === 'ArrowUp') return move(-1);
                    if (k.key === 'Enter' || (k.key === 'Tab' && !k.shiftKey)) {
                      e.preventDefault();
                      return choose(shown[safeActive].name);
                    }
                    if (k.key === 'Escape') {
                      e.preventDefault();
                      return setDismissed(value);
                    }
                  }
                  if (picking && k.isComposing && k.key === 'Enter') return;
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
