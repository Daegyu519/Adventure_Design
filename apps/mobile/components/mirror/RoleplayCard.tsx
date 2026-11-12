import { useState } from 'react';
import { View } from 'react-native';

import { useTheme } from '../../lib/theme';
import { AppText } from '../AppText';
import { Button } from '../Button';
import { DiffText } from '../DiffText';
import { Readings } from '../Readings';
import { TextField } from '../TextField';
import { CardShell, DisabledHint, ErrorLine, FocusBox, Recall, Scene, SceneMsg, useAnswer, type CardProps } from './parts';

// 장면 → 답장 쓰기 → 속마음·읽힘 → 그대로 / A / 직접 고치기 → "보냈다면" 장면. 그대로나 A를 고르면 카드가 끝난다.
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
              <AppText accessibilityRole="alert" weight="600" color="accent">
                {choice === 'a' ? 'A로 바꿨어요' : '내가 쓴 그대로 두었어요'}
              </AppText>
              {/* 고른 뒤: 빈 곳 대신 "보냈다면" 장면 — 내 답장이 대화에 놓이고 상대의 속마음이 따라온다 */}
              <View style={{ flex: 1, minHeight: 150, maxHeight: 340, gap: space[1], padding: space[2] - 4, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background }}>
                <AppText variant="small" color="textMuted" style={{ textAlign: 'center', fontSize: 12 }}>
                  {choice === 'a' ? 'A로 바꿔 보냈다면' : '내가 쓴 그대로 보냈다면'}
                </AppText>
                <View style={{ flex: 1, justifyContent: 'flex-end', gap: space[1] }}>
                  {card.context ? <SceneMsg who="them" text={card.context} name={card.persona} /> : null}
                  <SceneMsg who="them" text={card.message} name={card.persona} />
                  <View style={{ alignSelf: 'flex-end', maxWidth: '88%', paddingVertical: 9, paddingHorizontal: 13, borderRadius: 18, borderBottomRightRadius: 6, backgroundColor: colors.primary }}>
                    {choice === 'a' && option ? (
                      <DiffText original={text} revised={option.text} base="onPrimary" changedColor="onPrimary" />
                    ) : (
                      <AppText selectable color="onPrimary" style={{ fontSize: 15 }}>
                        {text}
                      </AppText>
                    )}
                  </View>
                  {choice === 'keep' && res.inner_voice ? (
                    <View style={{ alignSelf: 'flex-start', marginLeft: 38, maxWidth: '86%', gap: 2, paddingVertical: space[1], paddingHorizontal: space[2] - 4, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderStrong, backgroundColor: colors.surface }}>
                      <AppText variant="small" weight="600" color="accent" style={{ fontSize: 11 }}>{`${card.persona}의 속마음`}</AppText>
                      <AppText style={{ fontSize: 14, lineHeight: 20 }}>{res.inner_voice}</AppText>
                    </View>
                  ) : null}
                </View>
              </View>
              {choice === 'keep' ? <Readings readings={res.readings} top={3} /> : null}
            </>
          ) : (
            <>
              <Recall card={card} />
              <View style={{ gap: space[0], padding: space[2] - 4, borderLeftWidth: 3, borderLeftColor: colors.accent, borderRadius: radius.input / 4, backgroundColor: colors.background }}>
                <AppText accessibilityRole="header" aria-level={3} variant="small" color="textMuted">
                  받았을 때 속마음
                </AppText>
                <AppText selectable>{res.inner_voice ?? '특별히 걸리는 곳은 없어 보여요'}</AppText>
              </View>
              {option ? (
                <View style={{ gap: space[0] }}>
                  <AppText variant="small" color="textMuted">{`A · ${option.label}`}</AppText>
                  <DiffText original={text} revised={option.text} />
                </View>
              ) : null}
              <Readings readings={res.readings} top={3} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="그대로"
                    kind="secondary"
                    onPress={() => {
                      setChoice('keep');
                      onDone({ choice: 'keep', picked: text });
                    }}
                  />
                </View>
                {option ? (
                  <View style={{ flex: 1 }}>
                    <Button
                      label="A"
                      accessibilityLabel="A, 고친 문장 고르기"
                      onPress={() => {
                        setChoice('a');
                        onDone({ choice: 'a', picked: option?.text ?? text });
                      }}
                    />
                  </View>
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
      <Scene card={card} />
      <View style={{ gap: space[1] + 2 }}>
        <TextField label="답장" hint="이 말을 받았다고 생각하고 답장을 써 보세요" value={reply} onChangeText={setReply} maxLength={500} multiline autoFocus={editing} editable={!busy} />
        <ErrorLine error={error} stale={stale} onRefresh={onRefresh} />
        <Button label="보내기" disabled={text.length === 0} loading={busy} onPress={() => send({ reply: text })} />
        <DisabledHint show={text.length === 0}>답장을 먼저 적어 주세요</DisabledHint>
      </View>
    </CardShell>
  );
}
