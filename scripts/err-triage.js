// 오류 신고 자동 분류 (매시간 예약 실행)
// 새 신고를 읽어 아는 패턴/새 패턴으로 나누고, 새 패턴이면 운영자 폰으로 즉시 알림.
// 비밀값은 금고 파일에서만 읽는다.
const fs = require('fs');
const ADMIN_KEY = fs.readFileSync('C:/ssabom/appdata/mpc-esc-admin-secret.txt', 'utf8').match(/[0-9a-f]{24,64}/)[0];
const PUB = 'sb_publishable_1Pd6p7r3MRyVQ9vZBABNIg_rv7h71Qh';
const BASE = 'https://idqnxrwrnisxjbovvpli.supabase.co';
const STATE = 'C:/ssabom/appdata/mpc-err-state.json';
const OPERATOR = '0xf07ab48453b4f97cc15966a6f06f815399ea00c1';

// 아는 패턴(처방 있음) — 새로 분류되면 여기 추가해 나간다
const KNOWN = [
  { sig: /invalid project id/i, name: '조회망 설정 전파 지연', rx: '앱 껐다 켜기 안내 (v12부터 공용망 우선이라 신규 발생 없어야 함 — v12 이상에서 또 나오면 새 패턴 취급)' },
  { sig: /user (rejected|denied|disapproved|cancel+ed)|거절/i, name: '서명·연결 거절', rx: '회원이 지갑에서 취소한 것 — 조치 불필요' },
  { sig: /not a participant/i, name: '판매자 아닌 지갑으로 취소 시도', rx: '앱이 "판매자 지갑이 아닙니다"라고 안내함 — 지갑 전환 안내만' },
  { sig: /proposal expired|session.?expired/i, name: '연결 제안 시간 초과', rx: '지갑 승인 늦음 — 다시 연결하면 됨, 조치 불필요' },
  { sig: /insufficient funds|잔액|gas required/i, name: '가스비(POL) 부족', rx: 'POL 충전 안내' },
  { sig: /HTTP 401|unauthorized/i, name: '지갑 노드 일시 오류', rx: '예비 연결 안내 (기존 확립 해법)' },
  { sig: /timeout|network error|failed to fetch|시간.?초과/i, name: '통신 일시 장애', rx: '재시도 안내' },
  { sig: /could not detect network/i, name: '조회망 연결 실패', rx: '재시도 안내, 반복되면 조회망 점검' },
];

async function main() {
  let st = { lastId: 0, seen: {} };
  if (fs.existsSync(STATE)) st = JSON.parse(fs.readFileSync(STATE, 'utf8'));

  const r = await fetch(BASE + '/rest/v1/rpc/esc_err_list', {
    method: 'POST',
    headers: { apikey: PUB, Authorization: 'Bearer ' + PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_key: ADMIN_KEY, p_after: st.lastId }),
  });
  if (!r.ok) throw new Error('목록 조회 실패 HTTP ' + r.status);
  const rows = await r.json();
  if (!rows.length) { console.log('새 신고 없음 (마지막 id ' + st.lastId + ')'); return; }

  const news = [];
  for (const row of rows) {
    st.lastId = Math.max(st.lastId, row.id);
    const hit = KNOWN.find(k => k.sig.test(row.msg || ''));
    // v12 미만에서 나온 invalid project id 는 잔존 세션 — 아는 패턴. v12 이상이면 새 패턴으로 격상
    const stale = hit && hit.name.includes('전파 지연') && String(row.ver) >= '2026101112';
    if (hit && !stale) {
      console.log(`[아는 패턴] #${row.id} v${row.ver} ${hit.name} — ${hit.rx} | ${String(row.msg).slice(0, 60)}`);
      continue;
    }
    // 새 패턴: 정규화 서명으로 중복 묶기
    const sig = String(row.msg || '').toLowerCase().replace(/0x[0-9a-f]+/g, '0x…').replace(/\d+/g, 'N').slice(0, 80);
    st.seen[sig] = (st.seen[sig] || 0) + 1;
    console.log(`[새 패턴] #${row.id} v${row.ver} ${row.env} | ${String(row.msg).slice(0, 90)}`);
    if (st.seen[sig] <= 2) news.push(row); // 같은 패턴 알림은 2회까지만 (알림 폭주 방지)
  }

  if (news.length) {
    const webpush = require('web-push');
    const keyFile = fs.readFileSync('C:/ssabom/appdata/mpc-vapid-keys.txt', 'utf8');
    const pub = [...keyFile.matchAll(/VAPID_PUBLIC=(\S+)/g)].pop()[1];
    const priv = [...keyFile.matchAll(/VAPID_PRIVATE=(\S+)/g)].pop()[1];
    webpush.setVapidDetails('mailto:bag8516@gmail.com', pub, priv);
    const dr = await fetch(BASE + '/functions/v1/esc-push-send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dump: true, key: ADMIN_KEY }),
    });
    const subs = (((await dr.json()).subs) || []).filter(s => s.wallet === OPERATOR);
    const body = news.slice(0, 2).map(n => `v${n.ver} ${String(n.msg).slice(0, 70)}`).join('\n').slice(0, 170);
    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: `🧪 새 오류 패턴 ${news.length}건`, body }),
        );
        sent++;
      } catch (e) { console.error('알림 개별 실패:', e.statusCode || e.message); }
    }
    console.log(sent ? `운영자 알림 발송 (${sent}건)` : '⚠️ 운영자 알림 발송 실패');
  }
  fs.writeFileSync(STATE, JSON.stringify(st));
  console.log(`처리 완료: ${rows.length}건 (새 패턴 알림 대상 ${news.length}건)`);
}

// 재시도는 스크립트 안에서 (새 명령을 만들면 허용 창이 떠서 무인 실행이 멈춘다)
(async () => {
  for (let a = 1; a <= 2; a++) {
    try { await main(); return; }
    catch (e) {
      console.log(`⚠️ 오류 분류 ${a}/2회 실패:`, e.message);
      if (a < 2) await new Promise(r => setTimeout(r, 2 * 60 * 1000));
    }
  }
  console.log('⚠️ 오류 분류 실패: 2회 모두 실패');
  process.exit(1);
})();
