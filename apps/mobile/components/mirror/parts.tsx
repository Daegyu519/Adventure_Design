import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

import { engine, type MirrorAnswerReq, type MirrorAnswerRes } from '../../lib/engine';
import { focusNode } from '../../lib/focus';
import { eunNeun, gapCandidates, isStaleCard, mirrorErrorCopy, type Card } from '../../lib/mirror';
import { useTheme } from '../../lib/theme';
import { AppText } from '../AppText';
import { Avatar } from '../Avatar';
import { Button } from '../Button';

// onDone: 카드를 끝냈을 때 마무리 화면에 쓸 요약(점수가 아니라 한 일). choice·picked는 역할극, gap은 되돌려 받기·예측 맞히기.
export type DoneInfo = { choice?: 'keep' | 'a'; picked?: string; gap?: number | null };
export type CardProps = { card: Card; onDone(info?: DoneInfo): void; onRefresh(): void; say(t: string): void }; // say: 화면의 useAnnounce().say(영역은 화면에 하나)

const CONTEXT_LABEL: Partial<Record<Card['kind'], string>> = { receive: '내가 먼저 한 말', predict: '상대가 먼저 한 말' };
export const KIND: Record<Card['kind'], string> = { roleplay: '역할극', receive: '되돌려 받기', predict: '예측 맞히기' };

// 폼이 사라지고 결과가 나타날 때 포커스가 <body>로 떨어지지 않게, 나타나는 순간 이 상자로 옮긴다(WCAG 2.4.3).
// label이 있으면 웹은 이름 있는 group(포커스가 오면 이름을 읽는다), 네이티브는 포커스와 함께 화면의 say로 한 번 알려 준다.
// 네이티브에서 accessible로 묶으면 안의 읽힘·버튼이 하나로 합쳐져 따로 읽히지 않아서 묶지 않는다.
export function FocusBox({ children, label, say }: { children: ReactNode; label?: string; say?(t: string): void }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    focusNode(ref);
    if (label && Platform.OS !== 'web') say?.(label);
  }, [label, say]);
  return (
    <View
      ref={ref}
      accessible={false}
      {...(label ? { role: 'group' as const, accessibilityLabel: label } : {})}
      {...({ tabIndex: -1 } as object)}
      style={{ flex: 1, gap: 12, justifyContent: 'center', outlineStyle: 'none' } as object}
    >
      {children}
    </View>
  );
}

// 카드 틀: 위에 종류 알약 + 사람, 아래는 호출한 쪽이 채운다(남는 높이는 장면이 가져간다)
export function CardShell({ card, children }: { card: Card; children: ReactNode }) {
  const { colors, radius, space, fx } = useTheme();
  return (
    <View style={{ flex: 1, gap: space[1] + 4, padding: space[2] - 2, borderRadius: radius.card + 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[1], paddingHorizontal: 2, paddingTop: 2 }}>
        <View style={{ paddingVertical: 4, paddingHorizontal: space[2] - 4, borderRadius: radius.chip, backgroundColor: colors.hintBg, boxShadow: fx.chip }}>
          <AppText accessibilityRole="header" aria-level={2} variant="small" weight="700" style={{ color: colors.hintText, fontSize: 12, lineHeight: 18 }}>
            {KIND[card.kind]}
          </AppText>
        </View>
        <AppText variant="small" color="textMuted" numberOfLines={1} style={{ flexShrink: 1 }}>
          <AppText variant="small" weight="600" color="text">
            {card.persona}
          </AppText>
          {` · ${card.relation}`}
        </AppText>
      </View>
      {/* 본문은 남는 높이의 가운데에 모인다: 큰 화면에서도 빈 곳이 위아래로 고르게 나뉜다 */}
      <View style={{ flex: 1, gap: space[1] + 4, justifyContent: 'center' }}>{children}</View>
    </View>
  );
}

// ---- 대화 장면: 카드의 빈 곳을 그 문장이 오가는 작은 채팅으로 채운다 ----
export function SceneMsg({ who, text, focus, name, label }: { who: 'them' | 'me'; text: string; focus?: boolean; name: string; label?: string }) {
  const { colors, space, fx } = useTheme();
  const mine = who === 'me';
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%', gap: 2 }}>
      {label ? (
        <AppText variant="small" weight="500" color="accent" style={{ fontSize: 12, textAlign: mine ? 'right' : 'left', marginLeft: mine ? 0 : 38 }}>
          {label}
        </AppText>
      ) : null}
      <View style={{ flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: space[1] }}>
        {mine ? null : <Avatar name={name} size={30} />}
        <View
          style={{
            flexShrink: 1,
            paddingVertical: 9,
            paddingHorizontal: 13,
            borderRadius: 18,
            borderBottomLeftRadius: mine ? 18 : 6,
            borderBottomRightRadius: mine ? 6 : 18,
            backgroundColor: mine ? colors.primary : colors.bubbleOther,
            ...(focus ? { borderWidth: 1.5, borderColor: colors.accent, boxShadow: fx.soft } : null),
          }}
        >
          <AppText selectable color={mine ? 'onPrimary' : 'onBubbleOther'} weight={focus ? '600' : '400'} style={{ fontSize: 15 }}>
            {text}
          </AppText>
        </View>
      </View>
    </View>
  );
}

const TAIL_HINT = { receive: '이 말을 내가 받았다고 생각해 보세요', roleplay: '' } as const;

/** 답하기 전의 장면. 앞선 말(context)이 있으면 먼저, 카드가 묻는 문장은 테두리로 강조한다. */
export function Scene({ card }: { card: Card }) {
  const { colors, space } = useTheme();
  const label = CONTEXT_LABEL[card.kind];
  const ctx = card.context
    ? (
        <View accessible accessibilityLabel={`${label ?? '앞선 말'}: ${card.context}`}>
          <SceneMsg who={card.kind === 'receive' ? 'me' : 'them'} text={card.context} name={card.persona} label={label} />
        </View>
      )
    : null;
  const predict = card.kind === 'predict';
  return (
    <View style={{ flex: 1, minHeight: 150, maxHeight: 340, gap: space[1], padding: space[2] - 4, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background }}>
      <AppText variant="small" color="textMuted" style={{ textAlign: 'center', fontSize: 12 }}>
        {card.situation}
      </AppText>
      <View style={{ flex: 1, justifyContent: 'flex-end', gap: space[1] }}>
        {ctx}
        <SceneMsg who={predict ? 'me' : 'them'} text={card.message} focus name={card.persona} />
        {card.kind === 'roleplay' ? (
          <View aria-hidden style={{ alignSelf: 'flex-end', paddingVertical: 9, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.borderStrong }}>
            <AppText variant="small" color="textMuted">
              내 답장은…
            </AppText>
          </View>
        ) : (
          <View aria-hidden style={{ alignSelf: 'flex-start', marginLeft: 38, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <AppText variant="small" color="textMuted" style={{ fontSize: 13 }}>
              {predict ? `${eunNeun(card.relation)} 이 말을 어떻게 읽었을까요?` : TAIL_HINT.receive}
            </AppText>
          </View>
        )}
      </View>
    </View>
  );
}

/** 답한 뒤: 장면은 한 줄로 접는다(결과가 한 화면에 들어가게). */
export function Recall({ card }: { card: Card }) {
  const { colors, space } = useTheme();
  const mine = card.kind === 'predict';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1], paddingVertical: space[1], paddingHorizontal: space[2] - 4, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background }}>
      <Avatar name={mine ? '나' : card.persona} size={24} />
      <AppText numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>{`“${card.message}”`}</AppText>
    </View>
  );
}

/** 결과의 온도 막대: 내 칸과, 받는 쪽이 있을 수 있는 칸(엔진은 차이만 준다). */
export function TempBand({ value, gap, meLabel }: { value: number; gap: number; meLabel: string }) {
  const { colors, fx } = useTheme();
  const cand = gapCandidates(value, gap);
  const at = (v: number) => `${((v - 1) / 4) * 100}%` as const;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={`${meLabel} ${value}칸${gap === 0 ? ', 받는 쪽도 같은 칸' : `, 받는 쪽과 ${gap}칸 떨어져 있어요`}`} style={{ height: 78, marginHorizontal: 0 }}>
      <View style={{ position: 'absolute', left: 22, right: 22, top: 0, bottom: 0 }}>
        <View style={{ position: 'absolute', left: 0, right: 0, top: 34, height: 10, borderRadius: 5, backgroundImage: fx.temp, opacity: 0.9 }} />
        {cand.map((v) => (
          <View key={v} style={{ position: 'absolute', left: at(v), width: 100, marginLeft: -50, top: 25, alignItems: 'center' }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderStyle: 'dashed', borderColor: colors.accent, backgroundColor: colors.surface }} />
            <AppText variant="small" weight="600" color="accent" style={{ fontSize: 11, marginTop: 4 }}>
              받는 쪽
            </AppText>
          </View>
        ))}
        <View style={{ position: 'absolute', left: at(value), width: 100, marginLeft: -50, top: 0, alignItems: 'center' }}>
          <AppText variant="small" color="textMuted" style={{ fontSize: 11 }}>
            {meLabel}
          </AppText>
          <View style={{ width: 24, height: 24, marginTop: 4, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', boxShadow: fx.soft }}>
            <AppText weight="700" color="onPrimary" style={{ fontSize: 11, lineHeight: 14 }}>
              {String(value)}
            </AppText>
          </View>
        </View>
      </View>
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
