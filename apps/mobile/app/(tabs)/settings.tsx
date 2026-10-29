// 아이콘은 하나씩 불러온다(묶음 import는 웹 번들이 커진다).
import Check from 'lucide-react-native/icons/check';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { signOutAndClear } from '../../lib/account';
import { useSession } from '../../lib/session';
import { supabase } from '../../lib/supabase';
import { focusRing, useTheme, useThemePref, type ThemePref } from '../../lib/theme';

const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];
const THEME_LABELS: Record<ThemePref, string> = { system: '시스템', light: '밝게', dark: '어둡게' };

// ponytail: Task 5의 ChipRow(components/ChipRow.tsx)가 main에 들어오면 이 칩 줄을 그것으로 바꾼다(T-08이 같은 파일을 만드는 중이라 겹치지 않게 여기에 둠).
function ThemeChips({ value, onChange }: { value: ThemePref; onChange(p: ThemePref): void }) {
  const { colors, radius, space } = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="화면 모드" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[1] }}>
      {THEME_PREFS.map((p) => {
        const checked = p === value;
        const fg = checked ? colors.onPrimary : colors.text;
        return (
          <Pressable
            key={p}
            onPress={() => onChange(p)}
            accessibilityRole="radio"
            accessibilityLabel={THEME_LABELS[p]}
            accessibilityState={{ checked }}
            aria-checked={checked} // react-native-web은 accessibilityState를 aria-*로 옮기지 않는다
            style={({ pressed }) => ({
              minHeight: 44,
              minWidth: 44,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: space[0],
              paddingHorizontal: space[3],
              borderRadius: radius.chip,
              borderWidth: 1,
              backgroundColor: checked ? colors.primary : colors.background,
              borderColor: checked ? colors.primary : colors.border,
              opacity: pressed ? 0.8 : 1,
              ...focusRing(colors.primary),
            })}
          >
            {/* 선택은 색만으로 알리지 않는다: 글자 굵기와 체크 표시도 같이 바뀐다 */}
            {checked && <Check color={fg} size={16} />}
            <AppText color={checked ? 'onPrimary' : 'text'} weight={checked ? '600' : '400'}>
              {THEME_LABELS[p]}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { colors, radius, space } = useTheme();
  return (
    <View style={{ gap: space[1] }}>
      <AppText accessibilityRole="header" variant="small" color="textMuted" weight="600">
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

  const connected = supabase !== null && userId !== null;
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
      <ScrollView contentContainerStyle={{ padding: space[3], gap: space[5] }}>
        <AppText accessibilityRole="header" variant="title">
          설정
        </AppText>

        <Section title="힌트">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            {/* 글자 쪽도 눌러서 켜고 끌 수 있게 해 눌리는 영역을 넓힌다(스위치만 접근성 대상) */}
            <Pressable accessible={false} disabled={!connected} onPress={() => setHint(!hintOn)} style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}>
              <AppText>보내기 전 말투 힌트</AppText>
            </Pressable>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel="보내기 전 말투 힌트"
              value={hintOn}
              onValueChange={setHint}
              disabled={!connected || pending !== null}
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
            <AppText variant="small" color="danger" accessibilityLiveRegion="polite">
              바꾸지 못했어요. 연결을 확인하고 다시 해 주세요.
            </AppText>
          )}
        </Section>

        <Section title="화면">
          <ThemeChips value={pref} onChange={setPref} />
        </Section>

        <Section title="계정">
          <InfoRow label="이메일" value={email ?? '-'} />
          <InfoRow label="이름" value={profile?.name ?? '-'} />
          <Button label="로그아웃" kind="secondary" onPress={logout} loading={signingOut} disabled={!connected} />
          {signOutError && (
            <AppText variant="small" color="danger" accessibilityLiveRegion="polite">
              로그아웃하지 못했어요. 연결을 확인하고 다시 해 주세요.
            </AppText>
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}
