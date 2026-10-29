import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, useColorScheme, type ViewStyle } from 'react-native';

import tokens from './tokens.json';

export type Colors = typeof tokens.light;
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'theme.v1'; // 웹에서는 localStorage 'theme.v1'
const PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];
const isPref = (v: unknown): v is ThemePref => PREFS.includes(v as ThemePref);

// MASTER 3장 대체 글꼴. 웹에서 Pretendard를 못 불러와도 한글이 시스템 글꼴로 나온다.
// 네이티브는 expo-font에 등록한 이름('Pretendard')만 쓴다(목록을 주면 못 찾는다).
export const FONT_STACK_WEB = 'Pretendard, -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
const FONT = { ...tokens.font, family: Platform.select({ web: FONT_STACK_WEB, default: tokens.font.family }) };

export function resolveScheme(pref: ThemePref, system: 'light' | 'dark' | null | undefined): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return system === 'dark' ? 'dark' : 'light';
}

type Pref = { pref: ThemePref; setPref(p: ThemePref): void };
const Ctx = createContext<Pref | null>(null);

// 고른 테마를 저장소(theme.v1)에서 읽고 쓴다. 읽기 전·읽기 실패·알 수 없는 값은 'system'.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>('system');
  const chosen = useRef(false); // 읽는 동안 사용자가 골랐다면 늦게 온 읽기 결과가 덮어쓰지 않는다

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((v) => {
        if (!chosen.current && isPref(v)) setPrefState(v);
      })
      .catch(() => {}); // 저장소를 못 읽으면(웹 시크릿 모드 등) 시스템 설정을 따른다
  }, []);

  const setPref = useCallback((p: ThemePref) => {
    chosen.current = true;
    setPrefState(p);
    AsyncStorage.setItem(KEY, p).catch(() => {}); // 저장이 막혀도 이번 실행에서는 바로 바뀐다
  }, []);

  const value = useMemo(() => ({ pref, setPref }), [pref, setPref]);
  return createElement(Ctx.Provider, { value }, children);
}

export function useThemePref(): Pref {
  const v = useContext(Ctx);
  if (!v) throw new Error('useThemePref는 ThemeProvider 안에서만 쓴다');
  return v;
}

// 색·간격·글꼴은 전부 tokens.json(design-system/tone-chat/MASTER.md)에서 온다. 화면에 색을 직접 쓰지 않는다.
// Provider 밖(테스트 등)에서는 시스템 설정을 따른다.
export function useTheme() {
  const system = useColorScheme();
  const scheme = resolveScheme(useContext(Ctx)?.pref ?? 'system', system);
  const colors: Colors = scheme === 'dark' ? tokens.dark : tokens.light;
  return { colors, scheme, radius: tokens.radius, space: tokens.space, font: FONT };
}

// 웹 키보드 포커스 링(MASTER 8장: primary 2px). 브라우저가 키보드 포커스에만 그리는 기본 링의 색·굵기만 바꾼다.
// 네이티브에서는 outline이 늘 그려지므로 빈 객체를 돌려준다.
export function focusRing(color: string): ViewStyle {
  return Platform.OS === 'web' ? { outlineColor: color, outlineWidth: 2, outlineOffset: 2 } : {};
}
