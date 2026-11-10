import { View } from 'react-native';

import { useTheme } from '../lib/theme';
import { AppText } from './AppText';

// 둥근 이름 첫 글자 아바타(사진 없음). 이름은 옆 글자·접근성 이름이 이미 전하므로 화면 읽기 프로그램에는 숨긴다.
export function Avatar({ name, size = 38 }: { name: string; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.fillDim, alignItems: 'center', justifyContent: 'center' }}
    >
      <AppText weight="700" style={{ fontSize: size * 0.4, lineHeight: size * 0.5 }}>
        {Array.from(name.trim())[0] ?? '?'}
      </AppText>
    </View>
  );
}
