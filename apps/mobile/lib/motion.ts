import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export const MOTION_MS = 200;

// 시스템 '동작 줄이기'. RN-web은 AccessibilityInfo가 prefers-reduced-motion을 읽는다.
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduced(v)).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
