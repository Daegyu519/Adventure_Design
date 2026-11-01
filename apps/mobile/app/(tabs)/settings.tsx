// 아이콘은 하나씩 불러온다(묶음 import는 웹 번들이 커진다).
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { ChipRow } from '../../components/ChipRow';
import { signOutAndClear } from '../../lib/account';
import { useAnnounce } from '../../lib/announce';
import { currentIosWebState } from '../../lib/iosWeb';
import { disablePush, enablePush, pushDenied, pushEnabled, type PushResult } from '../../lib/push';
import { useSession } from '../../lib/session';
import { supabase } from '../../lib/supabase';
import { useTheme, useThemePref, type ThemePref } from '../../lib/theme';

const DENIED_WEB = "알림이 막혀 있어요. 주소창 왼쪽 사이트 설정 → 알림을 '허용'으로 바꾼 뒤 다시 켜 주세요.";
const DENIED_ANDROID = '알림이 막혀 있어요. 휴대폰 설정 → 앱 → tone-chat → 알림을 허용한 뒤 다시 켜 주세요.';
const deniedText = () => (Platform.OS === 'web' ? DENIED_WEB : DENIED_ANDROID);
const PUSH_MESSAGES: Record<Exclude<PushResult, 'enabled' | 'denied'>, string> = {
  unsupported: '이 기기에서는 알림을 받지 못할 수도 있어요',
  'needs-install': "Safari 공유 버튼 → '홈 화면에 추가'로 연 뒤 다시 눌러 주세요",
  error: '알림을 켜지 못했어요. 연결을 확인하고 다시 해 주세요.',
};
const PUSH_OFF_ERROR = '알림을 끄지 못했어요. 연결을 확인하고 다시 해 주세요.';
const NATIVE_IOS = '이 앱에서는 알림을 켤 수 없어요. 아이폰은 웹 버전을 홈 화면에 추가해 쓰면 알림을 받을 수도 있어요.';
const PUSH_NOTE = '켜면 새 메시지가 올 때 알려 줄 수도 있어요. 브라우저가 허용 여부를 물어볼 수 있어요.';
const NOT_CONNECTED = '서버에 연결되어 있지 않아 지금은 바꿀 수 없어요.';

const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];
const THEME_LABELS: Record<ThemePref, string> = { system: '시스템', light: '밝게', dark: '어둡게' };

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { colors, radius, space } = useTheme();
  return (
    <View style={{ gap: space[1] }}>
      <AppText accessibilityRole="header" aria-level={2} variant="small" color="textMuted" weight="600">
        {title}
      </AppText>
      <View style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: radius.card, padding: space[3], gap: space[2] }}>
        {children}
      </View>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const { space } = useTheme();
  return (
    <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3] }}>
      <AppText color="textMuted">{label}</AppText>
      <AppText style={{ flexShrink: 1, textAlign: 'right' }}>{value}</AppText>
    </View>
  );
}

export default function Settings() {
  const { colors, space } = useTheme();
  const { pref, setPref } = useThemePref();
  const { userId, email, profile, refreshProfile } = useSession();

  // 저장하는 동안에는 방금 누른 값을 보여 줘서 스위치가 되돌아갔다 다시 켜지지 않는다.
  const [pending, setPending] = useState<boolean | null>(null);
  const [hintError, setHintError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

  const { say, region } = useAnnounce();
  const [pushOn, setPushOn] = useState<boolean | null>(null); // null = 아직 읽는 중
  const [pushIsDenied, setPushIsDenied] = useState(false);
  const [pushBusy, setPushBusy] = useState<'on' | 'off' | null>(null);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  // 화면을 열 때는 기억해 둔 상태만 읽는다. 권한 요청은 스위치를 누를 때만(브라우저가 시작 때의 요청을 막는다).
  useEffect(() => {
    let alive = true;
    pushEnabled().then((on) => alive && setPushOn(on), () => alive && setPushOn(false));
    pushDenied().then((d) => alive && setPushIsDenied(d), () => {});
    return () => {
      alive = false;
    };
  }, []);

  const connected = supabase !== null && userId !== null;
  const iosInstall = currentIosWebState() === 'needs-install';
  const pushDisabled = !connected || pushOn === null || Platform.OS === 'ios';
  const describedBy = [
    'push-note',
    ...(Platform.OS === 'ios' || !connected ? ['push-reason'] : []),
    ...(iosInstall ? ['push-ios'] : []),
    ...(pushIsDenied && !pushMsg ? ['push-denied'] : []),
  ];
  const hintOn = pending ?? profile?.tone_hint_on ?? true; // 서버 기본값은 켜짐

  // 값만 저장한다. 힌트를 실제로 막고 푸는 일은 입력창 쪽(T-15)이 이 값을 읽어서 한다.
  async function setHint(next: boolean) {
    if (!supabase || !userId || pending !== null) return;
    setPending(next);
    setHintError(false);
    try {
      const { error } = await supabase.from('profiles').update({ tone_hint_on: next }).eq('id', userId);
      if (error) setHintError(true);
      else await refreshProfile();
    } catch {
      setHintError(true);
    } finally {
      setPending(null);
    }
  }

  async function setPush(next: boolean) {
    if (!userId || pushBusy || pushOn === null) return;
    setPushBusy(next ? 'on' : 'off');
    setPushMsg(null);
    // 보이는 alert 글자는 웹·안드로이드가 읽으니 say는 iOS에서만(두 번 읽히지 않게). 성공 안내는 어디서나 say.
    const fail = (m: string) => {
      setPushMsg(m);
      if (Platform.OS === 'ios') say(m);
    };
    try {
      if (next) {
        const r = await enablePush(userId);
        if (r === 'enabled') {
          setPushOn(true);
          setPushIsDenied(false);
          say('알림을 켰어요');
        } else if (r === 'denied') {
          setPushIsDenied(true);
          fail(deniedText());
        } else fail(PUSH_MESSAGES[r]);
      } else {
        try {
          await disablePush(userId);
          setPushOn(false);
          say('알림을 껐어요');
        } catch {
          fail(PUSH_OFF_ERROR);
        }
      }
    } finally {
      setPushBusy(null);
    }
  }

  async function logout() {
    setSigningOut(true);
    setSignOutError(false);
    // 성공하면 세션 구독이 게이트를 로그인 화면으로 돌린다. 이 화면은 곧 사라진다.
    const ok = await signOutAndClear();
    if (!ok) setSignOutError(true);
    setSigningOut(false);
  }

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ padding: space[3], paddingBottom: space[6], gap: space[5] }}>
        <AppText accessibilityRole="header" aria-level={1} variant="title">
          설정
        </AppText>
        {region}

        <Section title="힌트">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            {/* 글자 쪽도 눌러서 켜고 끌 수 있게 해 눌리는 영역을 넓힌다(스위치만 접근성 대상) */}
            <Pressable
              accessible={false}
              tabIndex={-1}
              aria-hidden
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              disabled={!connected}
              onPress={() => setHint(!hintOn)}
              style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}>
              <AppText>보내기 전 말투 힌트</AppText>
            </Pressable>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel="보내기 전 말투 힌트"
              value={hintOn}
              onValueChange={setHint}
              disabled={!connected} // 저장하는 동안 disabled로 바꾸면 포커스를 잃는다. 겹친 호출은 setHint가 막는다
              hitSlop={space[1]}
              trackColor={{ false: colors.textMuted, true: colors.primary }}
              thumbColor={colors.background}
              {...{ activeThumbColor: colors.background } /* react-native-web 전용: 켜진 쪽 동그라미 색(네이티브는 thumbColor 하나로 둘 다) */}
            />
          </View>
          {!hintOn && (
            <AppText variant="small" color="textMuted">
              힌트를 끄면 입력 중인 문장을 AI에 보내지 않아요.
            </AppText>
          )}
          {!connected && (
            <AppText variant="small" color="textMuted">
              서버에 연결되어 있지 않아 지금은 바꿀 수 없어요.
            </AppText>
          )}
          {hintError && (
            <AppText variant="small" color="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
              바꾸지 못했어요. 연결을 확인하고 다시 해 주세요.
            </AppText>
          )}
        </Section>

        <Section title="알림">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            <Pressable
              accessible={false}
              tabIndex={-1}
              aria-hidden
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              disabled={pushDisabled}
              onPress={() => setPush(!pushOn)}
              style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}>
              <AppText>새 메시지 알림</AppText>
            </Pressable>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel="새 메시지 알림"
              accessibilityState={{ busy: pushBusy !== null }}
              {...{ 'aria-busy': pushBusy !== null ? true : undefined, 'aria-describedby': describedBy.join(' ') || undefined }}
              value={pushOn ?? false}
              onValueChange={setPush}
              disabled={pushDisabled} // 처리 중에는 disabled로 바꾸지 않는다(포커스 유지). 겹친 호출은 setPush가 막는다
              hitSlop={space[1]}
              trackColor={{ false: colors.textMuted, true: colors.primary }}
              thumbColor={colors.background}
              {...{ activeThumbColor: colors.background }}
            />
          </View>
          {pushBusy && (
            <AppText variant="small" color="textMuted">
              {pushBusy === 'on' ? '켜는 중…' : '끄는 중…'}
            </AppText>
          )}
          <AppText nativeID="push-note" variant="small" color="textMuted">
            {PUSH_NOTE}
          </AppText>
          {Platform.OS === 'ios' && (
            <AppText nativeID="push-reason" variant="small" color="textMuted">
              {NATIVE_IOS}
            </AppText>
          )}
          {!connected && (
            <AppText nativeID="push-reason" variant="small" color="textMuted">
              {NOT_CONNECTED}
            </AppText>
          )}
          {iosInstall && (
            <AppText nativeID="push-ios" variant="small" color="textMuted">
              {"아이폰에서는 Safari 공유 버튼 → '홈 화면에 추가'로 연 뒤에 알림을 켤 수 있어요. 기기와 iOS 버전에 따라 알림이 오지 않을 수도 있어요."}
            </AppText>
          )}
          {pushMsg ? (
            <AppText variant="small" color="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
              {pushMsg}
            </AppText>
          ) : (
            pushIsDenied && (
              <AppText nativeID="push-denied" variant="small" color="textMuted">
                {deniedText()}
              </AppText>
            )
          )}
        </Section>

        <Section title="화면">
          <ChipRow options={THEME_PREFS} value={pref} onChange={(p) => p && setPref(p)} labels={THEME_LABELS} accessibilityLabel="화면 모드" />
        </Section>

        <Section title="계정">
          <InfoRow label="이메일" value={email ?? '-'} />
          <InfoRow label="이름" value={profile?.name ?? '-'} />
          <Button label="로그아웃" kind="secondary" onPress={logout} loading={signingOut} disabled={!connected} />
          {signOutError && (
            <AppText variant="small" color="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
              로그아웃하지 못했어요. 연결을 확인하고 다시 해 주세요.
            </AppText>
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}
