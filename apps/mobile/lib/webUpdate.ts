import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

// 웹 새 버전 알아채기. 배포하면 index.html이 가리키는 번들 이름(해시)이 바뀐다.
// 지금 열린 문서의 번들 이름과 서버의 최신 index.html의 것을 비교해 다르면 새 버전이다(빌드 설정을 건드리지 않는다).
const JS = /\/_expo\/static\/js\/web\/[^"'\s<>]+\.js/g;

/** HTML 안 번들 주소들을 정렬해 하나의 서명으로. 번들이 없으면(개발 서버 등) ''. */
export function signature(html: string): string {
  return [...new Set(html.match(JS) ?? [])].sort().join('|');
}

/** 새로 확인한 서명이 지금 것과 다르고 둘 다 있으면 새 버전. */
export const isNewer = (current: string, latest: string) => current !== '' && latest !== '' && current !== latest;

export const CHECK_EVERY_MS = 5 * 60_000; // 열어 둔 채로도 5분마다 확인
export const AWAY_RELOAD_MS = 60_000; // 이만큼 자리를 비웠다 돌아왔을 때 새 버전이면 알림 없이 바로 새로고침

function currentSignature(): string {
  if (typeof document === 'undefined') return '';
  return signature([...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src') ?? '').join('\n'));
}

async function latestSignature(): Promise<string> {
  const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
  return res.ok ? signature(await res.text()) : '';
}

/**
 * 웹에서 새 버전이 나왔는지 본다. 앱이 다시 보일 때와 5분마다 확인한다.
 * 한 분 넘게 숨었다 돌아왔는데 새 버전이면 바로 새로고침(앱을 다시 연 것과 같다), 아니면 stale만 올려 배너로 알린다.
 * ponytail: 새로고침하면 안 보낸 입력 초안은 사라진다 — 자리를 비운 뒤 돌아온 때와 사용자가 배너를 누를 때만 새로고침한다.
 */
export function useWebUpdate(): { stale: boolean; reload(): void } {
  const [stale, setStale] = useState(false);
  const hiddenAt = useRef<number | null>(null);
  const reload = useCallback(() => {
    if (typeof window !== 'undefined') window.location.reload();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const mine = currentSignature();
    if (!mine) return; // 개발 서버는 번들 이름이 고정이라 건너뛴다
    let alive = true;
    const check = async (away: boolean) => {
      try {
        const latest = await latestSignature();
        if (!alive || !isNewer(mine, latest)) return;
        if (away) reload();
        else setStale(true);
      } catch {
        // 오프라인·서버 오류는 조용히 다음에
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      const away = hiddenAt.current !== null && Date.now() - hiddenAt.current >= AWAY_RELOAD_MS;
      hiddenAt.current = null;
      void check(away);
    };
    document.addEventListener('visibilitychange', onVisibility);
    const id = setInterval(() => document.visibilityState === 'visible' && void check(false), CHECK_EVERY_MS);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(id);
    };
  }, [reload]);

  return { stale, reload };
}
