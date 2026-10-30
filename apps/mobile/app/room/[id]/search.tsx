import { useLocalSearchParams, useRouter } from 'expo-router';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '../../../components/AppText';
import { Button } from '../../../components/Button';
import { IconButton } from '../../../components/IconButton';
import { TextField } from '../../../components/TextField';
import { NETWORK_MESSAGE } from '../../../lib/dbErrors';
import { formatStamp } from '../../../lib/messages';
import { fetchRoom } from '../../../lib/rooms';
import { highlight, searchMessages } from '../../../lib/search';
import { useSession } from '../../../lib/session';
import { supabase } from '../../../lib/supabase';
import { focusRing, useTheme } from '../../../lib/theme';
import type { Tables } from '../../../lib/types/db';

export default function RoomSearch() {
  const { colors, space } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId: me } = useSession();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState(''); // 마지막으로 검색한 말(강조에 쓴다. 입력 중인 글과 따로)
  const [results, setResults] = useState<Tables<'messages'>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const seq = useRef(0);

  useEffect(() => {
    if (!id || !supabase) return;
    let alive = true;
    fetchRoom(id).then((r) => alive && setNames(new Map(r.members.map((m) => [m.user_id, m.name]))), () => {}); // 이름을 못 받으면 "상대"로 보인다
    return () => {
      alive = false;
    };
  }, [id]);

  const submit = async () => {
    const query = q.trim();
    if (!query || !id || busy) return;
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const rows = await searchMessages(id, query);
      if (mine !== seq.current) return;
      setTerm(query);
      setResults(rows);
    } catch {
      if (mine === seq.current) setError(NETWORK_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  const who = (sender: string) => (sender === me ? '나' : (names.get(sender) ?? '상대'));
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ width: '100%', maxWidth: 560, alignSelf: 'center', flex: 1, padding: space[3], gap: space[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>
          <IconButton icon={ArrowLeft} label="뒤로" onPress={goBack} />
          <AppText accessibilityRole="header" aria-level={1} variant="title">
            대화 검색
          </AppText>
        </View>
        <TextField
          label="대화 검색어"
          value={q}
          onChangeText={setQ}
          returnKeyType="search"
          onSubmitEditing={() => void submit()}
          autoCorrect={false}
          autoCapitalize="none"
        />
        <Button label="검색" onPress={() => void submit()} loading={busy} />
        {error && (
          <AppText accessibilityRole="alert" variant="small" color="danger">
            {error}
          </AppText>
        )}
        {results && !error && (
          <AppText accessibilityLiveRegion="polite" aria-live="polite" color="textMuted">
            {results.length ? `${results.length}개 찾았어요` : '찾는 말이 없어요'}
          </AppText>
        )}
        <ScrollView keyboardShouldPersistTaps="handled">
          {(results ?? []).map((item) => {
            const stamp = formatStamp(item.created_at);
            return (
              <Pressable
                key={item.id}
                onPress={() => router.navigate({ pathname: '/room/[id]', params: { id: id!, at: String(item.id), k: String(Date.now()) } })}
                accessibilityRole="button"
                accessibilityLabel={`${who(item.sender_id)}, ${stamp}: ${item.text}`}
                accessibilityHint="누르면 대화방에서 이 메시지로 이동"
                style={({ pressed }) => ({ minHeight: 44, paddingVertical: space[2], gap: space[0], borderBottomWidth: 1, borderBottomColor: colors.border, opacity: pressed ? 0.8 : 1, ...focusRing(colors.primary) })}
              >
                <AppText variant="small" color="textMuted">
                  {who(item.sender_id)} · {stamp}
                </AppText>
                <AppText>
                  {highlight(item.text, term).map((p, i) => (
                    <AppText key={i} weight={p.match ? '700' : '400'} color={p.match ? 'primary' : 'text'} style={p.match ? { textDecorationLine: 'underline' } : undefined}>
                      {p.text}
                    </AppText>
                  ))}
                </AppText>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
