import type { ReactNode } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

import { APP_MAX_WIDTH, useTheme } from '../lib/theme';

// 웹에서 창이 휴대폰 폭보다 넓으면(태블릿·데스크톱) 앱을 가운데 기둥(APP_MAX_WIDTH)에 둔다. 바깥은 surface, 기둥은 테두리로 구분.
// 창 크기가 바뀌어도 트리 모양은 그대로 두고 스타일만 바꾼다(감싸는 View를 넣다 뺐다 하면 화면이 다시 그려져 내비게이션이 처음으로 돌아간다).
// 네이티브는 감싸지 않는다.
export function AppFrame({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  if (Platform.OS !== 'web') return <>{children}</>;
  const wide = width > APP_MAX_WIDTH;
  return (
    <View style={{ flex: 1, alignItems: 'center', backgroundColor: wide ? colors.surface : colors.background }}>
      <View
        style={{
          flex: 1,
          width: '100%',
          maxWidth: APP_MAX_WIDTH,
          backgroundColor: colors.background,
          ...(wide ? { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.border } : null),
        }}
      >
        {children}
      </View>
    </View>
  );
}
