import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';

import { AppText } from '../components/AppText';

// 화면 읽기 프로그램에만 보이는 줄(웹·네이티브 공통으로 화면 밖).
const SR_ONLY = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 } as const;

// 한 줄 안내. 웹·안드로이드는 처음부터 있는 polite 영역의 글을 바꾸고, iOS는 accessibilityLiveRegion이 없어 announceForAccessibility를 쓴다
// (안드로이드는 영역만 써서 두 번 읽히지 않게). 같은 말을 또 하면 보이지 않는 글자(U+200B)를 붙였다 뗐다 해서 다시 읽히게 한다.
// 화면 어딘가에 `region`을 한 번 그려야 한다.
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
