// 웹 푸시 서비스 워커. 본문은 JSON {title, body, url}(엔진 T-28b). 일반 JS(번들 안 거침).
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    // JSON이 아니면 기본 문구로 보여 준다.
  }
  event.waitUntil(
    self.registration.showNotification(d.title || '새 메시지', {
      body: d.body || '',
      data: { url: typeof d.url === 'string' ? d.url : '/' },
      icon: '/icon.png',
      lang: 'ko',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  // 대화방 경로(앱의 tapUrl과 같은 허용 목록)만 연다. 그 밖(`/\evil.com`, `//x`, 절대 주소)은 홈으로.
  const url = typeof raw === 'string' && /^\/room\/[A-Za-z0-9-]+$/.test(raw) ? raw : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const w = wins[0];
      if (w) return w.focus().then(() => ('navigate' in w ? w.navigate(url) : undefined));
      return self.clients.openWindow(url);
    }),
  );
});
