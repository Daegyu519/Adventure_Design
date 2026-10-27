import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../components/AppText';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { isValidEmail, normalizeOtp, OTP_LENGTH, otpErrorMessage } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/theme';

const CODE_LABEL = `메일로 받은 ${OTP_LENGTH}자리 코드를 적어 주세요`;

// 이메일 → 메일로 온 6자리 코드. 이메일·코드는 상태에만 두고 로그·주소(URL)·저장소에 남기지 않는다.
// 성공하면 SessionProvider가 SIGNED_IN을 받아 게이트가 이 화면을 치운다(직접 이동하지 않는다).
export default function Login() {
  const { colors, space } = useTheme();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const e = email.trim();
    if (!isValidEmail(e)) return setError('이메일 주소를 확인해 주세요');
    if (!supabase) return; // 키가 없으면 게이트가 이 화면을 열지 않는다
    setBusy(true);
    setError(null);
    let err: { status?: number } | null = null;
    try {
      err = (await supabase.auth.signInWithOtp({ email: e, options: { shouldCreateUser: true } })).error;
    } catch {
      err = {};
    }
    setBusy(false);
    if (err) return setError(otpErrorMessage('send', err));
    setEmail(e);
    setCode('');
    setStep('code');
  };

  const verify = async () => {
    const token = normalizeOtp(code);
    if (!token) return setError(`${OTP_LENGTH}자리 숫자를 적어 주세요`);
    if (!supabase) return;
    setBusy(true);
    setError(null);
    let err: { status?: number } | null = null;
    try {
      err = (await supabase.auth.verifyOtp({ email, token, type: 'email' })).error;
    } catch {
      err = {};
    }
    // 성공이면 busy를 그대로 둔다. 곧 화면이 치워지고, 그 사이 한 번 더 눌러 이미 쓴 코드로 오류가 뜨지 않게.
    if (err) {
      setBusy(false);
      setError(otpErrorMessage('verify', err));
    }
  };

  const rewrite = () => {
    setStep('email');
    setCode('');
    setError(null);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space[3], paddingBottom: space[6] }}>
          <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[5] }}>
            <AppText accessibilityRole="header" aria-level={1} variant="title">
              로그인
            </AppText>

            {step === 'email' ? (
              <>
                <AppText color="textMuted">이메일로 {OTP_LENGTH}자리 코드를 보내 드려요. 처음이면 계정이 만들어져요.</AppText>
                <TextField
                  label="이메일"
                  value={email}
                  onChangeText={setEmail}
                  error={error}
                  editable={!busy}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  returnKeyType="send"
                  onSubmitEditing={send}
                />
                <Button label="코드 받기" onPress={send} loading={busy} />
              </>
            ) : (
              <>
                <AppText color="textMuted">{email}(으)로 코드를 보냈어요.</AppText>
                <TextField
                  label={CODE_LABEL}
                  value={code}
                  onChangeText={setCode}
                  error={error}
                  editable={!busy}
                  autoFocus
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={verify}
                />
                <Button label="로그인" onPress={verify} loading={busy} />
                <Button label="이메일 다시 적기" kind="ghost" onPress={rewrite} disabled={busy} />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
