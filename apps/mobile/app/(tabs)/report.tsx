import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { engine, type StatsRes } from '../../lib/engine';
import { barHeights, formatRate, gapTile, kstDate, thisWeekCount, weekLabel, weekSpoken, weekStart, WEEKS_SHOWN } from '../../lib/report';
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

// MASTER 5장: 이번 주는 primary, 지난 주들은 textMuted, 위 모서리 4px, 값은 글자색 토큰. 등급·순위·빨강/초록 없음.
function WeekBars({ weeks, thisWeek }: { weeks: StatsRes['hints_by_week']; thisWeek: string }) {
  const { colors, space } = useTheme();
  const heights = barHeights(weeks.map((w) => w.count), BAR_MAX_PX);
  return (
    <View style={{ flexDirection: 'row' }}>
      {weeks.map((w, i) => {
        const now = w.week === thisWeek;
        return (
          <View
            key={w.week}
            accessible
            accessibilityRole="image"
            accessibilityLabel={`${now ? '이번' : `${weekSpoken(w.week)}`} 주 힌트 ${w.count}번`}
            style={{ flex: 1 }}
          >
            <View style={{ height: BAR_MAX_PX + BAR_VALUE_ROOM, alignItems: 'center', justifyContent: 'flex-end', gap: space[0], borderBottomWidth: 1, borderBottomColor: colors.border }}>
              <AppText variant="small" color={now ? 'text' : 'textMuted'} weight={now ? '600' : '400'}>
                {String(w.count)}
              </AppText>
              {/* 값 0이면 높이 0이라 글자만 남는다. */}
              <View style={{ width: 28, height: heights[i], backgroundColor: now ? colors.primary : colors.textMuted, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />
            </View>
            <AppText variant="small" color="textMuted" style={{ textAlign: 'center', paddingTop: space[0] }}>
              {now ? '이번 주' : weekLabel(w.week)}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}

export default function Report() {
  const { colors, radius, space } = useTheme();
  const [stats, setStats] = useState<StatsRes | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // 화면이 포커스를 받을 때마다 새로 읽는다. 다른 탭으로 가면 진행 중인 요청을 끊는다.
  // 요청이 겹치면(열 때 시작한 요청 + 당겨서 새로고침) 가장 나중에 시작한 요청의 결과만 쓴다.
  const latest = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const mine = ++latest.current;
    try {
      const s = await engine.stats({ signal });
      if (mine !== latest.current) return;
      setStats(s);
      setFailed(false);
    } catch {
      if (mine !== latest.current || signal?.aborted) return; // 밀린 요청이나 우리가 끊은 것은 실패가 아니다
      setFailed(true);
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

  const today = kstDate(new Date()); // 순수 함수에는 날짜를 넘긴다
  const gap = stats ? gapTile(stats.predict_gap_trend) : null;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{ padding: space[3], paddingBottom: space[6] }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} />}
      >
        <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[5] }}>
          <AppText accessibilityRole="header" aria-level={1} variant="large">
            리포트
          </AppText>

          {failed && (
            <View style={{ gap: space[3], alignItems: 'flex-start' }}>
              {/* 글이 든 채로 붙는 live 영역은 웹에서 안 읽힌다: 글자 자체가 alert */}
              <AppText accessibilityRole="alert">지금은 불러오지 못했어요</AppText>
              <Button label="다시 시도" onPress={refresh} loading={refreshing} />
            </View>
          )}

          {stats === null || gap === null ? (
            !failed && <ActivityIndicator accessibilityLabel="불러오는 중" color={colors.primary} />
          ) : (
            <>
              <View style={{ flexDirection: 'row', gap: space[1] }}>
                <Tile label={gap.label} value={gap.value} />
                <Tile label="이번 주 힌트" value={`${thisWeekCount(stats.hints_by_week, today)}번`} />
                <Tile label="스스로 고친 비율" value={formatRate(stats.fix_rate)} />
              </View>

              <View style={{ gap: space[2], padding: space[3], borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
                <View>
                  <AppText accessibilityRole="header" aria-level={2} weight="600">
                    주별 힌트 수
                  </AppText>
                  <AppText variant="small" color="textMuted">{`최근 ${WEEKS_SHOWN}주`}</AppText>
                </View>
                <WeekBars weeks={stats.hints_by_week.slice(-WEEKS_SHOWN)} thisWeek={weekStart(today)} />
              </View>
            </>
          )}

          <AppText variant="small" color="textMuted">
            힌트 수는 점수가 아니에요. 보내기 전에 한 번 더 돌아본 횟수일 수 있어요.
          </AppText>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
