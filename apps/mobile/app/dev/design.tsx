import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Bubble } from '../../components/Bubble';
import { ChatRow } from '../../components/ChatRow';
import { ChipRow } from '../../components/ChipRow';
import { Composer } from '../../components/Composer';
import { GroupedSection, InfoRow } from '../../components/GroupedList';
import { NavBar } from '../../components/NavBar';
import { useTheme, useThemePref, type ThemePref } from '../../lib/theme';
import { slotFor } from '../../lib/thread';
import type { Msg } from '../../lib/messages';

// 개발 전용 디자인 미리보기(로그인 없이 실제 컴포넌트를 가짜 자료로). ?v=list | room | settings. 제품 빌드에서는 아무것도 그리지 않고 "/"로 돌려보낸다.
const T = (day: number, h: number, m: number) => (day > 30 ? new Date(2026, 9, day, h, m) : new Date(2026, 10, day, h, m)).toISOString();
const msg = (id: number, s: 'me' | 'ji', text: string, day: number, h: number, m: number): Msg =>
  ({ id, room_id: 'r', sender_id: s, text, created_at: T(day, h, m), reply_to: null, image_path: null, mentions: [] }) as unknown as Msg;
const THREAD = [
  msg(1, 'ji', '내일 점심 어디서 먹을까?', 31, 18, 2),
  msg(2, 'me', '학식 어때?', 31, 18, 3),
  msg(3, 'ji', '야 나 오늘 진짜 힘들었다', 1, 14, 14),
  msg(4, 'ji', '발표 망쳐서 교수님한테 엄청 혼났어 ㅠ', 1, 14, 14),
  msg(5, 'me', '헐 무슨 일 있었어?', 1, 14, 15),
  msg(6, 'me', '괜찮아? 전화할래?', 1, 14, 15),
  msg(7, 'ji', '아니야 그냥 좀 쉬고 싶어', 1, 14, 16),
];

function Room() {
  const { colors, space } = useTheme();
  const [draft, setDraft] = useState('그래서?');
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <NavBar title="지은" subtitle="1:1" onBack={() => {}} onMore={() => {}} />
      <View style={{ flex: 1, justifyContent: 'flex-end', paddingHorizontal: space[2] }}>
        {THREAD.map((m, i) => {
          const slot = slotFor(m, THREAD[i - 1], THREAD[i + 1]);
          const mine = m.sender_id === 'me';
          return (
            <View key={m.id} style={{ marginTop: i === 0 ? 0 : slot.first ? space[1] : 3 }}>
              {slot.dateBefore ? (
                <View style={{ alignSelf: 'center', marginVertical: space[1], paddingVertical: 4, paddingHorizontal: space[2], borderRadius: 999, backgroundColor: colors.surface }}>
                  <AppText color="textMuted" weight="500" style={{ fontSize: 12, lineHeight: 16 }}>{slot.dateBefore}</AppText>
                </View>
              ) : null}
              <Bubble
                message={m}
                mine={mine}
                speaker={mine ? '나' : '지은'}
                senderName={!mine && slot.first ? '지은' : undefined}
                showAvatar={!mine && slot.first}
                tail={slot.last}
                showTime={slot.showTime}
                reactions={[]}
                unread={mine && i >= 4 ? 1 : 0}
                unreadText=""
                active={i === THREAD.length - 1}
                onNavigate={() => {}}
                onLongPress={() => {}}
                onMore={() => {}}
                onReactionPress={() => {}}
              />
            </View>
          );
        })}
      </View>
      <Composer
        value={draft}
        onChangeText={setDraft}
        onSend={() => {}}
        onPickImage={() => {}}
        replyTo={null}
        onCancelReply={() => {}}
        hint={{ title: '짧은 답이 무심하게 느껴질 수도 있어요' } as never}
        onOpenHintDetail={() => {}}
        onDismissHint={() => {}}
      />
    </SafeAreaView>
  );
}

function List() {
  const { colors, space } = useTheme();
  const rows: [string, string, string, number][] = [
    ['지은', '나 오늘 발표 망쳐서 교수님한테 엄청 혼났어', '오후 2:14', 2],
    ['팀 프로젝트 (5)', '민수: 회의 시간 내일 10시로 옮겨도 될까요?', '오후 1:02', 5],
    ['엄마', '반찬 보냈어 냉장고에 넣어 둬', '오전 9:40', 0],
    ['동아리 선배', '이번 주 회비 얼마였지?', '어제', 0],
    ['현우', 'ㅋㅋㅋ 그 짤 봤어?', '어제', 0],
    ['스터디', '자료는 금요일까지 올려 주세요', '10월 30일', 0],
  ];
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingHorizontal: space[3], paddingTop: space[0] }}>
        <AppText accessibilityRole="header" aria-level={1} variant="large">대화</AppText>
      </View>
      {rows.map(([t, p, time, u]) => (
        <ChatRow key={t} title={t} preview={p} time={time} unread={u} muted={t === '엄마'} accessibilityLabel={t} onPress={() => {}} />
      ))}
    </SafeAreaView>
  );
}

function Settings() {
  const { space, grouped } = useTheme();
  const { pref, setPref } = useThemePref();
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: grouped.screen }}>
      <ScrollView contentContainerStyle={{ paddingVertical: space[1], gap: space[3] }}>
        <AppText accessibilityRole="header" aria-level={1} variant="large" style={{ paddingHorizontal: space[3] + space[0] }}>설정</AppText>
        <GroupedSection title="힌트">
          <Toggle label="보내기 전 말투 힌트" />
        </GroupedSection>
        <GroupedSection title="알림">
          <Toggle label="새 메시지 알림" />
          <AppText variant="small" color="textMuted" style={{ paddingBottom: space[1] }}>켜면 새 메시지가 올 때 알려 줄 수도 있어요.</AppText>
        </GroupedSection>
        <GroupedSection title="화면">
          <View style={{ paddingVertical: space[0] }}>
            <ChipRow segmented options={['system', 'light', 'dark'] as const} value={pref} onChange={(p) => p && setPref(p as ThemePref)} labels={{ system: '시스템', light: '밝게', dark: '어둡게' }} accessibilityLabel="화면 모드" />
          </View>
        </GroupedSection>
        <GroupedSection title="계정">
          <InfoRow label="이메일" value="me@example.com" />
          <InfoRow label="이름" value="홍길동" />
        </GroupedSection>
      </ScrollView>
    </SafeAreaView>
  );
}

function Toggle({ label }: { label: string }) {
  const { colors, space } = useTheme();
  const [on, setOn] = useState(true);
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3] }}>
      <AppText>{label}</AppText>
      <Switch accessibilityLabel={label} value={on} onValueChange={setOn} trackColor={{ false: colors.textMuted, true: colors.primary }} thumbColor={colors.background} {...{ activeThumbColor: colors.background }} />
    </View>
  );
}

export default function DesignPreview() {
  const { v } = useLocalSearchParams<{ v?: string }>();
  if (!__DEV__) return <Redirect href="/" />;
  return v === 'room' ? <Room /> : v === 'settings' ? <Settings /> : <List />;
}
