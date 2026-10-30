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
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  // 같은 출처 경로만 연다.
  const url = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const w = wins[0];
      if (w) return w.focus().then(() => ('navigate' in w ? w.navigate(url) : undefined));
      return self.clients.openWindow(url);
    }),
  );
});
