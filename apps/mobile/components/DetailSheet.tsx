import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Platform, ScrollView, useWindowDimensions, View } from 'react-native';

import { DETAIL_TIMEOUT_MS, engine, type DetailRes } from '../lib/engine';
import { focusNode } from '../lib/focus';
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
  hintTitle: string | null; // 입력창 위 힌트 제목. 없으면 기본 제목
  onClose(): void;
  onApply(p: Apply): void;
  onSendAsIs(p: { topReading: string | null; traceId: string | null }): void;
};

// 칩을 바꾼 뒤 읽어 주는 말: 어긋남 한 줄(엔진 글 그대로) + 후보가 있는지
const changed = (r: DetailRes) => `${r.mismatch ? `${r.mismatch}. ` : ''}${r.options.length ? '후보를 바꿨어요' : '후보가 없어요'}`;

// say: 시트 자기 안내 영역(Sheet). 웹 Modal이 열린 동안 화면 쪽 영역은 가려진다.
function DetailBody({ roomId, text, replyTo, hintTitle, say, onApply, onSendAsIs }: Omit<Props, 'visible' | 'onClose'> & { say(t: string): void }) {
  const { colors, radius, space } = useTheme();
  const { height } = useWindowDimensions();
  const [intent, setIntent] = useState<Intent | null>(null);
  const [base, setBase] = useState<DetailRes | null>(null); // 처음 응답: 읽힘 · 이유는 의도가 바뀌어도 그대로
  const [cur, setCur] = useState<DetailRes | null>(null); // 지금 의도의 응답: 후보 · 어긋남 한 줄
  const blank = text.trim() === ''; // 공백뿐이면 엔진이 거절한다: 요청하지 않는다
  const [busy, setBusy] = useState(!blank);
  const [err, setErr] = useState<string | null>(null);
  const [errN, setErrN] = useState(0); // 같은 오류가 다시 나도 다시 읽게(iOS say, 웹·안드로이드는 alert를 새로 붙인다)
  const textRef = useRef<ComponentRef<typeof View>>(null);
  const hadErr = useRef(false); // 다시 해 보기가 성공하면 사라지는 버튼 대신 보낼 문장으로 포커스
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
        say(changed(hit));
        return;
      }
      const c = new AbortController();
      ctrl.current = c;
      setBusy(true);
      say('살펴보는 중'); // 요청마다 한 번(받아 둔 응답을 쓸 때는 없다)
      engine
        .detail({ room_id: roomId, text, ...(replyTo !== null ? { reply_to: replyTo } : {}), ...(next ? { intent: next } : {}) }, { signal: c.signal, timeoutMs: DETAIL_TIMEOUT_MS })
        .then((r) => {
          if (c.signal.aborted) return;
          cache.current.set(next ?? '', r);
          setBase((b) => b ?? r);
          setCur(r);
          setErr(null);
          setBusy(false);
          if (hadErr.current) focusNode(textRef);
          hadErr.current = false;
          say(first.current ? `살펴보기 결과가 나왔어요, ${r.options.length ? `후보 ${r.options.length}개` : '후보가 없어요'}` : changed(r));
          first.current = false;
        })
        .catch((e) => {
          if (c.signal.aborted) return;
          setErr(detailErrorCopy(e));
          setErrN((n) => n + 1);
          hadErr.current = true;
          setBusy(false);
        });
    },
    [roomId, text, replyTo, say],
  );
  useEffect(() => {
    if (!blank) load(null);
    return () => ctrl.current?.abort();
    // 시트를 열 때 한 번만(닫히면 이 컴포넌트가 사라진다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 오류 글자는 role=alert(웹·안드로이드). iOS만 한 번 읽어 준다(두 번 읽힘 방지).
  useEffect(() => {
    if (err && Platform.OS === 'ios') say(err);
  }, [err, errN, say]);

  const pick = (v: Intent | null) => {
    setIntent(v);
    setErr(null);
    load(v);
  };

  const label = (t: string) => (
    <AppText variant="small" color="textMuted" accessibilityRole="header" aria-level={3}>
      {t}
    </AppText>
  );
  const waiting = busy && !err ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
      <ActivityIndicator color={colors.primary} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden />
      <AppText color="textMuted">살펴보는 중…</AppText>
    </View>
  ) : null;
  const failed = err ? (
    <View style={{ gap: space[1] }}>
      <AppText key={errN} accessibilityRole="alert" accessibilityLiveRegion="polite" color="danger">
        {err}
      </AppText>
      <Button label="다시 해 보기" kind="secondary" loading={busy} onPress={() => load(intent)} />
    </View>
  ) : null;
  const options = !busy && !err && cur ? cur.options : [];
  const title = hintTitle ?? '이렇게 읽힐 수도 있어요';
  const mismatch = !busy && !err ? cur?.mismatch : null;

  return (
    <>
      <ScrollView style={{ maxHeight: height * 0.6 }} contentContainerStyle={{ gap: space[2] }}>
        <View ref={textRef} nativeID="detail-text" tabIndex={-1} style={{ gap: space[0] }}>
          <AppText accessibilityRole="header" aria-level={3} weight="600">
            {title}
          </AppText>
          {label('보낼 문장')}
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.input, padding: space[2] }}>
            <AppText selectable>{text}</AppText>
          </View>
        </View>
        <View style={{ gap: space[1] }}>
          {label('어떻게 보내고 싶나요? 안 골라도 돼요')}
          <ChipRow options={INTENTS} value={intent} onChange={pick} allowNone accessibilityLabel="어떻게 보내고 싶나요" />
        </View>
        {/* 칩을 바꾸면 바뀌는 것(불러오는 중 · 어긋남 · 후보)은 칩 바로 아래에 둔다 */}
        {waiting}
        {failed}
        {mismatch ? (
          <View style={{ backgroundColor: colors.hintBg, borderRadius: radius.chip, padding: space[2] }}>
            <AppText variant="small" style={{ color: colors.hintText }}>
              {mismatch}
            </AppText>
          </View>
        ) : null}
        {options.length > 0 && (
          <View style={{ gap: space[1] }}>
            {label('이렇게 바꿔 볼 수도 있어요')}
            {options.map((o, i) => (
              <View key={`${o.label}-${i}`} role="group" aria-label={o.label} style={{ gap: space[0], padding: space[2], borderRadius: radius.input, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
                <AppText variant="small" color="textMuted">
                  {o.label}
                </AppText>
                <DiffText original={text} revised={o.text} />
                {o.keep.length > 0 && <AppText variant="small" color="textMuted">{`지킨 것: ${o.keep.join(', ')}`}</AppText>}
                {o.change.length > 0 && <AppText variant="small" color="textMuted">{`바꾼 것: ${o.change.join(', ')}`}</AppText>}
                <Button label="입력창에 적용" onPress={() => cur && onApply({ text: o.text, choice: choiceOf(o.label), topReading: cur.top_reading, traceId: cur.trace_id })} accessibilityLabel={`입력창에 적용: ${o.label}`} />
              </View>
            ))}
          </View>
        )}
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
            <AppText variant="small" color="textMuted">
              {base.footnote}
            </AppText>
          </>
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
      {(say) => (visible ? <DetailBody {...rest} say={say} /> : null)}
    </Sheet>
  );
}
