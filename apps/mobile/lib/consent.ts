import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

// 동의 문구를 바꾸면 이 숫자를 올린다. 옛 버전으로 동의한 사람에게 다시 묻는다.
export const CONSENT_VERSION = 1;
const KEY = 'consent'; // 웹에서는 localStorage 'consent'

export async function loadConsent(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY)) === String(CONSENT_VERSION);
  } catch {
    return false; // 저장소를 못 읽으면(웹 시크릿 모드 등) 동의 화면을 보여 준다
  }
}

// 게이트(_layout)가 구독하는 메모리 상태. null = 아직 저장소를 읽는 중.
let current: boolean | null = null;
const listeners = new Set<() => void>();
function set(v: boolean) {
  current = v;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export async function saveConsent(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, String(CONSENT_VERSION));
  } catch {
    // 저장이 막혀도 사용자는 방금 동의했다. 이번 실행은 넘기고 다음 실행에 다시 묻는다.
  }
  set(true);
}

export function useConsented(): boolean | null {
  useEffect(() => {
    void loadConsent().then(set);
  }, []);
  return useSyncExternalStore(subscribe, () => current);
}
