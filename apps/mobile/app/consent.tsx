import Check from 'lucide-react-native/icons/check';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../components/AppText';
import { Button } from '../components/Button';
import { saveConsent } from '../lib/consent';
import { currentIosWebState } from '../lib/iosWeb';
import { focusRing, useTheme } from '../lib/theme';

// 문구는 바꾸지 않는다(바꾸면 lib/consent.ts의 CONSENT_VERSION을 올려 다시 동의받는다).
const PARTICIPATION = '이 앱은 수업 프로젝트의 1주 파일럿이에요. 언제든 그만둘 수 있고, 그만두고 싶으면 진행하는 팀에 알려 주세요.';
const AI_ITEMS = [
  '보내기를 누르면 문장과 이 방의 최근 대화 8개를 말투 확인 AI가 읽어요. 이름·전화번호·이메일 같은 정보는 가린 뒤 보내요. 최대 3초 확인하고, 경고가 있으면 수정하거나 그대로 보낼 수 있어요.',
  '사진은 AI에 보내지 않아요.',
  '털어놓은 글은 저장하지 않아요. 누가 남겼는지 상대에게 알려 주지 않아요.',
  '거울 카드에 내가 보낸 문장이 나올 수 있어요. 나에게만 보여요.',
  '실제 대화는 입력을 학습에 쓸 수 있는 무료 AI 서비스에 보내지 않아요.',
];
const IOS_NOTICE = "아이폰은 iOS 16.4 이상에서, Safari 공유 버튼 → '홈 화면에 추가'로 연 앱에서만 알림을 받을 수 있어요.";
const IOS_TOO_OLD = '지금 iOS 버전에서는 알림을 받을 수 없어요. 대화는 그대로 쓸 수 있어요.';
const AGREE = '읽었고, 파일럿에 참여할게요';

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { space } = useTheme();
  return (
    <View style={{ gap: space[1] }}>
      <AppText accessibilityRole="header" aria-level={2} weight="700">
        {title}
      </AppText>
      {children}
    </View>
  );
}

export default function Consent() {
  const { colors, space, radius } = useTheme();
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const ios = currentIosWebState();

  const start = async () => {
    setSaving(true);
    await saveConsent(); // 끝나면 _layout의 게이트가 앱으로 넘긴다
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ padding: space[3], paddingBottom: space[6] }}>
        <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[5] }}>
          <AppText accessibilityRole="header" aria-level={1} variant="large" style={{ marginTop: space[3] }}>
            시작하기 전에
          </AppText>

          <Section title="참여">
            <AppText>{PARTICIPATION}</AppText>
          </Section>

          <Section title="AI가 보는 것">
            <View role="list" style={{ gap: space[1] + 2, padding: space[2] + 2, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
              {AI_ITEMS.map((t) => (
                <View key={t} role="listitem" style={{ flexDirection: 'row', gap: space[2] }}>
                  <AppText color="textMuted" aria-hidden>
                    •
                  </AppText>
                  <AppText style={{ flex: 1 }}>{t}</AppText>
                </View>
              ))}
            </View>
          </Section>

          {(ios === 'needs-install' || ios === 'too-old') && (
            <Section title="아이폰 알림">
              <AppText>{IOS_NOTICE}</AppText>
              {ios === 'too-old' && <AppText>{IOS_TOO_OLD}</AppText>}
            </Section>
          )}

          <Pressable
            onPress={() => setAgreed((v) => !v)}
            // 웹(react-native-web)은 button 역할만 Space로 눌린다. 체크 상자는 Space로도 토글한다(Enter는 onPress가 받는다).
            onKeyDown={(e) => {
              if (e.nativeEvent.key === ' ') {
                e.preventDefault(); // 페이지가 스크롤되지 않게
                if (!e.nativeEvent.repeat) setAgreed((v) => !v); // 키를 누르고 있어도 한 번만 토글
              }
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: agreed }}
            aria-checked={agreed} // 웹은 accessibilityState.checked를 aria-checked로 옮기지 않는다
            accessibilityLabel={AGREE}
            style={({ pressed }) => ({
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[2],
              opacity: pressed ? 0.8 : 1,
              ...focusRing(colors.primary),
            })}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                borderWidth: 2,
                borderColor: agreed ? colors.primary : colors.borderStrong,
                backgroundColor: agreed ? colors.primary : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {agreed && <Check color={colors.onPrimary} size={16} />}
            </View>
            <AppText style={{ flex: 1 }}>{AGREE}</AppText>
          </Pressable>

          <Button label="시작하기" onPress={start} disabled={!agreed} loading={saving} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
