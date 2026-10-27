import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { engine, type StatsRes } from '../../lib/engine';
import { barHeights, formatRate, latestGap, weekLabel, weekSpoken, WEEKS_SHOWN } from '../../lib/report';
import { useTheme } from '../../lib/theme';

const BAR_MAX_PX = 120;
const BAR_VALUE_ROOM = 24; // 막대 위 값 글자(13 × 1.5)와 간격이 들어갈 높이

function Tile({ label, value }: { label: string; value: string }) {
  const { colors, radius, space } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label} ${value}`}
      style={{ flex: 1, minWidth: 0, gap: space[0], padding: space[2], borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}
    >
      <AppText variant="title" weight="600">
        {value}
      </AppText>
      <AppText variant="small" color="textMuted">
        {label}
      </AppText>
    </View>
  );
}

function WeekBars({ weeks }: { weeks: StatsRes['hints_by_week'] }) {
  const { colors, space } = useTheme();
  const heights = barHeights(weeks.map((w) => w.count), BAR_MAX_PX);
  return (
    <View style={{ flexDirection: 'row' }}>
      {weeks.map((w, i) => (
        <View key={w.week} accessible accessibilityRole="image" accessibilityLabel={`${weekSpoken(w.week)} 주 힌트 ${w.count}번`} style={{ flex: 1 }}>
          <View style={{ height: BAR_MAX_PX + BAR_VALUE_ROOM, alignItems: 'center', justifyContent: 'flex-end', gap: space[0], borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <AppText variant="small">{String(w.count)}</AppText>
            {/* 위 모서리만 4px 둥글게(MASTER 5장). 값 0이면 높이 0이라 글자만 남는다. */}
            <View style={{ width: '60%', maxWidth: 40, height: heights[i], backgroundColor: colors.primary, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />
          </View>
          <AppText variant="small" color="textMuted" style={{ textAlign: 'center', paddingTop: space[0] }}>
            {weekLabel(w.week)}
          </AppText>
        </View>
      ))}
    </View>
  );
}

export default function Report() {
  const { colors, space } = useTheme();
  const [stats, setStats] = useState<StatsRes | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // 화면이 포커스를 받을 때마다 새로 읽는다. 다른 탭으로 가면 진행 중인 요청을 끊는다.
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const s = await engine.stats({ signal });
      setStats(s);
      setFailed(false);
    } catch {
      if (!signal?.aborted) setFailed(true); // 우리가 끊은 것은 실패가 아니다
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ctrl = new AbortController();
      load(ctrl.signal);
      return () => ctrl.abort();
    }, [load]),
  );

  // 당겨서 새로고침과 다시 시도가 같은 길이다.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const gap = stats ? latestGap(stats.predict_gap_trend) : null;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{ padding: space[3], paddingBottom: space[6] }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} />}
      >
        <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[5] }}>
          <AppText accessibilityRole="header" aria-level={1} variant="title">
            리포트
          </AppText>

          {failed ? (
            <View accessibilityLiveRegion="polite" style={{ gap: space[3], alignItems: 'flex-start' }}>
              <AppText>지금은 불러오지 못했어요</AppText>
              <Button label="다시 시도" onPress={refresh} loading={refreshing} />
            </View>
          ) : stats === null ? (
            <ActivityIndicator accessibilityLabel="불러오는 중" color={colors.primary} />
          ) : (
            <>
              <View style={{ flexDirection: 'row', gap: space[1] }}>
                <Tile label="힌트" value={String(stats.hints)} />
                <Tile label="살펴보기" value={String(stats.details)} />
                <Tile label="스스로 고친 비율" value={formatRate(stats.fix_rate)} />
              </View>

              <View style={{ gap: space[2] }}>
                <AppText accessibilityRole="header" aria-level={2} weight="600">
                  {`최근 ${WEEKS_SHOWN}주 힌트 수`}
                </AppText>
                <WeekBars weeks={stats.hints_by_week.slice(-WEEKS_SHOWN)} />
              </View>

              {gap !== null && (
                <AppText color="mirror" weight="600">
                  {gap}
                </AppText>
              )}
            </>
          )}

          <AppText variant="small" color="textMuted">
            숫자는 나만 봐요. 사람을 평가하는 점수가 아니에요.
          </AppText>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
