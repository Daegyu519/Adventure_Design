import { useEffect } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';

import { useAnnounce } from '../lib/announce';
import { focusRing, useTheme } from '../lib/theme';
import { AppText } from './AppText';

type Props = TextInputProps & { label: string; hint?: string; error?: string | null };

// MASTER 5장: surface 바탕, textMuted 테두리 1px, 모서리 22, 글자 16, 높이 48(최소 44).
// 라벨은 늘 보이고(placeholder로 대신하지 않는다), 오류는 입력창 바로 아래에 글자로 적는다(색만으로 알리지 않는다).
export function TextField({ label, hint, error, style, ...rest }: Props) {
  const { colors, radius, space, font } = useTheme();
  const { say, region } = useAnnounce(); // 웹·안드로이드는 이 영역, iOS는 announceForAccessibility

  // 스크린리더는 새로 생긴 오류를 저절로 읽지 않는 경우가 있어 한 번 읽어 준다.
  useEffect(() => {
    if (error) say(error);
  }, [error, say]);

  return (
    <View style={{ gap: space[1] }}>
      {region}
      <AppText weight="600">{label}</AppText>
      {hint ? (
        <AppText variant="small" color="textMuted">
          {hint}
        </AppText>
      ) : null}
      <TextInput
        accessibilityLabel={label}
        aria-invalid={!!error} // react-native-web은 오류 상태를 aria-invalid로 옮기지 않는다
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.primary}
        {...rest}
        style={[
          {
            minHeight: 48,
            paddingHorizontal: space[3],
            paddingVertical: space[2],
            borderWidth: 1,
            borderColor: error ? colors.danger : colors.textMuted,
            borderRadius: radius.input,
            backgroundColor: colors.surface,
            color: colors.text,
            fontFamily: font.family,
            fontSize: font.body,
            ...focusRing(colors.primary),
          },
          style,
        ]}
      />
      {error ? (
        <AppText accessibilityRole="alert" accessibilityLiveRegion="polite" variant="small" color="danger">
          {error}
        </AppText>
      ) : null}
    </View>
  );
}
