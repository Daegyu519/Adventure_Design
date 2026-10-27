import { Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '../lib/theme';

// 4개 탭 화면이 똑같이 쓰는 "제목만 있는 빈 화면". 각 작업이 화면을 채울 때 대체한다.
export function ScreenTitle({ children }: { children: string }) {
  const { colors, space, font } = useTheme();
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background, padding: space[3] }}>
      <Text
        accessibilityRole="header"
        style={{ color: colors.text, fontFamily: font.family, fontSize: font.title, fontWeight: '600', lineHeight: font.title * font.lineHeight }}
      >
        {children}
      </Text>
    </SafeAreaView>
  );
}
