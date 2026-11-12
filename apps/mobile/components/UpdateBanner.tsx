import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { focusRing, useTheme } from '../lib/theme';
import { useWebUpdate } from '../lib/webUpdate';
import { AppText } from './AppText';

// 웹에서 새 버전이 나오면 위에 한 줄로 알린다(누르면 새로고침). 네이티브·최신 버전이면 아무것도 안 그린다.
export function UpdateBanner() {
  const { stale, reload } = useWebUpdate();
  return stale ? <Banner reload={reload} /> : null;
}

// 안전 영역은 보일 때만 읽는다(앱 시작 시점에 Provider가 없어도 안전하게)
function Banner({ reload }: { reload(): void }) {
  const { colors, space, radius, fx } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + space[0], left: space[2], right: space[2], zIndex: 100 }}>
      <Pressable
        onPress={reload}
        accessibilityRole="button"
        accessibilityLabel="새 버전이 있어요, 눌러서 새로고침"
        style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2], paddingHorizontal: space[2], borderRadius: radius.input, backgroundColor: colors.hintBg, boxShadow: fx.bloom, opacity: pressed ? 0.85 : 1, ...focusRing(colors.hintText) })}
      >
        <AppText weight="700" style={{ color: colors.hintText, fontSize: 14 }}>
          새 버전이 있어요
        </AppText>
        <View style={{ paddingVertical: 6, paddingHorizontal: space[2], borderRadius: radius.button - 4, backgroundColor: colors.hintText }}>
          <AppText weight="700" style={{ color: colors.hintBg, fontSize: 13 }}>
            새로고침
          </AppText>
        </View>
      </Pressable>
    </View>
  );
}
