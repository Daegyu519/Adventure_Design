import { Tabs } from 'expo-router';
// 아이콘은 하나씩 불러온다. 묶음 import는 웹 번들에 아이콘 전체(약 2MB)가 들어간다.
import ChartColumn from 'lucide-react-native/icons/chart-column';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import ScanFace from 'lucide-react-native/icons/scan-face';
import Settings from 'lucide-react-native/icons/settings';

import { useTheme } from '../../lib/theme';

const ICON_SIZE = 24; // MASTER 4장: 아이콘 24px, 선 굵기 2(Lucide 기본값)

export default function TabsLayout() {
  const { colors, font } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.border },
        tabBarLabelStyle: { fontFamily: font.family, fontSize: font.small },
      }}
    >
      <Tabs.Screen name="index" options={{ title: '대화', tabBarIcon: ({ color }) => <MessageCircle color={color} size={ICON_SIZE} /> }} />
      <Tabs.Screen name="mirror" options={{ title: '거울', tabBarIcon: ({ color }) => <ScanFace color={color} size={ICON_SIZE} /> }} />
      <Tabs.Screen name="report" options={{ title: '리포트', tabBarIcon: ({ color }) => <ChartColumn color={color} size={ICON_SIZE} /> }} />
      <Tabs.Screen name="settings" options={{ title: '설정', tabBarIcon: ({ color }) => <Settings color={color} size={ICON_SIZE} /> }} />
    </Tabs>
  );
}
