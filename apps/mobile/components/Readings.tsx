import { View } from 'react-native';

import type { MirrorAnswerRes } from '../lib/engine';
import { useTheme } from '../lib/theme';
import { AppText } from './AppText';

const KEYS = ['차갑게', '성의없게', '화나게', '무난하게', '따뜻하게'] as const;
const LEVEL = { 자주: 86, 가끔: 55, 드물어요: 22 } as const; // 막대 길이(%). 숫자는 보여 주지 않고 단계 글자로도 전한다

// "이렇게 읽힐 수 있어요"(OOPS 시안): 읽힘 이름 · 단계 글자 · 글로우 막대. 퍼센트 없음, 단계는 글자로도 전한다(색·길이만으로 알리지 않는다).
export function Readings({ readings }: { readings: MirrorAnswerRes['readings'] }) {
  const { colors, space, fx } = useTheme();
  return (
    <View style={{ gap: space[2] }}>
      <AppText accessibilityRole="header" aria-level={3} variant="small" color="textMuted">
        이렇게 읽힐 수 있어요
      </AppText>
      <View style={{ gap: space[2] - 2 }}>
        {KEYS.map((k) => {
          const level = readings[k];
          return (
            <View key={k} accessible accessibilityLabel={`${k} ${level}`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <AppText weight="700" style={{ fontSize: 15 }}>
                  {k}
                </AppText>
                <AppText color={level === '드물어요' ? 'textMuted' : 'accent'} style={{ fontSize: 14 }}>
                  {level}
                </AppText>
              </View>
              <View aria-hidden style={{ height: 10, borderRadius: 5, backgroundColor: colors.bubbleOther, overflow: 'hidden' }}>
                <View style={{ height: 10, borderRadius: 5, width: `${LEVEL[level]}%`, backgroundImage: fx.bar('to right'), ...(level !== '드물어요' ? { boxShadow: `3px 4px 10px ${colors.glowSoft}8C` } : null) }} />
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
