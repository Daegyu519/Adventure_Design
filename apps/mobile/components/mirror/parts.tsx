import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, View } from 'react-native';

import { engine, type MirrorAnswerReq, type MirrorAnswerRes } from '../../lib/engine';
import { isStaleCard, mirrorErrorCopy, type Card } from '../../lib/mirror';
import { useTheme } from '../../lib/theme';
import { AppText } from '../AppText';
import { Button } from '../Button';

export type CardProps = { card: Card; onDone(): void; onRefresh(): void };

const KIND: Record<Card['kind'], string> = { roleplay: '역할극', receive: '되돌려 받기', predict: '예측 맞히기' };

// 폼이 사라지고 결과가 나타날 때 포커스가 <body>로 떨어지지 않게, 나타나는 순간 이 상자로 옮긴다(WCAG 2.4.3).
// label이 있으면 웹은 이름 있는 group(포커스가 오면 이름을 읽는다), 네이티브는 포커스와 함께 한 번 알려 준다.
// 네이티브에서 accessible로 묶으면 안의 읽힘·버튼이 하나로 합쳐져 따로 읽히지 않아서 묶지 않는다.
export function FocusBox({ children, label }: { children: ReactNode; label?: string }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    const node = ref.current as unknown as { focus?: () => void } | null;
    if (Platform.OS === 'web') node?.focus?.();
    else {
      const h = findNodeHandle(ref.current);
      if (h) AccessibilityInfo.setAccessibilityFocus(h);
      if (label) AccessibilityInfo.announceForAccessibility(label);
    }
  }, [label]);
  return (
    <View
      ref={ref}
      accessible={false}
      {...(label ? { role: 'group' as const, accessibilityLabel: label } : {})}
      {...({ tabIndex: -1 } as object)}
      style={{ gap: 12, outlineStyle: 'none' } as object}
    >
      {children}
    </View>
  );
}

export function CardShell({ card, children }: { card: Card; children: ReactNode }) {
  const { colors, radius, space } = useTheme();
  return (
    <View style={{ gap: space[2], padding: space[3], borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
      <View style={{ alignSelf: 'flex-start', paddingVertical: 2, paddingHorizontal: space[2], borderRadius: radius.chip, backgroundColor: colors.mirror }}>
        <AppText accessibilityRole="header" aria-level={2} variant="small" weight="600" color="onMirror">
          {KIND[card.kind]}
        </AppText>
      </View>
      <AppText variant="small" color="textMuted">{`${card.persona} · ${card.relation} · ${card.situation}`}</AppText>
      <View style={{ alignSelf: 'flex-start', maxWidth: '88%', paddingVertical: space[1], paddingHorizontal: space[2], borderRadius: radius.bubble, backgroundColor: colors.bubbleOther }}>
        <AppText selectable color="onBubbleOther">
          {card.message}
        </AppText>
      </View>
      {children}
    </View>
  );
}

export function ErrorLine({ error, stale, onRefresh }: { error: string | null; stale?: boolean; onRefresh?(): void }) {
  if (!error) return null;
  return (
    <>
      <AppText accessibilityRole="alert" variant="small" color="danger">
        {error}
      </AppText>
      {stale && onRefresh ? <Button label="카드 새로 받기" kind="secondary" onPress={onRefresh} /> : null}
    </>
  );
}

/** 못 누르는 이유를 눈에 보이는 글로 알린다(비활성 버튼은 이유를 말해 주지 않는다). */
export function DisabledHint({ show, children }: { show: boolean; children: string }) {
  return show ? (
    <AppText variant="small" color="textMuted">
      {children}
    </AppText>
  ) : null;
}

/** 답 보내기: 진행 중 중복 전송을 막고, 실패하면 고정 문구만 남기며 폼은 그대로 둔다. */
export function useAnswer(card: Card) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [res, setRes] = useState<MirrorAnswerRes | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // StrictMode·fast refresh는 effect를 다시 돌린다
    return () => void (alive.current = false);
  }, []);
  async function send(fields: Omit<MirrorAnswerReq, 'card_id'>) {
    if (busy) return null;
    setBusy(true);
    setError(null);
    setStale(false);
    try {
      const r = await engine.mirrorAnswer({ card_id: card.card_id, ...fields });
      if (alive.current) setRes(r);
      return r;
    } catch (e) {
      if (alive.current) {
        setError(mirrorErrorCopy(e));
        setStale(isStaleCard(e));
      }
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return { busy, error, stale, res, send, reset: () => setRes(null) };
}
