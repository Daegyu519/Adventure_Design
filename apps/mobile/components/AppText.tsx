import { Platform, Text, type TextProps, type TextStyle } from 'react-native';

import { useTheme, type Colors } from '../lib/theme';

export type AppTextProps = TextProps & {
  variant?: 'body' | 'small' | 'title';
  color?: keyof Colors;
  weight?: '400' | '500' | '600' | '700';
};

// MASTER 3장: 한국어는 어절 단위로 줄바꿈(word-break: keep-all). 웹은 CSS, iOS는 hangul-word.
const KEEP_ALL = Platform.OS === 'web' ? ({ wordBreak: 'keep-all' } as TextStyle) : undefined;

// 글자는 이것만 쓴다. Pretendard(굵기별 face는 _layout의 useFonts), 크기·줄 간격은 tokens에서.
export function AppText({ variant = 'body', color = 'text', weight, style, ...rest }: AppTextProps) {
  const { colors, font } = useTheme();
  const size = font[variant];
  return (
    <Text
      lineBreakStrategyIOS="hangul-word"
      {...rest}
      style={[
        {
          color: colors[color],
          fontFamily: font.family,
          fontSize: size,
          lineHeight: size * font.lineHeight,
          fontWeight: weight ?? (variant === 'title' ? '600' : '400'),
        },
        KEEP_ALL,
        style,
      ]}
    />
  );
}
