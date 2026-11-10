import { Platform, Text, type TextProps, type TextStyle } from 'react-native';

import { useTheme, type Colors } from '../lib/theme';

export type AppTextProps = TextProps & {
  variant?: 'body' | 'small' | 'title' | 'large';
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
          // large = 큰 제목(32/38, 굵게). 큰 글자는 자간을 좁히고 본문은 0(MASTER 3장). Pretendard Black(900) 파일이 없어 700까지만 쓴다
          lineHeight: variant === 'large' ? 38 : size * font.lineHeight,
          letterSpacing: variant === 'large' ? -0.5 : variant === 'title' ? -0.2 : 0,
          fontWeight: weight ?? (variant === 'large' ? '700' : variant === 'title' ? '600' : '400'),
        },
        KEEP_ALL,
        style,
      ]}
    />
  );
}
