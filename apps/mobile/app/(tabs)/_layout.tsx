import { Tabs } from 'expo-router';
import { Platform, type ViewStyle } from 'react-native';
// 아이콘은 하나씩 불러온다. 묶음 import는 웹 번들에 아이콘 전체(약 2MB)가 들어간다.
import ChartColumn from 'lucide-react-native/icons/chart-column';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import ScanFace from 'lucide-react-native/icons/scan-face';
import Settings from 'lucide-react-native/icons/settings';

import { useTheme } from '../../lib/theme';

const ICON_SIZE = 24; // MASTER 4장: 아이콘 24px, 선 굵기 2(Lucide 기본값)

// 웹(아이폰 홈 화면 앱·Safari): 홈 막대 자리를 CSS env()로 직접 비운다. JS가 안전 영역을 0으로 읽어도 탭 바가 가려지지 않게(P-22).
// 내용 높이 58px ≥ 탭 항목 54px(위아래 padding 5+5, 아이콘 칸 28, 이름 줄 16) + 여유 4. 이전 값은 이름 아래가 잘렸다(P-23).
// react-native-web은 CSS 문자열을 그대로 넘기지만 RN 타입은 숫자만 받아서 캐스트한다.
const WEB_TAB_SAFE = (Platform.OS === 'web'
  ? { height: 'calc(62px + env(safe-area-inset-bottom))', paddingTop: 4, paddingBottom: 'env(safe-area-inset-bottom)' }
  : {}) as unknown as ViewStyle;

export default function TabsLayout() {
  const { colors, font } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background }, // 다크 모드에서 화면 전환 때 흰 바탕이 번쩍이지 않게
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.border, ...WEB_TAB_SAFE },
        tabBarLabelStyle: { fontFamily: font.family, fontSize: font.small, lineHeight: 16 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: '대화', tabBarIcon: ({ color }) => <MessageCircle color={color} size={ICON_SIZE} /> }} />
      <Tabs.Screen name="mirror" options={{ title: '거울', tabBarIcon: ({ color }) => <ScanFace color={color} size={ICON_SIZE} /> }} />
      <Tabs.Screen name="report" options={{ title: '리포트', tabBarIcon: ({ color }) => <ChartColumn color={color} size={ICON_SIZE} /> }} />
      <Tabs.Screen name="settings" options={{ title: '설정', tabBarIcon: ({ color }) => <Settings color={color} size={ICON_SIZE} /> }} />
    </Tabs>
  );
}
