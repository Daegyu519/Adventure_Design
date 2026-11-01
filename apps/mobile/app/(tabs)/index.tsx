import { useFocusEffect, useRouter, type Href } from 'expo-router';
import Plus from 'lucide-react-native/icons/plus';
import { useCallback, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { ChatRow } from '../../components/ChatRow';
import { IconButton } from '../../components/IconButton';
import { formatStamp } from '../../lib/messages';
import { freshTopic, watchStatus } from '../../lib/realtime';
import { fetchRoomList, type RoomListItem } from '../../lib/rooms';
import { useSession } from '../../lib/session';
import { supabase } from '../../lib/supabase';
import { useTheme } from '../../lib/theme';

export default function Chats() {
  const { colors, space } = useTheme();
  const router = useRouter();
  const { userId } = useSession();
  const [rooms, setRooms] = useState<RoomListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [gen, setGen] = useState(0); // 다시 불러오기마다 채널도 새로(서버가 닫은 채널은 다시 들어가지 않는다)
  const seq = useRef(0);

  // 화면이 앞에 올 때마다 다시 불러오고, 그동안 새 메시지(RLS가 내 방만 준다)가 오면 다시 불러온다.
  const load = useCallback(() => {
    if (!supabase || !userId) return;
    const n = ++seq.current;
    fetchRoomList(userId)
      .then((r) => n === seq.current && (setRooms(r), setFailed(false)))
      .catch(() => n === seq.current && setFailed(true));
  }, [userId]);

  // Realtime이 끊기면 같은 실패 줄을 보인다(새 메시지가 와도 목록이 안 바뀐다).
  useFocusEffect(
    useCallback(() => {
      if (!supabase) return;
      const c = supabase;
      let alive = true;
      load();
      const ch = c
        .channel(freshTopic(`rooms-list:${gen}`)) // gen이 바뀌면(다시 불러오기) 이 콜백이 바뀌어 채널을 새로 연다
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, load)
        .subscribe((s) => alive && watchStatus(s, 'rooms-list', () => {}, () => setFailed(true)));
      return () => {
        alive = false;
        void c.removeChannel(ch);
      };
    }, [load, gen]),
  );

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <AppText accessibilityRole="header" aria-level={1} variant="large">
        대화
      </AppText>
      <IconButton icon={Plus} label="새 대화" onPress={() => router.push('/rooms/new')} />
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingHorizontal: space[3], paddingTop: space[0] }}>{header}</View>
      {failed && (
        <View style={{ gap: space[1], padding: space[3], alignItems: 'flex-start' }}>
          <AppText accessibilityRole="alert" color="danger">
            대화를 불러오지 못했어요. 연결이 불안정할 수도 있어요.
          </AppText>
          <Button label="다시 불러오기" kind="secondary" onPress={() => setGen((g) => g + 1)} />
        </View>
      )}
      {rooms !== null && rooms.length > 0 ? (
        <FlatList
          data={rooms}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <ChatRow
              title={item.title}
              preview={item.last ? (item.last.isImage ? '사진' : item.last.fileName ? `파일: ${item.last.fileName}` : item.last.text) : '아직 메시지가 없어요'}
              time={item.last ? formatStamp(item.last.created_at) : undefined}
              unread={item.unread}
              muted={item.muted}
              onPress={() => router.push(`/room/${item.id}` as Href)}
              accessibilityLabel={`${item.title}${item.unread ? `, 안 읽은 메시지 ${item.unread}개` : ''}${item.muted ? ', 알림 꺼짐' : ''}${item.last ? `, ${item.last.isImage ? '사진' : item.last.fileName ? `파일: ${item.last.fileName}` : item.last.text}` : ''}`}
            />
          )}
        />
      ) : rooms !== null ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space[3], paddingBottom: space[6] }}>
          <AppText accessibilityRole="header" aria-level={2} weight="600">
            아직 대화가 없어요
          </AppText>
          <AppText color="textMuted" style={{ textAlign: 'center' }}>
            초대 코드를 만들어 보내거나, 받은 코드를 입력해 보세요.
          </AppText>
          <View style={{ gap: space[1], alignItems: 'stretch', alignSelf: 'stretch', maxWidth: 320, width: '100%' }}>
            <Button label="초대 코드 만들기" onPress={() => router.push('/rooms/new?tab=direct')} />
            <Button label="코드 입력" kind="secondary" onPress={() => router.push('/rooms/new?tab=join')} />
          </View>
        </View>
      ) : !supabase ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space[3], paddingBottom: space[6] }}>
          <AppText accessibilityRole="header" aria-level={2} weight="600">
            아직 대화가 없어요
          </AppText>
          <AppText variant="small" color="textMuted" style={{ textAlign: 'center' }}>
            Supabase 키가 없어요. `.env`를 채우면 대화가 보여요
          </AppText>
        </View>
      ) : null}
    </SafeAreaView>
  );
}
