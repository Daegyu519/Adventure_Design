import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../components/AppText';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { validateName } from '../lib/auth';
import { useSession } from '../lib/session';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/theme';

// 처음 로그인한 사람이 이름을 정한다(profiles 한 행). 저장하면 프로필을 다시 읽고, 게이트가 탭으로 넘긴다.
// 프로필을 읽는 것 자체가 실패했으면(profileFailed) 이름 입력 대신 안내와 다시 불러오기를 보여 준다.
// 이미 이름이 있는 사람이 오프라인이라는 이유로 새 이름을 정하게 하지 않으려는 것이다.
export default function Profile() {
  const { colors, space } = useTheme();
  const { userId, refreshProfile, profileFailed } = useSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setBusy(true); // 버튼이 로딩 중에는 눌리지 않아 따로 막지 않는다
    await refreshProfile();
    setBusy(false);
  };

  const save = async () => {
    if (busy) return;
    const checked = validateName(name);
    if (!checked.ok) return setError(checked.message);
    if (!supabase || !userId) return;
    setBusy(true);
    setError(null);
    let code: string | undefined;
    let failed = false;
    try {
      const res = await supabase.from('profiles').insert({ id: userId, name: checked.value });
      failed = res.error !== null;
      code = res.error?.code;
    } catch {
      failed = true;
    }
    // 23505(기본 키 충돌)는 이미 프로필이 있다는 뜻이다(처음 읽기가 실패했던 경우). 오류 대신 다시 읽어 넘긴다.
    if (failed && code !== '23505') {
      setBusy(false);
      return setError('저장하지 못했어요. 잠시 뒤 다시 해 주세요.');
    }
    await refreshProfile(); // 읽히면 게이트가 이 화면을 치운다
    setBusy(false);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space[3], paddingBottom: space[6] }}>
          <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[5] }}>
            {profileFailed ? (
              <>
                <AppText accessibilityRole="header" aria-level={1} variant="title">
                  프로필을 불러오지 못했어요
                </AppText>
                <AppText color="textMuted">연결이 불안정할 수도 있어요. 잠시 뒤 다시 해 보세요.</AppText>
                <Button label="다시 불러오기" onPress={retry} loading={busy} />
              </>
            ) : (
              <>
                <AppText accessibilityRole="header" aria-level={1} variant="title">
                  이름을 정해 주세요
                </AppText>
                <TextField
                  label="이름"
                  hint="대화 상대에게 보이는 이름이에요. 20자까지 쓸 수 있어요."
                  value={name}
                  onChangeText={setName}
                  error={error}
                  editable={!busy}
                  autoComplete="name"
                  textContentType="name"
                  returnKeyType="done"
                  onSubmitEditing={save}
                />
                <Button label="시작하기" onPress={save} loading={busy} />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
