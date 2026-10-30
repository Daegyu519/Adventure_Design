import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, Platform, ScrollView, Share, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../../components/AppText';
import { Button } from '../../../components/Button';
import { IconButton } from '../../../components/IconButton';
import { dbErrorMessage, NETWORK_MESSAGE } from '../../../lib/dbErrors';
import { createGroupInvite, GROUP_MAX } from '../../../lib/invite';
import { fetchRoom, roomTitle, setMuted, type Member } from '../../../lib/rooms';
import { useSession } from '../../../lib/session';
import { supabase } from '../../../lib/supabase';
import { useTheme } from '../../../lib/theme';
import type { Tables } from '../../../lib/types/db';

const loadMessage = (e: unknown) => ((e as { code?: string })?.code ? dbErrorMessage(e as { message: string }, '방 정보를 불러오지 못했어요. 다시 시도해 주세요.') : NETWORK_MESSAGE);

export default function RoomInfo() {
  const { colors, space, radius } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId: me } = useSession();
  const [data, setData] = useState<{ room: Tables<'rooms'>; members: Member[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [muted, setMutedState] = useState(false);
  const [muteError, setMuteError] = useState(false);
  const muting = useRef(false);
  const [code, setCode] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<ComponentRef<typeof View>>(null);
  const refocus = useRef(false);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    fetchRoom(id)
      .then((r) => {
        if (!alive) return;
        setData(r);
        setMutedState(r.members.find((m) => m.user_id === me)?.muted ?? false);
        setLoadError(null);
        // 다시 불러오기 줄이 사라지면 포커스가 body로 떨어지므로 제목으로 옮긴다
        if (refocus.current && Platform.OS === 'web') (titleRef.current as unknown as { focus?: () => void } | null)?.focus?.();
        refocus.current = false;
      })
      .catch((e) => alive && setLoadError(loadMessage(e)));
    return () => {
      alive = false;
    };
  }, [id, me, tick]);

  const toggleMute = useCallback(
    async (next: boolean) => {
      if (!id || !me || muting.current) return;
      muting.current = true;
      setMuteError(false);
      setMutedState(next);
      try {
        await setMuted(id, me, next);
        AccessibilityInfo.announceForAccessibility(next ? '이 방 알림을 껐어요' : '이 방 알림을 켰어요');
      } catch {
        setMutedState(!next);
        setMuteError(true);
      } finally {
        muting.current = false;
      }
    },
    [id, me],
  );

  const makeInvite = async () => {
    if (busy || !supabase || !data) return;
    setBusy(true);
    setInviteError(null);
    setNotice(null);
    const res = await createGroupInvite(supabase.rpc('create_invite', { room: data.room.id, relation: data.room.relation }));
    setBusy(false);
    if (res.ok) {
      setCode(res.code);
      AccessibilityInfo.announceForAccessibility('초대 코드를 만들었어요. 72시간 안에 쓸 수 있어요');
    } else setInviteError(res.message);
  };

  const sendCode = async () => {
    if (!code) return;
    const message = `초대 코드: ${code}`;
    setNotice(null);
    try {
      if (Platform.OS !== 'web') await Share.share({ message });
      else if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') await navigator.share({ text: message });
      else {
        await navigator.clipboard.writeText(code);
        setNotice('복사했어요');
      }
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      setNotice('복사하지 못했을 수도 있어요. 위의 코드를 눌러 직접 복사해 주세요.');
    }
  };

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const group = data?.room.kind === 'group';
  const title = data && me ? roomTitle(data.room, data.members, me) : '방 정보';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space[3], paddingBottom: space[6] }}>
        <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[5] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
            <IconButton icon={ArrowLeft} label="뒤로" onPress={goBack} />
            <View ref={titleRef} {...({ tabIndex: -1 } as object)} style={{ flex: 1 }}>
              <AppText accessibilityRole="header" aria-level={1} variant="title" numberOfLines={1}>
                {title}
              </AppText>
            </View>
          </View>

          {!supabase || !id || !me ? <AppText color="textMuted">방 정보를 열 수 없어요</AppText> : null}

          {loadError && (
            <View style={{ gap: space[1], alignItems: 'flex-start' }}>
              <AppText accessibilityRole="alert" variant="small" color="danger">
                {loadError}
              </AppText>
              <Button
                label="다시 불러오기"
                kind="secondary"
                onPress={() => {
                  refocus.current = true;
                  setTick((t) => t + 1);
                }}
              />
            </View>
          )}

          {data && (
            <>
              <View style={{ gap: space[0] }}>
                <AppText color="textMuted">관계: {data.room.relation}</AppText>
                {group && <AppText color="textMuted">{`${data.members.length}/${GROUP_MAX}명`}</AppText>}
              </View>

              <View style={{ gap: space[1] }}>
                <AppText accessibilityRole="header" aria-level={2} weight="600">
                  멤버
                </AppText>
                {data.members.map((m) => (
                  <View key={m.user_id} style={{ minHeight: 44, justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: colors.border }}>
                    <AppText>{m.user_id === me ? `${m.name} (나)` : m.name}</AppText>
                  </View>
                ))}
              </View>

              <View style={{ gap: space[1] }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                  <AppText style={{ flex: 1 }}>이 방 알림 끄기</AppText>
                  <Switch
                    accessibilityRole="switch"
                    accessibilityLabel="이 방 알림 끄기"
                    value={muted}
                    onValueChange={(v) => void toggleMute(v)}
                    hitSlop={space[1]}
                    trackColor={{ false: colors.textMuted, true: colors.primary }}
                    thumbColor={colors.background}
                    {...{ activeThumbColor: colors.background }}
                  />
                </View>
                {muteError && (
                  <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="small" color="danger">
                    바꾸지 못했어요. 연결을 확인하고 다시 해 주세요.
                  </AppText>
                )}
              </View>

              <Button label="대화 검색" kind="secondary" onPress={() => router.push(`/room/${id}/search` as Href)} />

              {group && (
                <View style={{ gap: space[2] }}>
                  <Button label="초대 코드 만들기" kind="secondary" onPress={() => void makeInvite()} loading={busy} />
                  {inviteError && (
                    <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="small" color="danger">
                      {inviteError}
                    </AppText>
                  )}
                  {code && (
                    <View accessible role="group" accessibilityLabel={`초대 코드 ${[...code].join(' ')}`} style={{ gap: space[2], padding: space[3], borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' }}>
                      <AppText variant="small" color="textMuted">
                        초대 코드 (72시간 안에 쓸 수 있어요)
                      </AppText>
                      <AppText selectable variant="title" weight="600" style={{ letterSpacing: 4 }}>
                        {code}
                      </AppText>
                    </View>
                  )}
                  {code && <Button label="보내기" onPress={() => void sendCode()} />}
                  {notice && (
                    <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="small" color="textMuted">
                      {notice}
                    </AppText>
                  )}
                </View>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
