import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { supabase } from '../../lib/supabase';
import { useTheme } from '../../lib/theme';

// 대화 목록은 T-09a가 채운다. 지금은 빈 상태뿐이다: 코드를 만들어 보내거나 받은 코드를 넣는다.
export default function Chats() {
  const { colors, space } = useTheme();
  const router = useRouter();
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background, padding: space[3] }}>
      <AppText accessibilityRole="header" aria-level={1} variant="title">
        대화
      </AppText>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space[3], paddingBottom: space[6] }}>
        <AppText accessibilityRole="header" aria-level={2} weight="600">
          아직 대화가 없어요
        </AppText>
        <AppText color="textMuted" style={{ textAlign: 'center' }}>
          초대 코드를 만들어 보내거나, 받은 코드를 입력해 보세요.
        </AppText>
        <View style={{ gap: space[1], alignItems: 'stretch', alignSelf: 'stretch', maxWidth: 320, width: '100%' }}>
          <Button label="초대 코드 만들기" onPress={() => router.push('/rooms/new?tab=direct')} />
          <Button label="코드 입력" kind="secondary" onPress={() => router.push('/rooms/new?tab=join')} />
        </View>
        {!supabase && (
          <AppText variant="small" color="textMuted" style={{ textAlign: 'center' }}>
            Supabase 키가 없어요. `.env`를 채우면 대화가 보여요
          </AppText>
        )}
      </View>
    </SafeAreaView>
  );
}
