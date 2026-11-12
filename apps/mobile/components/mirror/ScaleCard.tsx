import { useState } from 'react';
import { View } from 'react-native';

import { gapLabel, relationIf, SCALE_WORDS } from '../../lib/mirror';
import { useTheme } from '../../lib/theme';
import { AppText } from '../AppText';
import { Button } from '../Button';
import { Readings } from '../Readings';
import { ScaleRow } from '../ScaleRow';
import { CardShell, DisabledHint, ErrorLine, FocusBox, Recall, Scene, TempBand, useAnswer, type CardProps } from './parts';

// 되돌려 받기(score)와 예측 맞히기(predicted)는 같은 흐름이라 한 컴포넌트로 둔다. 얇은 껍데기로 카드 이름을 맞춘다.
export function ScaleCard({ card, onDone, onRefresh }: CardProps) {
  const { colors, space, fx } = useTheme();
  const [value, setValue] = useState<number | null>(null);
  const { busy, error, stale, res, send } = useAnswer(card);
  const predict = card.kind === 'predict';
  const question = predict ? `${relationIf(card.relation)} 얼마나 부정적으로 읽을까요?` : '받으면 얼마나 차갑게 느껴지나요?';
  const base = predict ? '예측' : '내 느낌';

  if (res) {
    return (
      <CardShell card={card}>
        <Recall card={card} />
        <FocusBox>
          {value != null && res.gap != null ? <TempBand value={value} gap={res.gap} meLabel={base === '예측' ? '내 예측' : '내 느낌'} /> : null}
          <AppText accessibilityRole="alert" variant="title" weight="700" color="accent" style={{ letterSpacing: -0.4 }}>
            {gapLabel(res.gap, base) ?? '답을 받았어요'}
          </AppText>
          {res.reveal ? (
            <View style={{ paddingVertical: space[1] + 2, paddingHorizontal: space[2] - 2, borderRadius: 16, backgroundColor: colors.hintBg, boxShadow: fx.bloom }}>
              <AppText weight="600" style={{ color: colors.hintText, fontSize: 14, lineHeight: 21 }}>
                {res.reveal}
              </AppText>
            </View>
          ) : null}
          <Readings readings={res.readings} top={3} />
        </FocusBox>
      </CardShell>
    );
  }
  return (
    <CardShell card={card}>
      <Scene card={card} />
      <View style={{ gap: space[1] + 2 }}>
        <AppText weight="700" nativeID={`q-${card.card_id}`}>
          {question}
        </AppText>
        <ScaleRow
          value={value}
          onChange={setValue}
          lowLabel={predict ? '덜 부정적' : '따뜻하게'}
          highLabel={predict ? '많이 부정적' : '차갑게'}
          accessibilityLabel={question}
          disabled={busy}
          words={SCALE_WORDS[card.kind]}
        />
        <ErrorLine error={error} stale={stale} onRefresh={onRefresh} />
        <Button
          label="확인하기"
          disabled={value == null}
          loading={busy}
          onPress={async () => {
            if (value == null) return;
            const r = await send(predict ? { predicted: value } : { score: value });
            if (r) onDone({ gap: r.gap });
          }}
        />
        <DisabledHint show={value == null}>칸을 먼저 고르세요</DisabledHint>
      </View>
    </CardShell>
  );
}
