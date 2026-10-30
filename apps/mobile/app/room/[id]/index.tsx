import { useIsFocused, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import Info from 'lucide-react-native/icons/info';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, KeyboardAvoidingView, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../../components/AppText';
import { Bubble, firstLine } from '../../../components/Bubble';
import { Composer, type InputHandle } from '../../../components/Composer';
import { MessageActions } from '../../../components/MessageActions';
import { Toast } from '../../../components/Toast';
import { DetailSheet } from '../../../components/DetailSheet';
import { VentSheet } from '../../../components/VentSheet';
import { canVent } from '../../../lib/vent';
import { Button } from '../../../components/Button';
import { IconButton } from '../../../components/IconButton';
import { pickAndSendImage } from '../../../lib/images';
import { activeMentionQuery, extractMentions, insertMention, mentionCandidates } from '../../../lib/mentions';
import { useAnnounce } from '../../../lib/announce';
import { retryFocus as focusUntilHeld } from '../../../lib/focus';
import { useReducedMotion } from '../../../lib/motion';
import { dbErrorMessage, isUnreachable, NETWORK_MESSAGE } from '../../../lib/dbErrors';
import { REACTION_LABELS, shouldMarkRead, summarizeReactions, unreadCount, type Emoji, type Msg } from '../../../lib/messages';
import { fetchRoom, markRead, roomTitle, type Member } from '../../../lib/rooms';
import { useMembers } from '../../../lib/useMembers';
import { useTyping } from '../../../lib/useTyping';
import { useReactions } from '../../../lib/useReactions';
import { useRoomMessages, type SendError } from '../../../lib/useRoomMessages';
import { useSession } from '../../../lib/session';
import { useToneHint } from '../../../lib/useToneHint';
import { logToneEvent } from '../../../lib/toneEvents';
import { supabase } from '../../../lib/supabase';
import { useTheme } from '../../../lib/theme';
import type { Tables } from '../../../lib/types/db';

// 방 정보를 못 받았을 때 줄 문구: 코드가 있는 DB 오류는 고정 문구, 그 밖(연결 끊김 등)은 연결 문구. 서버 글은 내지 않는다.
const loadMessage = (e: unknown) => ((e as { code?: string })?.code ? dbErrorMessage(e as { message: string }, '대화방을 불러오지 못했어요. 다시 시도해 주세요.') : NETWORK_MESSAGE);

// 시작 직후 currentState가 비어(null/unknown) 올 수 있다. 배경·비활성일 때만 "앞이 아님"으로 본다.
const isActive = (s: string | null | undefined) => s !== 'background' && s !== 'inactive';

export default function Room() {
  const { colors, space } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();
  if (!supabase || !userId || !id) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: space[3] }}>
        <AppText color="textMuted">{supabase ? '대화방을 열 수 없어요' : 'Supabase 키가 없어요. `.env`를 채우면 대화가 보여요'}</AppText>
      </SafeAreaView>
    );
  }
  return <RoomBody key={id} id={id} me={userId} />; // 방이 바뀌면 상태를 새로 시작한다
}

function RoomBody({ id, me }: { id: string; me: string }) {
  const { profile } = useSession();
  const { colors, space } = useTheme();
  const router = useRouter();
  const focused = useIsFocused();
  const { messages, hasMore, error, olderError, reload, loadOlder, send } = useRoomMessages(id, me); // error: 첫 페이지 실패 또는 Realtime 끊김
  const [info, setInfo] = useState<{ room: Tables<'rooms'>; members: Member[] } | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [infoTick, setInfoTick] = useState(0);
  const [markTick, setMarkTick] = useState(0);
  const markAttempts = useRef(0);
  const markTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sending = useRef(false);
  const failedRef = useRef(false);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [appActive, setAppActive] = useState(isActive(AppState.currentState));
  const lastRead = useRef<string | null>(null);
  const { say, region } = useAnnounce(); // 웹·안드로이드는 region, iOS는 announceForAccessibility
  const [activeId, setActiveId] = useState<number | null>(null); // 웹 roving tabindex: 탭 순서에 있는 메시지(기본은 가장 새 것)
  const [failedQuotes, setFailedQuotes] = useState<Set<number>>(new Set());
  const [quoteTick, setQuoteTick] = useState(0);
  const jump = useRef<number | null>(null);
  const seen = useRef<number | null>(null);
  const unmounted = useRef(false);
  const inputRef = useRef<InputHandle>(null);
  const listRef = useRef<FlatList<Msg>>(null);
  const retryFocus = useRef(false); // 포커스가 있던 "다시 불러오기" 줄이 사라지면 입력창으로 옮긴다(웹 키보드가 body로 떨어지지 않게)
  const [menuFor, setMenuFor] = useState<Msg | null>(null);
  const [ventFor, setVentFor] = useState<Msg | null>(null);
  const [detailText, setDetailText] = useState<string | null>(null); // 살펴보기 시트: 열 때의 입력창 글(null = 닫힘)
  const [toast, setToast] = useState<string | null>(null);
  const hideToast = useCallback(() => setToast(null), []);
  const [replyTarget, setReplyTarget] = useState<Msg | null>(null);
  const [extra, setExtra] = useState<Map<number, Msg>>(new Map()); // 불러온 범위 밖 원문(인용용). 목록에는 넣지 않는다
  const asked = useRef(new Set<number>());

  useEffect(() => {
    let alive = true;
    fetchRoom(id)
      .then((r) => {
        if (!alive) return;
        lastRead.current ??= r.members.find((m) => m.user_id === me)?.last_read_at ?? null; // 이미 표시한 값이 있으면 덮어쓰지 않는다
        setInfo(r);
        setInfoError(null);
      })
      .catch((e) => alive && setInfoError(loadMessage(e)));
    return () => {
      alive = false;
    };
  }, [id, me, infoTick]);

  const { members, error: membersDown, reload: reloadMembers } = useMembers(id, info?.members);
  const { rows: reactionRows, toggle, error: reactionsDown, reload: reloadReactions } = useReactions(id, useMemo(() => messages.map((x) => x.id), [messages]), me);
  const failed = error || infoError !== null || membersDown || reactionsDown; // 다시 불러오기 줄(Realtime 끊김 포함)
  // 불러오기 실패 줄의 다시 불러오기(끊긴 채널도 새로 연다), 그리고 앞으로 돌아오거나 포커스를 얻을 때 자동 다시 시도.
  const retry = useCallback(() => {
    setInfoTick((t) => t + 1);
    reload();
    reloadMembers();
    reloadReactions();
  }, [reload, reloadMembers, reloadReactions]);
  useEffect(() => {
    failedRef.current = failed;
  }, [failed]);
  useEffect(() => {
    if (failedRef.current && focused && appActive) retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 실패 상태가 바뀔 때가 아니라 focused/appActive가 바뀔 때만
  }, [focused, appActive]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(isActive(s)));
    return () => sub.remove();
  }, []);

  const names = useMemo(() => new Map(info?.members.map((m) => [m.user_id, m.name])), [info]);
  const byId = useMemo(() => new Map(messages.map((x) => [x.id, x])), [messages]);
  const group = info?.room.kind === 'group';
  const nameRecord = useMemo(() => Object.fromEntries(names), [names]);
  const typing = useTyping(id, me, nameRecord);
  const [cursor, setCursor] = useState(0);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined); // 멘션을 넣은 직후 커서 위치
  const query = group ? activeMentionQuery(draft, cursor) : null;
  const candidates = useMemo(() => (query === null ? null : mentionCandidates(info?.members ?? [], me, query)), [query, info, me]);
  const { hint: toneHint, input: toneInput, dismiss: toneDismiss, sent: toneSent } = useToneHint(id, replyTarget?.id ?? null, profile?.tone_hint_on !== false);
  const changeDraft = useCallback((t: string) => {
    setDraft(t);
    setSelection(undefined);
    typing.onDraftChange(t);
    toneInput(t); // 멘션 고르기도 같은 길로 들어온다
  }, [typing, toneInput]);
  // 시트를 닫으면 포커스는 입력창으로(힌트 막대의 버튼은 글이 바뀌면 사라질 수 있어 body로 떨어지지 않게). 시트가 돌려주는 포커스보다 나중에.
  const reducedMotion = useReducedMotion();
  const closeDetail = useCallback(() => {
    setDetailText(null);
    focusUntilHeld(() => (unmounted.current ? null : inputRef.current), { delay: reducedMotion ? 0 : 30 });
  }, [reducedMotion]);
  const title = info ? roomTitle(info.room, info.members, me) : '대화방';

  // 읽음: 앞에 보이고 포커스가 있을 때만, 방에서 가장 새 메시지의 서버 시각으로(앞으로만).
  const newest = messages.length ? messages[messages.length - 1].created_at : null;
  // 방 정보(info)와 무관하다: 방 정보를 못 받아도 읽음은 표시한다. 실패하면 3초 간격으로 최대 3번 다시 시도하고, 포커스·앞뒤 전환 때도 다시 시도한다.
  useEffect(() => {
    if (!shouldMarkRead({ appActive, focused, newest, lastRead: lastRead.current })) return;
    const at = newest!;
    lastRead.current = at; // 같은 값으로 중복 요청하지 않는다. 실패하면 되돌려 다시 시도한다.
    markRead(id, me, at)
      .then(() => {
        markAttempts.current = 0;
      })
      .catch(() => {
        if (lastRead.current === at) lastRead.current = null;
        if (unmounted.current) return;
        if (markAttempts.current < 3) {
          markAttempts.current += 1;
          if (markTimer.current) clearTimeout(markTimer.current);
          markTimer.current = setTimeout(() => setMarkTick((t) => t + 1), 3000);
        }
      });
  }, [appActive, focused, newest, id, me, markTick]);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (markTimer.current) clearTimeout(markTimer.current);
    };
  }, []);

  // 다시 불러오기 줄이 성공으로 사라졌는데 포커스가 body로 떨어졌으면 입력창으로(웹만: 네이티브는 키보드가 올라온다).
  const retryRowShown = failed || olderError;
  useEffect(() => {
    if (retryRowShown || !retryFocus.current) return;
    retryFocus.current = false;
    if (Platform.OS === 'web' && (typeof document === 'undefined' || document.activeElement === document.body || !document.activeElement)) inputRef.current?.focus();
  }, [retryRowShown]);

  // 답장 원문이 불러온 범위 밖이면 한 번만 읽는다. 못 읽으면 인용은 "원래 메시지"로 남는다.
  useEffect(() => {
    if (!supabase) return;
    const c = supabase;
    for (const x of messages) {
      const r = x.reply_to;
      if (r === null || byId.has(r) || asked.current.has(r)) continue;
      asked.current.add(r);
      const fail = () => {
        asked.current.delete(r); // 다시 불러오기로 다시 읽을 수 있게
        if (!unmounted.current) setFailedQuotes((cur) => new Set(cur).add(r));
      };
      void Promise.resolve(c.from('messages').select('*').eq('id', r).single()).then(({ data, error: e }) => {
        if (e || !data) return fail();
        if (!unmounted.current) setExtra((cur) => new Map(cur).set(r, data));
      }, fail);
    }
  }, [messages, byId, quoteTick]);
  const retryQuote = useCallback((r: number) => {
    setFailedQuotes((cur) => {
      const n = new Set(cur);
      n.delete(r);
      return n;
    });
    setQuoteTick((t) => t + 1);
  }, []);

  // 새 메시지 알림은 말풍선마다 읽지 않고 상대가 보낸 가장 새 것 한 줄만 정중하게(polite) 알린다.
  useEffect(() => {
    if (!messages.length) return;
    const top = messages[messages.length - 1];
    if (seen.current !== null && top.id > seen.current && top.sender_id !== me) {
      say(`${names.get(top.sender_id) ?? '상대'}: ${top.text || '사진'}`);
    }
    seen.current = top.id;
  }, [messages, me, names, say]);

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending.current) return; // 보내는 중에는 다시 보내지 않는다(되돌린 글이 이중 전송되지 않게)
    sending.current = true;
    setSendError(null);
    setDraft(''); // 먼저 비운다. 실패하면 되돌린다.
    typing.stop();
    toneSent(); // 힌트가 떠 있어도 보내기는 즉시. await 없음
    const mentions = group ? extractMentions(text, info?.members ?? [], me) : [];
    try {
      await send({ text, ...(replyTarget ? { reply_to: replyTarget.id } : {}), ...(mentions.length ? { mentions } : {}) });
      setReplyTarget(null);
    } catch (e) {
      const err = e as SendError;
      setDraft((cur) => (cur ? `${text}\n${cur}` : text));
      setSendError(isUnreachable(err.status) || err.status === undefined ? NETWORK_MESSAGE : dbErrorMessage(err, '보내지 못했어요. 다시 보내 주세요.'));
    } finally {
      sending.current = false;
    }
  }, [draft, send, replyTarget, typing, toneSent, group, info, me]);

  const photoBusy = useRef(false);
  const [photoSending, setPhotoSending] = useState(false);
  const errCount = useRef(0);
  const fail = useCallback((t: string) => setSendError(t + (errCount.current++ % 2 ? '\u200b' : '')), []); // 같은 문구가 연달아도 다시 읽히도록
  const pickImage = useCallback(async () => {
    if (photoBusy.current) return; // 보내는 중 두 번 눌러도 한 번만
    photoBusy.current = true; // 고르는 동안의 중복 누름만 막는다. 버튼이 busy가 되는 것은 사진을 고른 뒤(onStart)
    setSendError(null);
    try {
      const r = await pickAndSendImage(id, send, () => {
        setPhotoSending(true);
        say('사진 보내는 중');
      });
      if (unmounted.current) return;
      if (r === 'sent') say('사진 보냄');
      else if (r === 'unsupported') fail('이 형식의 사진은 보낼 수 없어요');
      else if (r === 'toolarge') fail('사진이 너무 커요 (5MB 이하)');
      else if (r === 'failed') fail('사진을 보내지 못했어요');
    } finally {
      photoBusy.current = false;
      if (!unmounted.current) {
        setPhotoSending(false);
        // 웹: 파일 선택창이 닫히면(취소 포함) 포커스가 body로 떨어지지 않게 입력창으로
        if (Platform.OS === 'web') inputRef.current?.focus();
      }
    }
  }, [id, send, say, fail]);

  const data = useMemo(() => [...messages].reverse(), [messages]); // inverted: 새 것부터

  const toggleReaction = useCallback(
    (messageId: number, emoji: Emoji) => {
      setSendError(null);
      const had = reactionRows.find((r) => r.message_id === messageId && r.user_id === me)?.emoji;
      toggle(messageId, emoji).then(
        () => say(had === emoji ? `공감 취소: ${REACTION_LABELS[emoji]}` : `공감: ${REACTION_LABELS[emoji]}`),
        () => setSendError('공감하지 못했어요. 다시 시도해 주세요.'),
      );
    },
    [toggle, reactionRows, me, say],
  );

  // 웹: 메시지 본문으로 포커스를 옮긴다(가상화된 목록이라 그려진 뒤에).
  const focusItem = useCallback((id: number) => {
    setActiveId(id); // 로빙 tabindex: 포커스를 받은 메시지가 탭 순서에 있어야 Tab이 거기서 이어진다
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    // Modal이 닫히며 자기 포커스 복원을 끝낸 뒤에 옮긴다: 목표에 닿을 때까지 몇 번 다시 시도(고정 지연 한 번에 기대지 않는다).
    let tries = 0;
    const step = () => {
      const el = document.getElementById(`msg-body-${id}`);
      el?.focus();
      if (document.activeElement !== el && ++tries < 10) setTimeout(step, 50);
    };
    setTimeout(step, 30);
  }, []);
  const scrollTo = useCallback((index: number) => {
    try {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    } catch {
      // 아직 그려지지 않은 칸은 onScrollToIndexFailed가 이어서 처리한다
    }
  }, []);

  // ↑(더 오래된)·↓: 활성 메시지를 옮기고 스크롤·포커스. 맨 위에서 ↑는 이전 메시지를 더 불러온다.
  const navigate = useCallback(
    (fromId: number, dir: -1 | 1) => {
      const i = data.findIndex((x) => x.id === fromId);
      const j = i - dir; // data는 새 것부터
      if (i < 0 || j < 0) return;
      if (j >= data.length) return void (hasMore && !olderError && void loadOlder());
      setActiveId(data[j].id);
      scrollTo(j);
      focusItem(data[j].id);
    },
    [data, hasMore, olderError, loadOlder, scrollTo, focusItem],
  );

  // 인용 누르기: 불러온 범위 안이면 이동, 밖이면 더 불러오며 찾고, 끝까지 없으면 알린다.
  const stepJump = useCallback(() => {
    const target = jump.current;
    if (target === null) return;
    const index = data.findIndex((x) => x.id === target);
    if (index >= 0) {
      jump.current = null;
      setActiveId(target);
      scrollTo(index);
      focusItem(target);
      return say('원문으로 이동했어요');
    }
    if (hasMore && !olderError) return void loadOlder();
    jump.current = null;
    say(olderError ? '이전 메시지를 불러오지 못했어요' : '원래 메시지는 더 이전 대화에 있어요');
  }, [data, hasMore, olderError, loadOlder, scrollTo, focusItem, say]);
  useEffect(() => stepJump(), [stepJump]);
  const goTo = useCallback((replyTo: number) => {
    jump.current = replyTo;
    stepJump();
  }, [stepJump]);

  // 방 안 검색에서 온 이동(?at=<메시지 id>): 인용 이동과 같은 길(불러오며 찾기 → 활성·포커스·안내)을 쓴다. k는 같은 결과를 다시 눌러도 다시 움직이게 하는 값.
  const { at, k } = useLocalSearchParams<{ at?: string; k?: string }>();
  const loaded = messages.length > 0;
  useEffect(() => {
    const target = Number(at);
    if (at && loaded && Number.isInteger(target)) goTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 주소의 at·k가 바뀔 때(와 처음 불러왔을 때)만
  }, [at, k, loaded]);

  const quotedName = (x: Msg) => {
    const q = x.reply_to === null ? null : (byId.get(x.reply_to) ?? extra.get(x.reply_to));
    return q ? (q.sender_id === me ? '나' : names.get(q.sender_id)) : undefined;
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1], paddingHorizontal: space[1], borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <IconButton icon={ArrowLeft} label="뒤로" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <AppText accessibilityRole="header" aria-level={1} variant="title" numberOfLines={1} style={{ flex: 1 }}>
          {title}
        </AppText>
        <IconButton icon={Info} label="방 정보" onPress={() => router.push(`/room/${id}/info` as Href)} />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {failed && (
          <View style={{ padding: space[3], gap: space[1], alignItems: 'flex-start' }}>
            <AppText accessibilityRole="alert" variant="small" color="danger">
              {infoError ?? NETWORK_MESSAGE}
            </AppText>
            <Button
              label="다시 불러오기"
              kind="secondary"
              onPress={() => {
                retryFocus.current = true;
                retry();
              }}
            />
          </View>
        )}
        {region}
        <FlatList
          ref={listRef}
          inverted
          data={data}
          keyExtractor={(m) => String(m.id)}
          onEndReached={() => hasMore && !olderError && void loadOlder()}
          onEndReachedThreshold={0.5}
          onScrollToIndexFailed={(i) => {
            listRef.current?.scrollToOffset({ offset: i.averageItemLength * i.index, animated: true });
            setTimeout(() => !unmounted.current && listRef.current?.scrollToIndex({ index: i.index, viewPosition: 0.5, animated: true }), 300);
          }}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            olderError ? (
              <View style={{ paddingVertical: space[2], gap: space[1], alignItems: 'center' }}>
                <AppText accessibilityRole="alert" variant="small" color="danger">
                  이전 메시지를 불러오지 못했어요
                </AppText>
                <Button
                  label="이전 메시지 다시 불러오기"
                  kind="secondary"
                  onPress={() => {
                    retryFocus.current = true;
                    void loadOlder();
                  }}
                />
              </View>
            ) : undefined
          }
          contentContainerStyle={{ paddingHorizontal: space[3], paddingVertical: space[2] }}
          renderItem={({ item, index }) => {
            const older = data[index + 1]; // 화면에서 바로 위(더 오래된) 메시지
            const mine = item.sender_id === me;
            const first = older?.sender_id !== item.sender_id;
            return (
              <View style={{ marginTop: older && !first ? space[0] : older ? space[2] : 0 }}>
                <Bubble
                  message={item}
                  mine={mine}
                  speaker={mine ? '나' : (names.get(item.sender_id) ?? '상대')}
                  mentionNames={group ? (info?.members ?? []).map((x) => x.name) : undefined}
                  mentionsMe={item.mentions.includes(me)}
                  unreadText={unreadCount(item, members) > 0 ? (group ? `안 읽은 사람 ${unreadCount(item, members)}명` : '상대가 안 읽음') : ''}
                  active={item.id === (activeId ?? data[0]?.id)}
                  onNavigate={(dir) => navigate(item.id, dir)}
                  quoteFailed={item.reply_to !== null && failedQuotes.has(item.reply_to)}
                  onQuoteRetry={() => item.reply_to !== null && retryQuote(item.reply_to)}
                  senderName={group && !mine && first ? names.get(item.sender_id) : undefined}
                  quoted={item.reply_to === null ? null : (byId.get(item.reply_to) ?? extra.get(item.reply_to) ?? null)}
                  quotedName={quotedName(item)}
                  reactions={summarizeReactions(reactionRows, item.id, me)}
                  unread={unreadCount(item, members)}
                  onLongPress={() => setMenuFor(item)}
                  onMore={() => setMenuFor(item)}
                  onQuotePress={() => item.reply_to !== null && goTo(item.reply_to)}
                  onReactionPress={(e) => toggleReaction(item.id, e)}
                />
              </View>
            );
          }}
        />
        <Composer
          value={draft}
          onChangeText={changeDraft}
          onPickImage={() => void pickImage()}
          photoBusy={photoSending}
          typingLabel={typing.label}
          mentionCandidates={candidates}
          onSelectionChange={(c) => {
            setCursor(c);
            setSelection(undefined);
          }}
          selection={selection}
          onBlur={typing.stop}
          say={say}
          hint={toneHint}
          onDismissHint={toneDismiss}
          onOpenHintDetail={() => draft.trim() !== '' && setDetailText(draft.trim())}
          onSelectMention={(name) => {
            const r = insertMention(draft, cursor, name);
            changeDraft(r.text);
            setCursor(r.cursor);
            setSelection({ start: r.cursor, end: r.cursor });
          }}
          onSend={() => void onSend()}
          inputRef={inputRef}
          replyTo={replyTarget ? { id: replyTarget.id, name: replyTarget.sender_id === me ? '나' : (names.get(replyTarget.sender_id) ?? '상대'), text: firstLine(replyTarget) } : null}
          onCancelReply={() => {
            setReplyTarget(null);
            say('답장 취소됨');
          }}
        />
        {sendError && (
          <AppText accessibilityRole="alert" variant="small" color="danger" style={{ paddingHorizontal: space[3], paddingBottom: space[1] }}>
            {sendError}
          </AppText>
        )}
      </KeyboardAvoidingView>
      <MessageActions
        senderName={menuFor ? (menuFor.sender_id === me ? '나' : names.get(menuFor.sender_id)) : undefined}
        visible={menuFor !== null}
        message={menuFor}
        mine={menuFor?.sender_id === me}
        myReaction={(reactionRows.find((r) => r.message_id === menuFor?.id && r.user_id === me)?.emoji as Emoji | undefined) ?? null}
        onClose={() => setMenuFor(null)}
        onReply={() => {
          if (menuFor) {
            setReplyTarget(menuFor);
            say(`${names.get(menuFor.sender_id) ?? '상대'}에게 답장`);
          }
          setMenuFor(null);
        }}
        onVent={
          menuFor && canVent(menuFor, me)
            ? () => {
                setVentFor(menuFor);
                setMenuFor(null);
              }
            : undefined
        }
        onReact={(e) => {
          if (menuFor) toggleReaction(menuFor.id, e);
          setMenuFor(null);
        }}
      />
      <VentSheet
        visible={ventFor !== null}
        roomId={id}
        message={ventFor}
        onClose={() => {
          if (ventFor) focusItem(ventFor.id); // 닫으면 포커스는 그 메시지로(body로 떨어지지 않게)
          setVentFor(null);
        }}
        onDone={(ack) => {
          setToast(ack);
          say(ack);
        }}
      />
      <DetailSheet
        visible={detailText !== null}
        roomId={id}
        text={detailText ?? ''}
        hintTitle={toneHint?.title ?? null}
        replyTo={replyTarget?.id ?? null}
        onClose={closeDetail}
        onApply={({ text, choice, topReading, traceId }) => {
          changeDraft(text);
          setCursor(text.length); // 낡은 커서로 멘션 후보가 뜨지 않게 끝으로
          // 입력창 글만 바꾼다(보내지 않는다). 힌트도 새 글로 다시 확인
          if (choice) logToneEvent({ room_id: id, kind: 'option_chosen', choice, top_reading: topReading, signals: { trace_id: traceId } }); // 글은 기록하지 않는다
          closeDetail();
          say('입력창에 적용했어요');
        }}
        onSendAsIs={({ topReading, traceId }) => {
          logToneEvent({ room_id: id, kind: 'option_chosen', choice: 'original', top_reading: topReading, ...(traceId ? { signals: { trace_id: traceId } } : {}) });
          closeDetail();
          say('보냈어요');
          void onSend(); // 평소 보내기 그대로(sent_with_hint는 toneSent가 기록)
        }}
      />
      <Toast message={toast} onHide={hideToast} />
    </SafeAreaView>
  );
}
