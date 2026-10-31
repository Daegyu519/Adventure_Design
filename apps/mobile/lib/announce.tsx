import { createContext, useCallback, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';

import { AppText } from '../components/AppText';

// 화면 읽기 프로그램에만 보이는 줄(웹·네이티브 공통으로 화면 밖). opacity 0이면 TalkBack이 건너뛸 수 있어 0.01(T-07-live에서 확인).
const SR_ONLY = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0.01 } as const;

// 한 줄 안내. 웹·안드로이드는 처음부터 있는 polite 영역의 글을 바꾸고, iOS는 accessibilityLiveRegion이 없어 announceForAccessibility를 쓴다
// (안드로이드는 영역만 써서 두 번 읽히지 않게). 같은 말을 또 하면 보이지 않는 글자(U+200B)를 붙였다 뗐다 해서 다시 읽히게 한다.
// 화면마다 `region`을 한 번 그려야 한다. 열린 시트(Sheet)는 자기 영역을 따로 가진다(웹 Modal 밖의 화면 영역은 가려진다).
// 열린 시트의 say를 받는 자리: 화면이 Provider로 ref를 주면 보이는 Sheet가 자기 say를 넣고 닫히면 뺀다.
// 화면이 시트가 열린 동안 알릴 것(새 메시지)은 `(slot.current ?? say)(…)`로 시트 영역에 보낸다(웹 Modal 밖 화면 영역은 가려진다).
export const SheetSaySlot = createContext<RefObject<((t: string) => void) | null> | null>(null);

export function useAnnounce(): { say: (t: string) => void; region: ReactElement | null } {
  const [text, setText] = useState('');
  const flips = useRef(new Map<string, number>());
  const say = useCallback((t: string) => {
    if (Platform.OS === 'ios') return void AccessibilityInfo.announceForAccessibility(t);
    const n = (flips.current.get(t) ?? 0) + 1;
    flips.current.set(t, n);
    setText(t + (n % 2 ? '' : '​'));
  }, []);
  const region = useMemo(
    () =>
      Platform.OS === 'ios' ? null : (
        <View accessibilityLiveRegion="polite" aria-live="polite" style={SR_ONLY}>
          <AppText>{text}</AppText>
        </View>
      ),
    [text],
  );
  return { say, region };
}
