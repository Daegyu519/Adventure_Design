import { useEffect, useRef, useState } from 'react';
import { Platform, TextInput, View } from 'react-native';

import { useAnnounce } from '../lib/announce';
import { EngineError, engine } from '../lib/engine';
import type { Msg } from '../lib/messages';
import { focusRing, useTheme } from '../lib/theme';
import { VENT_MAX, validateVent, ventErrorMessage } from '../lib/vent';
import { AppText } from './AppText';
import { firstLine } from './Bubble';
import { Button } from './Button';
import { Sheet } from './Sheet';

// 털어놓기: 받은 메시지에 대한 속마음을 엔진에만 남긴다. 글은 이 컴포넌트의 state에만 있고(저장·로그 없음) 보내거나 닫으면 사라진다.
// 상대에게 알려 주거나 무언가 바뀐다고 약속하지 않는다. 엔진 응답(ack)은 여기서 보이지 않고 onDone에만 넘긴다.
function VentForm(p: { roomId: string; message: Msg; onClose(): void; onDone(ack: string): void }) {
  const { colors, radius, space, font } = useTheme();
  const { say } = useAnnounce(); // iOS만 쓴다
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  // 오류 글자는 role=alert(웹·안드로이드). iOS만 한 번 읽어 준다(두 번 읽힘 방지, TextField와 같다).
  useEffect(() => {
    if (error && Platform.OS === 'ios') say(error);
  }, [error, say]);

  async function submit() {
    if (busy) return;
    const v = validateVent(text);
    if (!v.ok) return setError(v.message);
    setError(null);
    setBusy(true);
    try {
      const r = await engine.feedback({ room_id: p.roomId, message_id: p.message.id, text: v.value });
      if (!alive.current) return;
      p.onClose();
      p.onDone(r.ack);
    } catch (e) {
      if (!alive.current) return;
      setBusy(false);
      setError(ventErrorMessage(e instanceof EngineError ? e.status : 0));
    }
  }

  const n = [...text].length;
  return (
    <>
      <AppText variant="small" color="textMuted">
        상대에게는 보이지 않아요. 누가 남겼는지도 드러나지 않아요.
      </AppText>
      <View style={{ backgroundColor: colors.surface, borderRadius: radius.input, padding: space[2] }}>
        <AppText variant="small" numberOfLines={2}>
          {firstLine(p.message)}
        </AppText>
      </View>
      <TextInput
        nativeID="vent-input"
        accessibilityLabel="털어놓을 내용"
        aria-invalid={!!error}
        value={text}
        onChangeText={(t) => {
          setText(t);
          if (error) setError(null);
        }}
        placeholder="어떤 점이 마음에 걸렸는지 편하게 적어 주세요"
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.primary}
        multiline
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        style={{ minHeight: 96, textAlignVertical: 'top', padding: space[2], borderWidth: 1, borderColor: error ? colors.danger : colors.textMuted, borderRadius: radius.input, backgroundColor: colors.surface, color: colors.text, fontFamily: font.family, fontSize: font.body, ...focusRing(colors.primary) }}
      />
      <AppText variant="small" color={n > VENT_MAX ? 'danger' : 'textMuted'} accessibilityLabel={`${n}자, 최대 ${VENT_MAX}자`}>
        {n}/{VENT_MAX}
      </AppText>
      {error ? (
        <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="small" color="danger">
          {error}
        </AppText>
      ) : null}
      <Button label="남기기" loading={busy} onPress={submit} />
    </>
  );
}

// Sheet(Modal)의 자식은 닫히면 사라지므로 글·오류가 저절로 비워진다(초안을 남기지 않는다).
export function VentSheet(p: { visible: boolean; roomId: string; message: Msg | null; onClose(): void; onDone(ack: string): void }) {
  return (
    <Sheet initialFocus="vent-input" visible={p.visible && p.message !== null} onClose={p.onClose} title="AI에게만 털어놓기">
      {p.message ? <VentForm roomId={p.roomId} message={p.message} onClose={p.onClose} onDone={p.onDone} /> : null}
    </Sheet>
  );
}
