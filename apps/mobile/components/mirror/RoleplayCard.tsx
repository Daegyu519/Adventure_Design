import { useState } from 'react';
import { View } from 'react-native';

import { useTheme } from '../../lib/theme';
import { AppText } from '../AppText';
import { Button } from '../Button';
import { DiffText } from '../DiffText';
import { Readings } from '../Readings';
import { TextField } from '../TextField';
import { CardShell, DisabledHint, ErrorLine, FocusBox, useAnswer, type CardProps } from './parts';

// 답장 쓰기 → 속마음·읽힘 → 그대로 / A / 직접 고치기. 그대로나 A를 고르면 카드가 끝난다.
export function RoleplayCard({ card, onDone, onRefresh, say }: CardProps) {
  const { colors, radius, space } = useTheme();
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState(false); // 직접 고치기로 돌아온 폼이면 입력창에 포커스
  const [choice, setChoice] = useState<'keep' | 'a' | null>(null);
  const { busy, error, stale, res, send, reset } = useAnswer(card);
  const text = reply.trim();
  const option = res?.options?.[0];

  if (res) {
    return (
      <CardShell card={card}>
        <FocusBox key={choice ?? 'result'} label={choice ? undefined : '역할극 결과'} say={say}>
          {choice ? (
            <>
              <AppText accessibilityRole="alert" weight="600" color="mirror">
                {choice === 'a' ? 'A로 바꿨어요' : '내가 쓴 그대로 두었어요'}
              </AppText>
              {choice === 'a' && option ? <DiffText original={text} revised={option.text} /> : <AppText selectable>{text}</AppText>}
            </>
          ) : (
            <>
              <View style={{ gap: space[0], padding: space[2], borderLeftWidth: 3, borderLeftColor: colors.mirror, borderRadius: radius.input / 4, backgroundColor: colors.background }}>
                <AppText accessibilityRole="header" aria-level={3} variant="small" color="textMuted">
                  받았을 때 속마음
                </AppText>
                <AppText selectable>{res.inner_voice ?? '특별히 걸리는 곳은 없어 보여요'}</AppText>
              </View>
              <Readings readings={res.readings} />
              {option ? (
                <View style={{ gap: space[0] }}>
                  <AppText variant="small" color="textMuted">{`A · ${option.label}`}</AppText>
                  <DiffText original={text} revised={option.text} />
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[1] }}>
                <Button
                  label="그대로"
                  kind="secondary"
                  onPress={() => {
                    setChoice('keep');
                    onDone();
                  }}
                />
                {option ? (
                  <Button
                    label="A"
                    accessibilityLabel="A, 고친 문장 고르기"
                    onPress={() => {
                      setChoice('a');
                      onDone();
                    }}
                  />
                ) : null}
                <Button
                  label="직접 고치기"
                  kind="ghost"
                  onPress={() => {
                    setEditing(true);
                    reset();
                  }}
                />
              </View>
            </>
          )}
        </FocusBox>
      </CardShell>
    );
  }
  return (
    <CardShell card={card}>
      <TextField label="답장" hint="이 말을 받았다고 생각하고 답장을 써 보세요" value={reply} onChangeText={setReply} maxLength={500} multiline autoFocus={editing} editable={!busy} />
      <ErrorLine error={error} stale={stale} onRefresh={onRefresh} />
      <Button label="보내기" disabled={text.length === 0} loading={busy} onPress={() => send({ reply: text })} />
      <DisabledHint show={text.length === 0}>답장을 먼저 적어 주세요</DisabledHint>
    </CardShell>
  );
}
