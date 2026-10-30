import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, View } from 'react-native';

import { engine, type MirrorAnswerReq, type MirrorAnswerRes } from '../../lib/engine';
import { mirrorErrorCopy, type Card } from '../../lib/mirror';
import { useTheme } from '../../lib/theme';
import { AppText } from '../AppText';

export type CardProps = { card: Card; onDone(): void };

const KIND: Record<Card['kind'], string> = { roleplay: '역할극', receive: '되돌려 받기', predict: '예측 맞히기' };

// 폼이 사라지고 결과가 나타날 때 포커스가 <body>로 떨어지지 않게, 나타나는 순간 이 상자로 옮긴다(WCAG 2.4.3).
export function FocusBox({ children }: { children: ReactNode }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    const node = ref.current as unknown as { focus?: () => void } | null;
    if (Platform.OS === 'web') node?.focus?.();
    else {
      const h = findNodeHandle(ref.current);
      if (h) AccessibilityInfo.setAccessibilityFocus(h);
    }
  }, []);
  return (
    <View ref={ref} accessible={false} {...({ tabIndex: -1 } as object)} style={{ gap: 12, outlineStyle: 'none' } as object}>
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

export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <AppText accessibilityRole="alert" variant="small" color="danger">
      {error}
    </AppText>
  ) : null;
}

/** 답 보내기: 진행 중 중복 전송을 막고, 실패하면 고정 문구만 남기며 폼은 그대로 둔다. */
export function useAnswer(card: Card) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<MirrorAnswerRes | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  async function send(fields: Omit<MirrorAnswerReq, 'card_id'>) {
    if (busy) return null;
    setBusy(true);
    setError(null);
    try {
      const r = await engine.mirrorAnswer({ card_id: card.card_id, ...fields });
      if (alive.current) setRes(r);
      return r;
    } catch (e) {
      if (alive.current) setError(mirrorErrorCopy(e));
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return { busy, error, res, send, reset: () => setRes(null) };
}
