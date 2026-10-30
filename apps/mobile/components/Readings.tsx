import { View } from 'react-native';

import type { MirrorAnswerRes } from '../lib/engine';
import { useTheme } from '../lib/theme';
import { AppText } from './AppText';

const KEYS = ['차갑게', '성의없게', '화나게', '무난하게', '따뜻하게'] as const;
const PIPS = { 자주: 3, 가끔: 2, 드물어요: 1 } as const;

// "이렇게 읽힐 수 있어요" 격자(MASTER 살펴보기 시트): 읽힘 이름 · 점 3개 · 단계 글자. 퍼센트 없음, 단계는 글자로도 전한다.
export function Readings({ readings }: { readings: MirrorAnswerRes['readings'] }) {
  const { colors, radius, space } = useTheme();
  return (
    <View style={{ gap: space[1] }}>
      <AppText accessibilityRole="header" aria-level={3} variant="small" color="textMuted">
        이렇게 읽힐 수 있어요
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[1] }}>
        {KEYS.map((k) => {
          const level = readings[k];
          return (
            <View
              key={k}
              accessible
              accessibilityLabel={`${k} ${level}`}
              style={{ flexGrow: 1, flexBasis: '30%', paddingVertical: space[1], paddingHorizontal: space[2], borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}
            >
              <AppText weight="600">{k}</AppText>
              <View style={{ flexDirection: 'row', gap: 4, marginTop: 4 }}>
                {[1, 2, 3].map((i) => (
                  <View key={i} style={{ width: 8, height: 8, borderRadius: radius.chip, backgroundColor: i <= PIPS[level] ? colors.primary : colors.border }} />
                ))}
              </View>
              <AppText variant="small" color="textMuted" style={{ marginTop: 2 }}>
                {level}
              </AppText>
            </View>
          );
        })}
      </View>
    </View>
  );
}
