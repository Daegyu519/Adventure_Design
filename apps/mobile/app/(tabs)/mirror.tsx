import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { FocusBox, KIND, SceneMsg, type DoneInfo } from '../../components/mirror/parts';
import { useAnnounce } from '../../lib/announce';
import { PredictCard } from '../../components/mirror/PredictCard';
import { ReceiveCard } from '../../components/mirror/ReceiveCard';
import { RoleplayCard } from '../../components/mirror/RoleplayCard';
import { engine } from '../../lib/engine';
import { didLine, pickCheer, type Card } from '../../lib/mirror';
import { focusRing, useTheme } from '../../lib/theme';

// 다시 받은 뒤에는 포커스를 카드 묶음으로 옮긴다(누르던 버튼이 사라지므로). 처음 열 때는 옮기지 않는다.
function CardList({ children, focusOnMount, say }: { children: ReactNode; focusOnMount: boolean; say(t: string): void }) {
  return focusOnMount ? (
    <FocusBox label="오늘의 카드" say={say}>
      {children}
    </FocusBox>
  ) : (
    <View style={{ flex: 1 }}>{children}</View>
  );
}

const CARD = { roleplay: RoleplayCard, receive: ReceiveCard, predict: PredictCard };

// 마무리: 격려 두 줄 + 오늘 고른 말 + 오늘 한 일. 점수·순위·연속 기록·축하 효과 없음(MASTER 거울 원칙).
function Finish({ cards, info, seed, onJump }: { cards: Card[]; info: Record<string, DoneInfo>; seed: number; onJump(i: number): void }) {
  const { colors, space, radius, fx } = useTheme();
  const [a, b] = pickCheer(seed);
  const role = cards.find((c) => c.kind === 'roleplay');
  const picked = role ? info[role.card_id]?.picked : undefined;
  return (
    <View style={{ flex: 1, justifyContent: 'center', gap: space[2] + 2, padding: space[2], paddingTop: space[3], borderRadius: radius.card + 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
      <View style={{ alignItems: 'center', gap: space[1] + 4 }}>
        <Image source={require('../../assets/images/oops-mark.png')} alt="" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 60, height: 60, borderRadius: 16, boxShadow: fx.bloom }} />
        <View accessible accessibilityRole="header" accessibilityLabel={`${a} ${b}`} style={{ alignItems: 'center', marginTop: 4 }}>
          {[a, b].map((l) => (
            <AppText key={l} aria-hidden variant="title" weight="700" style={{ fontSize: 24, lineHeight: 33, letterSpacing: -0.6 }}>
              {l}
            </AppText>
          ))}
        </View>
        <AppText accessibilityLiveRegion="polite" color="textMuted" style={{ fontSize: 14 }}>
          오늘 카드 {cards.length}장을 모두 풀었어요
        </AppText>
      </View>
      {picked ? (
        <View style={{ gap: space[1], padding: space[2] - 2, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background }}>
          <AppText variant="small" color="textMuted">
            오늘 내가 고른 말
          </AppText>
          <SceneMsg who="me" text={picked} name="나" />
          <AppText variant="small" color="textMuted" style={{ alignSelf: 'flex-end', fontSize: 11 }}>
            {`${role?.persona}에게 보낸다면`}
          </AppText>
        </View>
      ) : null}
      <View style={{ gap: space[1] }}>
        <AppText variant="small" color="textMuted" style={{ paddingHorizontal: 2 }}>
          오늘 한 일
        </AppText>
        <View style={{ borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, overflow: 'hidden' }}>
          {cards.map((c, i) => {
            const line = didLine(c.kind, info[c.card_id] ?? {});
            return (
              <Pressable
                key={c.card_id}
                onPress={() => onJump(i)}
                accessibilityRole="button"
                accessibilityLabel={`${KIND[c.kind]}, ${line}, 다시 보기`}
                style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: space[1] + 2, paddingHorizontal: space[2] - 4, borderTopWidth: i ? 1 : 0, borderTopColor: colors.border, opacity: pressed ? 0.7 : 1, ...focusRing(colors.primary) })}
              >
                <View aria-hidden style={{ width: 84, alignItems: 'flex-start' }}>
                  <View style={{ paddingVertical: 3, paddingHorizontal: 9, borderRadius: radius.chip, backgroundColor: colors.hintBg }}>
                    <AppText weight="700" style={{ color: colors.hintText, fontSize: 11, lineHeight: 16 }}>
                      {KIND[c.kind]}
                    </AppText>
                  </View>
                </View>
                <AppText aria-hidden numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>
                  {line}
                </AppText>
                <AppText aria-hidden color="textMuted" style={{ fontSize: 18 }}>
                  ›
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

export default function Mirror() {
  const { colors, space } = useTheme();
  // 카드는 탭을 처음 열 때 한 번만 받아 세션 동안 들고 있는다(포커스마다 다시 받으면 풀던 카드가 바뀔 수 있다, AGENTS 8장).
  const [cards, setCards] = useState<Card[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0); // 다시 시도·카드 새로 받기만 올린다. 포커스로는 다시 받지 않는다
  const [done, setDone] = useState<Set<string>>(new Set());
  const [info, setInfo] = useState<Record<string, DoneInfo>>({});
  const [idx, setIdx] = useState(0); // 지금 보는 카드. cards.length면 마무리
  const [seed, setSeed] = useState(0); // 마무리 격려 문구를 고른다
  const { say, region } = useAnnounce(); // 영역은 화면에 하나: 카드·결과 상자는 이 say를 받는다

  useEffect(() => {
    let alive = true;
    engine
      .mirrorToday()
      .then((r) => {
        if (!alive) return;
        setCards(r.cards);
        setDone(new Set()); // 새 카드가 올 때 비운다(받는 동안은 푼 개수를 그대로 둔다)
        setInfo({});
        setIdx(0);
        setSeed(Math.floor(Math.random() * 1000));
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

  const n = cards?.length ?? 0;
  const finished = cards != null && idx >= n;
  const cur = cards && idx < n ? cards[idx] : null;
  const curDone = cur ? done.has(cur.card_id) : false;
  const go = (to: number) => {
    setIdx(to);
    if (!cards) return;
    say(to >= cards.length ? '마무리, 오늘 카드를 모두 풀었어요' : `${to + 1}번째 카드, ${KIND[cards[to].kind]}`);
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: space[3] + 4, paddingTop: space[0], paddingBottom: space[1] }}>
        <AppText accessibilityRole="header" aria-level={1} variant="large">
          거울
        </AppText>
        {cards ? (
          <View style={{ alignItems: 'flex-end', gap: 6, paddingBottom: 4 }}>
            <AppText variant="small" color="textMuted" aria-hidden>
              {finished ? `오늘 푼 카드 ${done.size} / ${n}` : `${idx + 1} / ${n}`}
            </AppText>
            <View accessible accessibilityLabel={`오늘 푼 카드 ${done.size} / ${n}`} style={{ flexDirection: 'row', gap: 6 }}>
              {cards.map((c, i) => (
                <View
                  key={c.card_id}
                  aria-hidden
                  style={{ width: 22, height: 6, borderRadius: 3, backgroundColor: done.has(c.card_id) ? colors.primary : colors.fillDim, ...(i === idx ? { outlineColor: colors.accent, outlineWidth: 1.5, outlineOffset: 2 } : null) }}
                />
              ))}
            </View>
          </View>
        ) : null}
      </View>
      {region}
      {failed && (
        <View style={{ gap: space[3], alignItems: 'flex-start', paddingHorizontal: space[3] + 4 }}>
          <AppText accessibilityRole="alert">지금은 카드를 불러오지 못했어요. 잠시 뒤 다시 해 주세요.</AppText>
          <Button label="다시 시도" onPress={retry} loading={loading} />
        </View>
      )}
      {cards === null ? (
        !failed && <ActivityIndicator accessibilityLabel="불러오는 중" accessibilityLiveRegion="polite" color={colors.primary} />
      ) : (
        <>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, paddingHorizontal: space[2] - 2, paddingTop: 6, paddingBottom: space[2] - 4 }} keyboardShouldPersistTaps="handled">
            <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', flex: 1 }}>
              {/* 카드 세 장은 계속 그려 두고 지금 카드만 보인다: 풀던 답과 결과가 넘겨도 남는다("이전"으로 다시 보기) */}
              <CardList key={attempt} focusOnMount={attempt > 0} say={say}>
                {cards.map((c, i) => {
                  const Body = CARD[c.kind];
                  return (
                    <View key={c.card_id} style={{ flex: 1, display: i === idx ? 'flex' : 'none' }}>
                      <Body
                        card={c}
                        say={say}
                        onRefresh={retry}
                        onDone={(d) => {
                          setDone((s) => new Set(s).add(c.card_id));
                          setInfo((m) => ({ ...m, [c.card_id]: d ?? {} }));
                        }}
                      />
                    </View>
                  );
                })}
                {finished ? <Finish cards={cards} info={info} seed={seed} onJump={go} /> : null}
              </CardList>
            </View>
          </ScrollView>
          {/* 넘김 막대: 답하면 "다음 카드", 이전은 푼 카드를 다시 보는 용도(답을 고치지는 않는다) */}
          <View style={{ minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: space[1], paddingHorizontal: space[2] - 2, paddingVertical: space[1] + 2, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background }}>
            {idx > 0 ? <Button label="‹ 이전" accessibilityLabel="이전 카드" kind="secondary" onPress={() => go(idx - 1)} /> : null}
            {finished ? (
              <AppText color="textMuted" style={{ flex: 1, textAlign: 'center', fontSize: 13 }}>
                내일 새 카드가 와요
              </AppText>
            ) : curDone ? (
              <View style={{ flex: 1 }}>
                <Button label={idx === n - 1 ? '마무리 보기' : '다음 카드 →'} accessibilityLabel={idx === n - 1 ? '마무리 보기' : '다음 카드'} onPress={() => go(idx + 1)} />
              </View>
            ) : (
              <AppText color="textMuted" style={{ flex: 1, textAlign: 'center', fontSize: 13 }}>
                답하면 다음 카드로 넘어가요
              </AppText>
            )}
          </View>
        </>
      )}
    </SafeAreaView>
  );
}
