import { useState } from 'react';

import { gapLabel, relationIf } from '../../lib/mirror';
import { AppText } from '../AppText';
import { Button } from '../Button';
import { Readings } from '../Readings';
import { ScaleRow } from '../ScaleRow';
import { CardShell, ErrorLine, FocusBox, useAnswer, type CardProps } from './parts';

// 되돌려 받기(score)와 예측 맞히기(predicted)는 같은 흐름이라 한 컴포넌트로 둔다. 얇은 껍데기로 카드 이름을 맞춘다.
export function ScaleCard({ card, onDone }: CardProps) {
  const [value, setValue] = useState<number | null>(null);
  const { busy, error, res, send } = useAnswer(card);
  const predict = card.kind === 'predict';
  const question = predict ? `${relationIf(card.relation)} 얼마나 부정적으로 읽을까요?` : '받으면 얼마나 차갑게 느껴지나요?';
  const base = predict ? '예측' : '내 느낌';

  if (res) {
    return (
      <CardShell card={card}>
        <FocusBox>
          <AppText accessibilityRole="alert" variant="title" weight="600" color="mirror">
            {gapLabel(res.gap, base) ?? '답을 받았어요'}
          </AppText>
          {res.reveal ? <AppText>{res.reveal}</AppText> : null}
          <Readings readings={res.readings} />
        </FocusBox>
      </CardShell>
    );
  }
  return (
    <CardShell card={card}>
      <AppText weight="600">{question}</AppText>
      <ScaleRow
        value={value}
        onChange={setValue}
        lowLabel={predict ? '덜 부정적' : '전혀'}
        highLabel={predict ? '많이 부정적' : '매우'}
        accessibilityLabel={question}
        disabled={busy}
      />
      <ErrorLine error={error} />
      <Button
        label="확인하기"
        disabled={value == null}
        loading={busy}
        onPress={async () => {
          if (value != null && (await send(predict ? { predicted: value } : { score: value }))) onDone();
        }}
      />
    </CardShell>
  );
}
