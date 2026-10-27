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
export default function Profile() {
  const { colors, space } = useTheme();
  const { userId, refreshProfile } = useSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
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
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
