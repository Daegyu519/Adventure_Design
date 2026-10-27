import { Platform, useColorScheme, type ViewStyle } from 'react-native';

import tokens from './tokens.json';

export type Colors = typeof tokens.light;

// 색·간격·글꼴은 전부 tokens.json(design-system/tone-chat/MASTER.md)에서 온다. 화면에 색을 직접 쓰지 않는다.
export function useTheme() {
  const scheme = useColorScheme();
  const colors: Colors = scheme === 'dark' ? tokens.dark : tokens.light;
  return { colors, radius: tokens.radius, space: tokens.space, font: tokens.font };
}

// 웹 키보드 포커스 링(MASTER 8장: primary 2px). 브라우저가 키보드 포커스에만 그리는 기본 링의 색·굵기만 바꾼다.
// 네이티브에서는 outline이 늘 그려지므로 빈 객체를 돌려준다.
export function focusRing(color: string): ViewStyle {
  return Platform.OS === 'web' ? { outlineColor: color, outlineWidth: 2, outlineOffset: 2 } : {};
}
