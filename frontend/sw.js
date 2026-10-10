// 서비스 워커 — PWA 설치 조건 충족 + 푸시 알림 수신 (캐시는 하지 않음)
// 블록체인 dApp 특성상 항상 최신 코드를 서버에서 받아야 하므로
// 오프라인 캐시를 의도적으로 사용하지 않는다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* 네트워크 그대로 통과 */ });

// 서버가 보낸 알림을 화면에 띄운다 (구매자 입금 / 판매 완료 / 반환 필요)
self.addEventListener('push', (e) => {
  let d = { title: 'MPC 에스크로', body: '새 소식이 있습니다.' };
  try { if (e.data) d = e.data.json(); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'MPC 에스크로', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'mpc-escrow',
    renotify: true,
  }));
});

// 알림을 누르면 앱을 연다 (이미 열려 있으면 그 창으로)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.indexOf('mpc-escrow') !== -1 && 'focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
