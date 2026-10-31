import { Redirect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { ChipRow } from '../../components/ChipRow';
import { TextField } from '../../components/TextField';
import { useAnnounce } from '../../lib/announce';
import { focusNode } from '../../lib/focus';
import { GROUP_MAX, MAKE_FAILED, normalizeInviteCode, RELATIONS, rpcText, shareInviteCode, validateGroupTitle, type Relation } from '../../lib/invite';
import { useSession } from '../../lib/session';
import { supabase } from '../../lib/supabase';
import { focusRing, useTheme } from '../../lib/theme';

const TABS = ['direct', 'group', 'join'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { direct: '1:1 초대', group: '그룹 만들기', join: '코드 입력' };

// 방 id는 서버가 준 uuid다. 경로에는 그대로 넣되 타입 라우트가 아직 모르는 경로(Task 7)라 Href로 단언한다.
const roomHref = (id: string) => `/room/${id}` as Href;

// 이름 · 관계 · 코드는 상태에만 두고 로그·주소(URL)·저장소에 남기지 않는다.
export default function NewRoom() {
  const { colors, space, radius } = useTheme();
  const router = useRouter();
  const { status, profileStatus } = useSession();
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => t === tabParam) ?? 'direct');
  const [relation, setRelation] = useState<Relation>('친구');
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const { say, region } = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 만든 초대 코드. 그룹은 방이 먼저 생기므로 방 id도 같이 들고 있다(코드만 실패했을 때 방을 또 만들지 않으려고).
  const [notice, setNotice] = useState<string | null>(null); // 보내기·복사 결과
  const codeRef = useRef<ComponentRef<typeof View>>(null); // 코드를 만들면 포커스를 여기로 옮긴다
  const formRef = useRef<ComponentRef<typeof View>>(null); // '다른 코드 만들기' 뒤 포커스가 body로 떨어지지 않게
  const [formFocus, setFormFocus] = useState(0);
  const [made, setMade] = useState<{ code: string | null; roomId: string | null } | null>(null);

  // 화면이 결과로 바뀌면 누른 버튼이 사라져 포커스가 body로 떨어진다(WCAG 2.4.3). 코드 블록으로 옮기고, 읽어 주는 쪽에도 한 번 알린다(4.1.3).
  const madeCode = made?.code ?? null;
  const madeIsGroup = made?.roomId != null;
  useEffect(() => {
    if (!madeCode) return;
    focusNode(codeRef);
    say(`초대 코드를 만들었어요. ${madeIsGroup ? '72시간 안에 쓸 수 있어요' : '72시간 안에 한 번 쓸 수 있어요'}`);
  }, [madeCode, madeIsGroup, say]);
  useEffect(() => {
    if (formFocus > 0) focusNode(formRef);
  }, [formFocus]);

  // 게이트가 앱 화면 묶음만 열어 주지만 이 경로는 주소로도 열 수 있다. 로그인·프로필이 없으면 되돌린다.
  if (supabase && (status !== 'in' || profileStatus !== 'ok')) return <Redirect href="/" />;

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const pickTab = (t: Tab | null) => {
    if (!t) return;
    setTab(t);
    setError(null);
    setMade(null);
    setNotice(null); // 다른 갈래의 코드·방이 남아 이 갈래 화면을 가리지 않게
  };

  // 요청이 도는 동안(busy) 다시 눌러도 한 번만 보낸다. 키가 없으면 안내만 보여 주고 아무것도 하지 않는다.
  const run = async (job: () => Promise<void>) => {
    if (busy || !supabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await job();
    } finally {
      setBusy(false);
    }
  };

  const makeDirect = () =>
    run(async () => {
      const res = await rpcText(supabase!.rpc('create_invite', { relation }), MAKE_FAILED);
      if (res.ok) setMade({ code: res.data, roomId: null });
      else setError(res.message);
    });

  const makeInvite = (roomId: string) =>
    run(async () => {
      const res = await rpcText(supabase!.rpc('create_invite', { room: roomId, relation }), MAKE_FAILED);
      setMade({ code: res.ok ? res.data : null, roomId });
      if (!res.ok) setError(res.message);
    });

  const makeGroup = () => {
    const checked = validateGroupTitle(title);
    if (!checked.ok) return setError(checked.message);
    return run(async () => {
      const room = await rpcText(supabase!.rpc('create_group', { title: checked.value, relation }), '방을 만들지 못했어요. 잠시 뒤 다시 해 주세요.');
      if (!room.ok) return setError(room.message);
      const res = await rpcText(supabase!.rpc('create_invite', { room: room.data, relation }), MAKE_FAILED);
      setMade({ code: res.ok ? res.data : null, roomId: room.data });
      if (!res.ok) setError(res.message);
    });
  };

  const join = () => {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return setError('코드는 영문과 숫자 8자예요. 다시 확인해 주세요');
    return run(async () => {
      const res = await rpcText(supabase!.rpc('accept_invite', { code: normalized }), '코드를 확인해 주세요');
      if (res.ok) router.replace(roomHref(res.data));
      else setError(res.message);
    });
  };

  const send = async () => {
    if (!made?.code) return;
    setNotice(null);
    setNotice(await shareInviteCode(made.code));
  };

  const group = made?.roomId != null;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {region}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space[3], paddingBottom: space[6] }}>
          <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', gap: space[5] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
              <Pressable
                onPress={goBack}
                accessibilityRole="button"
                accessibilityLabel="뒤로"
                hitSlop={space[1]}
                style={({ pressed }) => ({ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1, ...focusRing(colors.primary) })}
              >
                <ArrowLeft color={colors.text} size={24} />
              </Pressable>
              <AppText accessibilityRole="header" aria-level={1} variant="title">
                대화 시작하기
              </AppText>
            </View>

            {!supabase && <AppText color="textMuted">Supabase 키가 없어요. `.env`를 채우면 만들 수 있어요</AppText>}

            <ChipRow options={TABS} value={tab} onChange={pickTab} labels={TAB_LABELS} accessibilityLabel="초대 방법" />

            {tab === 'join' ? (
              <>
                <TextField
                  label="초대 코드"
                  hint="받은 코드를 붙여 넣어도 돼요. 공백이나 -는 알아서 지워요."
                  value={code}
                  onChangeText={(t) => {
                    setCode(t);
                    setError(null);
                  }}
                  error={error}
                  editable={!busy}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="off"
                  returnKeyType="go"
                  onSubmitEditing={join}
                />
                <Button label="참여하기" onPress={join} loading={busy} />
              </>
            ) : made ? (
              <>
                {made.code ? (
                  <View
                    ref={codeRef}
                    accessible
                    role="group"
                    accessibilityLabel={`초대 코드 ${[...made.code].join(' ')}`}
                    {...({ tabIndex: -1 } as object)}
                    style={{ gap: space[2], padding: space[3], borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: 'center' }}
                  >
                    <AppText variant="small" color="textMuted">
                      초대 코드
                    </AppText>
                    <AppText selectable variant="title" weight="600" style={{ letterSpacing: 4 }}>
                      {made.code}
                    </AppText>
                  </View>
                ) : null}
                {error ? (
                  <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="small" color="danger">
                    {error}
                  </AppText>
                ) : null}
                {made.code ? (
                  <>
                    <AppText color="textMuted">
                      72시간 안에 {group ? '쓸 수 있어요' : '한 번 쓸 수 있어요'}
                      {group ? `\n최대 ${GROUP_MAX}명까지 들어올 수 있어요` : ''}
                    </AppText>
                    <Button label="보내기" onPress={send} kind={group ? 'secondary' : 'primary'} />
                    {notice ? (
                      <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="small" color="textMuted">
                        {notice}
                      </AppText>
                    ) : null}
                  </>
                ) : (
                  <Button label="코드 다시 만들기" onPress={() => makeInvite(made.roomId!)} loading={busy} />
                )}
                {group ? (
                  <Button label="방으로 가기" onPress={() => router.replace(roomHref(made.roomId!))} />
                ) : (
                  <Button label="다른 코드 만들기" kind="ghost" onPress={() => {
                      setMade(null);
                      setNotice(null);
                      setFormFocus((n) => n + 1);
                    }}
                  />
                )}
              </>
            ) : (
              <View ref={formRef} {...({ tabIndex: -1 } as object)} style={{ gap: space[5] }}>
                {tab === 'group' && <TextField label="방 이름" hint="30자까지 쓸 수 있어요." value={title} onChangeText={setTitle} error={error} editable={!busy} returnKeyType="done" onSubmitEditing={makeGroup} />}
                <View style={{ gap: space[1] }}>
                  <AppText weight="600">관계</AppText>
                  <ChipRow options={RELATIONS} value={relation} onChange={(r) => r && setRelation(r)} accessibilityLabel="관계" />
                </View>
                {tab === 'direct' && error ? (
                  <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="small" color="danger">
                    {error}
                  </AppText>
                ) : null}
                {tab === 'group' ? <Button label="방 만들기" onPress={makeGroup} loading={busy} /> : <Button label="코드 만들기" onPress={makeDirect} loading={busy} />}
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
