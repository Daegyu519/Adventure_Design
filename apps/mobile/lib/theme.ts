import { useColorScheme } from 'react-native';

import tokens from './tokens.json';

export type Colors = typeof tokens.light;

// 색·간격·글꼴은 전부 tokens.json(design-system/tone-chat/MASTER.md)에서 온다. 화면에 색을 직접 쓰지 않는다.
export function useTheme() {
  const scheme = useColorScheme();
  const colors: Colors = scheme === 'dark' ? tokens.dark : tokens.light;
  return { colors, radius: tokens.radius, space: tokens.space, font: tokens.font };
}
