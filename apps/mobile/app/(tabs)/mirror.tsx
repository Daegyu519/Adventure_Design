import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { FocusBox } from '../../components/mirror/parts';
import { PredictCard } from '../../components/mirror/PredictCard';
import { ReceiveCard } from '../../components/mirror/ReceiveCard';
import { RoleplayCard } from '../../components/mirror/RoleplayCard';
import { engine } from '../../lib/engine';
import type { Card } from '../../lib/mirror';
import { useTheme } from '../../lib/theme';

const CARD = { roleplay: RoleplayCard, receive: ReceiveCard, predict: PredictCard };

export default function Mirror() {
  const { colors, space } = useTheme();
  // 카드는 탭을 처음 열 때 한 번만 받아 세션 동안 들고 있는다(포커스마다 다시 받으면 풀던 카드가 바뀔 수 있다, AGENTS 8장).
  const [cards, setCards] = useState<Card[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0); // 다시 시도만 올린다. 포커스로는 다시 받지 않는다
  const [done, setDone] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    engine
      .mirrorToday()
      .then((r) => alive && setCards(r.cards))
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [attempt]);
  const retry = () => {
    setLoading(true);
    setFailed(false);
    setAttempt((n) => n + 1);
  };

  const finished = cards != null && done.size >= cards.length;
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ padding: space[3], paddingBottom: space[6] }} keyboardShouldPersistTaps="handled">
        <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[3] }}>
          <AppText accessibilityRole="header" aria-level={1} variant="title">
            거울
          </AppText>
          {failed ? (
            <View accessibilityLiveRegion="polite" style={{ gap: space[3], alignItems: 'flex-start' }}>
              <AppText accessibilityRole="alert">지금은 카드를 불러오지 못했어요. 잠시 뒤 다시 해 주세요.</AppText>
              <Button label="다시 시도" onPress={retry} loading={loading} />
            </View>
          ) : cards === null ? (
            <ActivityIndicator accessibilityLabel="불러오는 중" color={colors.primary} />
          ) : (
            <>
              <AppText variant="small" color="textMuted">{`오늘의 카드 ${Math.min(done.size + (finished ? 0 : 1), cards.length)} / ${cards.length}`}</AppText>
              {cards.map((c) => {
                const Body = CARD[c.kind];
                return <Body key={c.card_id} card={c} onDone={() => setDone((d) => new Set(d).add(c.card_id))} />;
              })}
              {finished && (
                <FocusBox>
                  <AppText accessibilityRole="alert" weight="600">
                    {cards.length ? '오늘 카드는 여기까지예요. 내일 또 만나요.' : '오늘은 준비된 카드가 없어요. 내일 또 만나요.'}
                  </AppText>
                </FocusBox>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
