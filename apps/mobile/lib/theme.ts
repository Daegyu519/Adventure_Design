import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, useColorScheme, type TextStyle, type ViewStyle } from 'react-native';

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
  // iOS 묶음 목록: 라이트는 회색 바탕 + 흰 칸, 다크는 검은 바탕 + 어두운 회색 칸. 탭 바는 iOS 막대색(불투명).
  const grouped = scheme === 'dark' ? { screen: colors.background, cell: colors.surface } : { screen: colors.surface, cell: colors.background };
  return { colors, scheme, radius: tokens.radius, space: tokens.space, font: FONT, grouped, bar: colors.bar, fx: fxFor(colors, scheme) };
}

// OOPS 글로우("bloom"): 종이색 면 아래로 따뜻하게 번지는 그림자와 같은 계열의 그라디언트. 색은 토큰에서만, 투명도는 16진 두 자리(#RRGGBBAA)로 붙인다.
// 라이트는 번짐 대신 옅은 중립 그림자만(어두운 면 위에 따뜻한 번짐이 얼룩져 보인다). RN 0.88 boxShadow·backgroundImage 문자열은 네이티브·웹이 같다.
export function fxFor(c: Colors, scheme: 'light' | 'dark') {
  const dark = scheme === 'dark';
  return {
    bloom: dark ? `4px 6px 0 ${c.glowLight}8C, 9px 12px 14px ${c.glowSoft}73, 16px 20px 30px ${c.glowDeep}59` : `0 8px 24px ${c.text}33`, // 힌트 카드·결과 알림
    soft: dark ? `3px 5px 12px ${c.glowSoft}73` : `0 3px 10px ${c.text}26`, // 주 버튼·보내기·배지·켜진 스위치
    chip: dark ? `2px 3px 0 ${c.glowLight}73, 5px 7px 12px ${c.glowDeep}59` : `0 2px 8px ${c.text}26`, // 종류 알약
    bar: (dir: 'to right' | 'to bottom' = 'to right') => (dark ? `linear-gradient(${dir}, ${c.primary} 0%, ${c.glowLight} 55%, ${c.glowSoft} 100%)` : `linear-gradient(${dir}, ${c.glowSoft} 0%, ${c.accent} 100%)`),
    temp: `linear-gradient(to right, ${c.glowSoft} 0%, ${c.glowLight} 30%, ${c.coolMid} 65%, ${c.cool} 100%)`, // 말의 온도 막대: 따뜻함 → 차가움
    glowText: (dark ? { textShadowColor: `${c.glowSoft}73`, textShadowOffset: { width: 3, height: 4 }, textShadowRadius: 14 } : {}) as TextStyle, // 큰 숫자 번짐
  };
}

// 웹 키보드 포커스 링(MASTER 8장: primary 2px). 브라우저가 키보드 포커스에만 그리는 기본 링의 색·굵기만 바꾼다.
// 네이티브에서는 outline이 늘 그려지므로 빈 객체를 돌려준다.
export function focusRing(color: string): ViewStyle {
  return Platform.OS === 'web' ? { outlineColor: color, outlineWidth: 2, outlineOffset: 2 } : {};
}
