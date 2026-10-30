import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, useWindowDimensions, View } from 'react-native';

import { DETAIL_TIMEOUT_MS, engine, type DetailRes } from '../lib/engine';
import { choiceOf, detailErrorCopy, INTENTS, type Intent } from '../lib/intent';
import { useTheme } from '../lib/theme';
import { AppText } from './AppText';
import { Button } from './Button';
import { ChipRow } from './ChipRow';
import { DiffText } from './DiffText';
import { Readings } from './Readings';
import { Sheet } from './Sheet';

// 살펴보기: 입력창 글이 왜 차갑게 읽힐 수 있는지와 고쳐 쓴 후보를 보여 준다. 고르면 입력창 글만 바뀌고 자동으로 보내지 않는다(규칙 6).
// 앱은 어긋남 문구·점수를 만들지 않는다: 엔진이 준 mismatch를 그대로 보여 준다. 실패 문구는 서버 글 대신 고정 문구.
type Apply = { text: string; choice: 'A' | 'B' | null; topReading: string; traceId: string };
type Props = {
  visible: boolean;
  roomId: string;
  text: string;
  replyTo: number | null;
  say(t: string): void; // 화면의 useAnnounce().say
  onClose(): void;
  onApply(p: Apply): void;
  onSendAsIs(p: { topReading: string | null; traceId: string | null }): void;
};

function DetailBody({ roomId, text, replyTo, say, onApply, onSendAsIs }: Omit<Props, 'visible' | 'onClose'>) {
  const { colors, radius, space } = useTheme();
  const { height } = useWindowDimensions();
  const [intent, setIntent] = useState<Intent | null>(null);
  const [base, setBase] = useState<DetailRes | null>(null); // 처음 응답: 읽힘 · 이유는 의도가 바뀌어도 그대로
  const [cur, setCur] = useState<DetailRes | null>(null); // 지금 의도의 응답: 후보 · 어긋남 한 줄
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const cache = useRef(new Map<string, DetailRes>()); // 의도별 응답(칩을 다시 눌러 해제하면 다시 부르지 않는다)
  const first = useRef(true);

  const load = useCallback(
    (next: Intent | null) => {
      ctrl.current?.abort();
      const hit = cache.current.get(next ?? '');
      if (hit) {
        setErr(null);
        setBusy(false);
        setCur(hit);
        say(hit.mismatch ? `${hit.mismatch}. 후보를 바꿨어요` : '후보를 바꿨어요');
        return;
      }
      const c = new AbortController();
      ctrl.current = c;
      setErr(null);
      setBusy(true);
      engine
        .detail({ room_id: roomId, text, ...(replyTo !== null ? { reply_to: replyTo } : {}), ...(next ? { intent: next } : {}) }, { signal: c.signal, timeoutMs: DETAIL_TIMEOUT_MS })
        .then((r) => {
          if (c.signal.aborted) return;
          cache.current.set(next ?? '', r);
          setBase((b) => b ?? r);
          setCur(r);
          setBusy(false);
          say(first.current ? '살펴보기 결과가 나왔어요' : r.mismatch ? `${r.mismatch}. 후보를 바꿨어요` : '후보를 바꿨어요');
          first.current = false;
        })
        .catch((e) => {
          if (c.signal.aborted) return;
          setErr(detailErrorCopy(e));
          setBusy(false);
        });
    },
    [roomId, text, replyTo, say],
  );
  useEffect(() => {
    load(null);
    return () => ctrl.current?.abort();
    // 시트를 열 때 한 번만(닫히면 이 컴포넌트가 사라진다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 오류 글자는 role=alert(웹·안드로이드). iOS만 한 번 읽어 준다(두 번 읽힘 방지).
  useEffect(() => {
    if (err && Platform.OS === 'ios') say(err);
  }, [err, say]);

  const pick = (v: Intent | null) => {
    setIntent(v);
    load(v);
  };

  const label = (t: string) => (
    <AppText variant="small" color="textMuted" accessibilityRole="header" aria-level={3}>
      {t}
    </AppText>
  );
  const waiting = busy ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
      <ActivityIndicator color={colors.primary} />
      <AppText color="textMuted">살펴보는 중…</AppText>
    </View>
  ) : null;
  const failed = !busy && err ? (
    <View style={{ gap: space[1] }}>
      <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" color="danger">
        {err}
      </AppText>
      <Button label="다시 해 보기" kind="secondary" onPress={() => load(intent)} />
    </View>
  ) : null;
  const options = !busy && !err && cur ? cur.options : [];
  const mismatch = !busy && !err ? cur?.mismatch : null;

  return (
    <>
      <ScrollView style={{ maxHeight: height * 0.6 }} contentContainerStyle={{ gap: space[2] }}>
        <View nativeID="detail-text" tabIndex={-1} style={{ gap: space[0] }}>
          {label('보낼 문장')}
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.input, padding: space[2] }}>
            <AppText selectable>{text}</AppText>
          </View>
        </View>
        <View style={{ gap: space[1] }}>
          {label('어떻게 보내고 싶나요? 안 골라도 돼요')}
          <ChipRow options={INTENTS} value={intent} onChange={pick} allowNone accessibilityLabel="어떻게 보내고 싶나요" />
        </View>
        {mismatch ? (
          <View style={{ backgroundColor: colors.hintBg, borderRadius: radius.chip, padding: space[2] }}>
            <AppText variant="small" style={{ color: colors.hintText }}>
              {mismatch}
            </AppText>
          </View>
        ) : null}
        {base ? (
          <>
            <Readings readings={base.readings} />
            {base.alert ? (
              base.why.length > 0 && (
                <View style={{ gap: space[0] }}>
                  {label('왜 그럴 수 있냐면')}
                  {base.why.map((w, i) => (
                    <AppText key={i}>{`· ${w}`}</AppText>
                  ))}
                </View>
              )
            ) : (
              <AppText color="textMuted">크게 걱정할 부분은 없어 보여요</AppText>
            )}
          </>
        ) : null}
        {waiting}
        {failed}
        {options.length > 0 && (
          <View style={{ gap: space[1] }}>
            {label('이렇게 바꿔 볼 수도 있어요')}
            {options.map((o, i) => (
              <View key={`${o.label}-${i}`} style={{ gap: space[0], padding: space[2], borderRadius: radius.input, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
                <AppText variant="small" color="textMuted">
                  {o.label}
                </AppText>
                <DiffText original={text} revised={o.text} />
                {o.keep.length > 0 && (
                  <AppText variant="small" color="textMuted">{`지킨 것: ${o.keep.join(', ')}`}</AppText>
                )}
                {o.change.length > 0 && (
                  <AppText variant="small" color="textMuted">{`바꾼 것: ${o.change.join(', ')}`}</AppText>
                )}
                <Button label="입력창에 적용" onPress={() => cur && onApply({ text: o.text, choice: choiceOf(o.label), topReading: cur.top_reading, traceId: cur.trace_id })} accessibilityLabel={`입력창에 적용: ${o.label}`} />
              </View>
            ))}
          </View>
        )}
        {base ? (
          <AppText variant="small" color="textMuted">
            {base.footnote}
          </AppText>
        ) : null}
      </ScrollView>
      {/* 전송을 막지 않는다: 결과를 기다리는 중에도 누를 수 있다 */}
      <Button label="그대로 보낼게요" kind="secondary" onPress={() => onSendAsIs({ topReading: cur?.top_reading ?? null, traceId: cur?.trace_id ?? null })} />
    </>
  );
}

// Sheet(Modal)의 자식은 닫히면 사라지므로 응답 · 칩 선택이 저절로 비워진다.
export function DetailSheet({ visible, onClose, ...rest }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title="살펴보기" initialFocus="detail-text">
      {visible ? <DetailBody {...rest} /> : null}
    </Sheet>
  );
}
