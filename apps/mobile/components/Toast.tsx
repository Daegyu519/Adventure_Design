import { useEffect } from 'react';
import { Pressable } from 'react-native';

import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';

export const TOAST_MS = 6000; // 읽을 시간. 그래도 놓칠 수 있어 누르면 바로 닫히고, 같은 글을 say로도 읽어 준다.

// 보이는 안내일 뿐이다: 읽어 주기는 호출자가 useAnnounce().say로 한다(여기서 live region을 또 쓰면 두 번 읽힌다). 포커스를 가져가지 않는다.
export function Toast({ message, onHide }: { message: string | null; onHide(): void }) {
  const { colors, radius, space } = useTheme();
  useEffect(() => {
    if (!message) return;
    const id = setTimeout(onHide, TOAST_MS);
    return () => clearTimeout(id);
  }, [message, onHide]);
  if (!message) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${message} 닫기`}
      onPress={onHide}
      style={{
        position: 'absolute',
        left: space[3],
        right: space[3],
        bottom: 96,
        minHeight: 44,
        justifyContent: 'center',
        padding: space[2],
        borderRadius: radius.input,
        backgroundColor: colors.text,
        ...focusRing(colors.primary),
      }}
    >
      <AppText variant="small" style={{ color: colors.background }}>
        {message}
      </AppText>
    </Pressable>
  );
}
