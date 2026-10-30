import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { FocusBox } from '../../components/mirror/parts';
import { useAnnounce } from '../../lib/announce';
import { PredictCard } from '../../components/mirror/PredictCard';
import { ReceiveCard } from '../../components/mirror/ReceiveCard';
import { RoleplayCard } from '../../components/mirror/RoleplayCard';
import { engine } from '../../lib/engine';
import type { Card } from '../../lib/mirror';
import { useTheme } from '../../lib/theme';

// 다시 받은 뒤에는 포커스를 카드 묶음으로 옮긴다(누르던 버튼이 사라지므로). 처음 열 때는 옮기지 않는다.
function CardList({ children, focusOnMount, say }: { children: ReactNode; focusOnMount: boolean; say(t: string): void }) {
  const { space } = useTheme();
  return focusOnMount ? (
    <FocusBox label="오늘의 카드" say={say}>
      {children}
    </FocusBox>
  ) : (
    <View style={{ gap: space[3] }}>{children}</View>
  );
}

const CARD = { roleplay: RoleplayCard, receive: ReceiveCard, predict: PredictCard };

export default function Mirror() {
  const { colors, space } = useTheme();
  // 카드는 탭을 처음 열 때 한 번만 받아 세션 동안 들고 있는다(포커스마다 다시 받으면 풀던 카드가 바뀔 수 있다, AGENTS 8장).
  const [cards, setCards] = useState<Card[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0); // 다시 시도·카드 새로 받기만 올린다. 포커스로는 다시 받지 않는다
  const [done, setDone] = useState<Set<string>>(new Set());
  const { say, region } = useAnnounce(); // 영역은 화면에 하나: 카드·결과 상자는 이 say를 받는다

  useEffect(() => {
    let alive = true;
    engine
      .mirrorToday()
      .then((r) => {
        if (!alive) return;
        setCards(r.cards);
        setDone(new Set()); // 새 카드가 올 때 비운다(받는 동안은 푼 개수를 그대로 둔다)
        setFailed(false);
      })
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [attempt]);
  // 실패 안내와 다시 시도 버튼은 받는 동안에도 그대로 둔다(버튼이 사라지면 포커스가 body로 떨어진다).
  const retry = () => {
    setLoading(true);
    setAttempt((n) => n + 1);
  };
  // 낡은 카드(422) → 같은 길로 새로 받는다. 이전 카드와 푼 개수는 새 카드가 올 때까지 그대로 둔다.

  const finished = cards != null && done.size >= cards.length;
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ padding: space[3], paddingBottom: space[6] }} keyboardShouldPersistTaps="handled">
        <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[3] }}>
          <AppText accessibilityRole="header" aria-level={1} variant="title">
            거울
          </AppText>
          {region}
          {failed && (
            <View style={{ gap: space[3], alignItems: 'flex-start' }}>
              <AppText accessibilityRole="alert">지금은 카드를 불러오지 못했어요. 잠시 뒤 다시 해 주세요.</AppText>
              <Button label="다시 시도" onPress={retry} loading={loading} />
            </View>
          )}
          {cards === null ? (
            !failed && <ActivityIndicator accessibilityLabel="불러오는 중" accessibilityLiveRegion="polite" color={colors.primary} />
          ) : (
            <>
              <AppText variant="small" color="textMuted">{`오늘 푼 카드 ${done.size} / ${cards.length}`}</AppText>
              <CardList key={attempt} focusOnMount={attempt > 0} say={say}>
                {cards.map((c) => {
                  const Body = CARD[c.kind];
                  return <Body key={c.card_id} card={c} say={say} onRefresh={retry} onDone={() => setDone((d) => new Set(d).add(c.card_id))} />;
                })}
              </CardList>
              {/* 마무리는 늘 있는 polite 자리에 글만 채운다. 포커스를 가져오거나 alert로 마지막 카드 결과를 덮지 않는다. */}
              <AppText accessibilityLiveRegion="polite" weight="600">
                {finished ? (cards.length ? '오늘 카드는 여기까지예요. 내일 또 만나요.' : '오늘은 준비된 카드가 없어요. 내일 또 만나요.') : ''}
              </AppText>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
