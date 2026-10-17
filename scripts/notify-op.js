// 운영자 호출: 임의 메시지를 운영자 폰으로 웹푸시 (승인 요청 등)
// 사용: node notify-op.js "제목" "내용"
const fs = require('fs');
const ADMIN_KEY = fs.readFileSync('C:/ssabom/appdata/mpc-esc-admin-secret.txt', 'utf8').match(/[0-9a-f]{24,64}/)[0];
const OPERATOR = '0xf07ab48453b4f97cc15966a6f06f815399ea00c1';
const title = process.argv[2] || '알림';
const body = (process.argv[3] || '').slice(0, 170);

(async () => {
  const webpush = require('web-push');
  const keyFile = fs.readFileSync('C:/ssabom/appdata/mpc-vapid-keys.txt', 'utf8');
  const pub = [...keyFile.matchAll(/VAPID_PUBLIC=(\S+)/g)].pop()[1];
  const priv = [...keyFile.matchAll(/VAPID_PRIVATE=(\S+)/g)].pop()[1];
  webpush.setVapidDetails('mailto:bag8516@gmail.com', pub, priv);
  const r = await fetch('https://idqnxrwrnisxjbovvpli.supabase.co/functions/v1/esc-push-send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dump: true, key: ADMIN_KEY }),
  });
  const subs = (((await r.json()).subs) || []).filter(s => s.wallet === OPERATOR);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body }),
      );
      sent++;
    } catch (e) { console.error('개별 실패:', e.statusCode || e.message); }
  }
  console.log(sent ? `발송 완료 (${sent}건)` : '발송 실패 — 구독 없음');
  if (!sent) {   // 못 보냈는데 정상 종료(0)로 끝나면 호출한 쪽이 '알렸다'고 믿는다. 실패로 끝내고, 못 보낸 알림은 파일에 남겨 status_all 이 보여 준다
    try { fs.appendFileSync('C:/ssabom/appdata/alerts-unsent.log', JSON.stringify({ at: new Date().toISOString(), title, body }) + String.fromCharCode(10)); } catch (_) {}
    process.exitCode = 1;
  }
})().catch(e => { console.log('실패:', e.message); process.exit(1); });
