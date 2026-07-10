// 서비스 워커 — PWA 설치 조건 충족용 (캐시는 하지 않음)
// 블록체인 dApp 특성상 항상 최신 코드를 서버에서 받아야 하므로
// 오프라인 캐시를 의도적으로 사용하지 않는다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* 네트워크 그대로 통과 */ });
