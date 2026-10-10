// MPC 에스크로 일일 자동 점검 (고정 스크립트 — 예약 작업에서 실행)
// 검사: ① 장부 대조(잠긴 MPC=컨트랙트 잔액) ② 실서버/버전 ③ 현황 통계
// QuickNode 제한: eth_getLogs 1만 블록 → 9,500 청크, 재시도 포함. 실패 시 "측정 실패"로 보고 (0으로 오인 금지)
//
// [중요] 장부 대조는 반드시 "같은 블록" 기준으로 한다.
//   과거 버전은 거래 목록을 스캔 시작 시점(N)에, 잔액을 스캔 종료 시점(20분 뒤)에 읽어서
//   그 사이 새로 등록된 거래만큼 "잔액이 더 많다"는 가짜 불일치가 떴다.
//   현재 방식: 잠긴 금액은 이벤트 로그로 N 시점 계산, 잔액은 (현재 잔액 − N 이후 순입금)으로 N 시점 환산.
const ADMIN_KEY = require('fs').readFileSync('C:/ssabom/appdata/mpc-esc-admin-secret.txt', 'utf8').match(/[0-9a-f]{24,64}/)[0]; // 비밀값은 금고 파일에만
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ⚠️ 줄만 모아 두었다가, 이상이 있으면 운영자 폰으로 푸시 발송 (맨 아래)
const issues = [];
{
  const orig = console.log.bind(console);
  console.log = (...a) => { const s = a.join(' '); if (s.includes('⚠️')) issues.push(s.replace(/⚠️\s*/, '')); orig(...a); };
}

const RPC_MAIN = 'https://polygon-mainnet.infura.io/v3/10e1ce6e2b7d4ee086e80869c85f9da1'; // 전용 노드 (2026-10)
const RPC_FALLBACK = 'https://rpc-mainnet.matic.quiknode.pro';
const PROXY = '0x958eed8B9c77f79420c3cde1998DF4EFb27e5972';
const USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const DEPLOY_BLOCK = 89500000;
const LIVE = 'https://bag8516-dev.github.io/mpc-escrow/';
const TIMEOUT = 86400; // 24h — 컨트랙트 TRADE_TIMEOUT과 동일

const TRANSFER  = ethers.id('Transfer(address,address,uint256)');
const REVEALED  = ethers.id('TradeRevealed(bytes32,address,uint256,uint256,uint256)');
const COMPLETED = ethers.id('TradeCompleted(bytes32,address,address)');
const CANCELLED = ethers.id('TradeCancelled(bytes32,address)');
const EXPIRED   = ethers.id('TradeExpired(bytes32)');
const pad = a => ethers.zeroPadValue(ethers.getAddress(a), 32).toLowerCase();
const num = v => Number(ethers.formatUnits(v, 18));

(async () => {
  let fail = false;
  // ── 전용 노드 상태 확인 (Origin 헤더: 대시보드 허용목록 설정 후에도 작동하도록) ──
  let p;
  try {
    const req = new ethers.FetchRequest(RPC_MAIN);
    req.setHeader('Origin', 'https://bag8516-dev.github.io');
    p = new ethers.JsonRpcProvider(req, 137, { staticNetwork: true });
    const t0 = Date.now();
    await p.getBlockNumber();
    console.log(`전용 노드(Infura): 정상 (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log('⚠️ 전용 노드(Infura) 응답 없음 — 공용 노드로 대체해 점검 계속. 앱도 자동 폴백되지만 원인 확인 필요');
    fail = true;
    p = new ethers.JsonRpcProvider(RPC_FALLBACK);
  }
  const idx = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const MPC = idx.match(/MPC_TOKEN:\s*'(0x[0-9a-fA-F]{40})'/)[1];

  // ── ② 실서버 확인 ──
  try {
    const html = await (await fetch(LIVE + '?t=' + Math.floor(Math.random() * 1e9))).text();
    const liveVer = (html.match(/APP_VERSION = '(\d+)'/) || [])[1];
    const vj = await (await fetch(LIVE + 'version.json?t=' + Math.floor(Math.random() * 1e9))).json();
    if (!liveVer) { console.log('⚠️ 실서버: APP_VERSION을 찾지 못함 (사이트 이상 가능)'); fail = true; }
    else if (liveVer !== String(vj.v)) { console.log(`⚠️ 실서버: index(${liveVer})와 version.json(${vj.v}) 불일치 — 새로고침 루프 위험! 즉시 조치 필요`); fail = true; }
    else console.log(`실서버: 정상 (v${liveVer}${vj.notice ? ', 공지 배너 송출 중' : ''})`);
  } catch (e) { console.log('⚠️ 실서버 확인 실패:', e.message); fail = true; }

  // ── ②-2 실서버 변조 감시: 배포된 index.html이 이 PC의 정본(gh-pages)과 1바이트라도 다르면 경보 ──
  // (깃허브 계정이 뚫려 앱이 바꿔치기되는 시나리오를 다음 날 아침 안에 잡는다)
  try {
    const live = await (await fetch(LIVE + 'index.html?t=' + Math.floor(Math.random() * 1e9))).text();
    const local = require('child_process').execSync('git -C C:/Projects/mpc-escrow show gh-pages:index.html', { maxBuffer: 16 * 1024 * 1024 }).toString('utf8');
    const norm = s => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (norm(live) !== norm(local)) { console.log('⚠️ 실서버 변조 의심: 배포된 index.html이 이 PC 정본과 다릅니다 — 무단 변경 또는 미배포 커밋. 즉시 확인 필요'); fail = true; }
    else console.log('변조 감시: 실서버 = 정본 일치');
  } catch (e) { console.log('⚠️ 변조 감시 실패:', e.message); fail = true; }

  // ── ②-3 알림 구독자 명단 백업: 서버 사고 시 복구용 (금고 폴더, 30일 보관) ──
  try {
    const r = await fetch('https://idqnxrwrnisxjbovvpli.supabase.co/functions/v1/esc-push-send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dump: true, key: ADMIN_KEY }),
    });
    const subs = ((await r.json()).subs) || [];
    if (!subs.length) throw new Error('구독 0건 응답 — 서버 확인 필요');
    const dir = 'C:/ssabom/appdata/backup';
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, `esc-subs-${day}.json`), JSON.stringify(subs, null, 1));
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^esc-subs-(\d{4}-\d{2}-\d{2})\.json$/);
      if (m && (Date.now() - new Date(m[1]).getTime()) > 30 * 86400 * 1000) fs.unlinkSync(path.join(dir, f));
    }
    console.log(`구독자 백업: ${subs.length}건 저장 (${day})`);
  } catch (e) { console.log('⚠️ 구독자 백업 실패:', e.message); fail = true; }

  // ── ① 장부 대조 + ③ 통계 ──
  try {
    const N = await p.getBlockNumber();   // 기준 블록 — 모든 수치를 이 시점으로 맞춘다

    // 이어읽기 저장소: 한 번 읽은 이벤트·블록시각은 파일에 쌓아두고 새 블록만 조회 (10분 → 수 초)
    // 체인 재구성 대비로 최신 1,000블록은 저장하지 않고 다음에 다시 읽는다
    const CACHE = path.join(__dirname, 'audit-cache.json');
    let cache = { cursor: DEPLOY_BLOCK - 1, logs: [], ts: {} };
    try {
      const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      if (c && typeof c.cursor === 'number' && c.cursor >= DEPLOY_BLOCK - 1 && Array.isArray(c.logs)) cache = c;
    } catch {} // 파일 없음/손상 → 처음부터 전체 스캔 (느릴 뿐 결과는 동일)

    async function scan(label, filter, from, to) {
      const out = [];
      for (let f = from; f <= to; f += 9500) {
        let ok = false;
        for (let a = 0; a < 6 && !ok; a++) {
          try { out.push(...await p.getLogs({ ...filter, fromBlock: f, toBlock: Math.min(f + 9499, to) })); ok = true; }
          catch { await sleep(2000); }
        }
        if (!ok) throw new Error(`${label} 구간 조회 실패 (RPC 제한)`);
        await sleep(100);
      }
      return out;
    }

    // 에스크로 이벤트: 저장분 + 새 구간만 스캔 → 등록/종료를 로그만으로 재구성
    const newLogs = cache.cursor < N
      ? await scan('에스크로 이벤트', { address: PROXY }, cache.cursor + 1, N)
      : [];
    const evLogs = [...cache.logs, ...newLogs];
    const openTrades = new Map();   // tradeId → { amount, block }  (아직 안 끝난 거래)
    let revealed = 0, done = 0;
    for (const l of evLogs) {
      const id = l.topics[1];
      if (l.topics[0] === REVEALED) {
        openTrades.set(id, { amount: BigInt('0x' + l.data.slice(2, 66)), block: l.blockNumber, seller: '0x' + l.topics[2].slice(26) });
        revealed++;
      } else if (l.topics[0] === COMPLETED) { openTrades.delete(id); done++; }
      else if (l.topics[0] === CANCELLED || l.topics[0] === EXPIRED) { openTrades.delete(id); }
    }
    let locked = 0n;
    for (const t of openTrades.values()) locked += t.amount;

    // 잔액을 N 시점으로 환산: 현재 잔액 − (N 이후 들어온 순입금)
    const M = await p.getBlockNumber();
    const erc = ['function balanceOf(address) view returns (uint256)'];
    const balNow = await new ethers.Contract(MPC, erc, p).balanceOf(PROXY, { blockTag: M });
    let net = 0n;
    if (M > N) {
      for (const l of await scan('N이후 입금', { address: MPC, topics: [TRANSFER, null, pad(PROXY)] }, N + 1, M)) net += BigInt(l.data);
      for (const l of await scan('N이후 출금', { address: MPC, topics: [TRANSFER, pad(PROXY), null] }, N + 1, M)) net -= BigInt(l.data);
    }
    const bal = balNow - net;   // = N 시점의 잔액

    const lockedStr = num(locked).toLocaleString();
    const balStr = num(bal).toLocaleString();
    if (locked === bal) console.log(`장부: 일치 ✅ (잠긴 ${lockedStr} = 잔액 ${balStr})`);
    else { console.log(`⚠️ 장부 불일치! 잠긴 ${lockedStr} vs 잔액 ${balStr} — 최우선 확인 필요`); fail = true; }

    // 검증 결과를 앱 신뢰 배지용으로 기록 (비밀값 검증 — 외부 위조 불가)
    try {
      const r = await fetch('https://idqnxrwrnisxjbovvpli.supabase.co/rest/v1/rpc/esc_audit_set', {
        method: 'POST',
        headers: { apikey: 'sb_publishable_1Pd6p7r3MRyVQ9vZBABNIg_rv7h71Qh', Authorization: 'Bearer sb_publishable_1Pd6p7r3MRyVQ9vZBABNIg_rv7h71Qh', 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_key: ADMIN_KEY, p_ok: locked === bal, p_locked: num(locked) }),
      });
      console.log((await r.text()).includes('ok') ? '신뢰 배지: 기록 완료' : '⚠️ 신뢰 배지 기록 실패');
    } catch (e) { console.log('⚠️ 신뢰 배지 기록 실패:', e.message); }

    const usdtBal = await new ethers.Contract(USDT, erc, p).balanceOf(PROXY, { blockTag: M });
    if (usdtBal !== 0n) { console.log(`⚠️ USDT 잔액 0 아님: ${ethers.formatUnits(usdtBal, 6)} — 비정상 (자동 즉시교환 구조)`); fail = true; }

    // 진행 중 거래만 블록 시각을 조회해 판매 중 / 반환 대기 구분 (createdAt = 예치 블록 시각)
    const nowTs = (await p.getBlock(M)).timestamp;
    const tsCache = new Map(Object.entries(cache.ts || {}).map(([k, v]) => [Number(k), v]));
    let act = 0, exp = 0, expM = 0;
    const expList = []; // 반환 대기 상세 (공지·개별 안내용)
    for (const t of openTrades.values()) {
      let ts = tsCache.get(t.block);
      if (ts === undefined) {
        for (let a = 0; a < 5 && ts === undefined; a++) {
          try { ts = (await p.getBlock(t.block)).timestamp; } catch { await sleep(1500); }
        }
        if (ts === undefined) throw new Error('블록 시각 조회 실패 (RPC 제한)');
        tsCache.set(t.block, ts);
        await sleep(80);
      }
      if (nowTs - ts > TIMEOUT) {
        exp++; expM += num(t.amount);
        expList.push({ mpc: Math.round(num(t.amount)), seller: t.seller, days: ((nowTs - ts - TIMEOUT) / 86400).toFixed(1) });
      } else act++;
    }
    console.log(`통계: 등록 누적 ${revealed}건 / 판매 중 ${act}건 / 반환 대기 ${exp}건(${Math.round(expM).toLocaleString()} MPC) / 완료 ${done}건`);
    if (expList.length) {
      expList.sort((a, b) => b.days - a.days);
      console.log('반환 대기 상세 (만료 후 경과일 순):');
      for (const r of expList.slice(0, 12))
        console.log(`  ${r.mpc.toLocaleString()} MPC | 판매자 ${r.seller.slice(0, 8)}…${r.seller.slice(-4)} | 만료 후 ${r.days}일`);
      if (expList.length > 12) console.log(`  …외 ${expList.length - 12}건`);
    }

    // 이어읽기 저장: 확정 구간(N−1,000 이전)의 이벤트와 블록시각만 기록
    try {
      const SAFE = N - 1000;
      fs.writeFileSync(CACHE, JSON.stringify({
        cursor: SAFE,
        logs: evLogs.filter(l => l.blockNumber <= SAFE)
          .map(l => ({ topics: l.topics, data: l.data, blockNumber: l.blockNumber })),
        ts: Object.fromEntries(tsCache),
      }));
    } catch (e) { console.log('이어읽기 저장 실패 (다음 점검은 전체 스캔):', e.message); }
  } catch (e) {
    console.log('⚠️ 장부 점검 측정 실패:', e.message, '— 0건이 아니라 측정 불가임');
    fail = true;
  }

  // ── 보안 채팅방 서버 깨우기 (무료 플랜은 7일 미사용 시 자동 정지 → 매일 가벼운 호출로 방지) ──
  try {
    const r = await fetch('https://idqnxrwrnisxjbovvpli.supabase.co/rest/v1/rpc/feed', {
      method: 'POST',
      headers: { apikey: 'sb_publishable_1Pd6p7r3MRyVQ9vZBABNIg_rv7h71Qh', Authorization: 'Bearer sb_publishable_1Pd6p7r3MRyVQ9vZBABNIg_rv7h71Qh', 'Content-Type': 'application/json' },
      body: '{}',
    });
    console.log(r.ok ? '채팅방 서버: 정상 (깨우기 완료)' : `⚠️ 채팅방 서버 응답 이상: HTTP ${r.status}`);
    if (!r.ok) fail = true;
  } catch (e) { console.log('⚠️ 채팅방 서버 접속 실패:', e.message); fail = true; }

  // ── 운영자 장애 알림: 이상 항목이 있으면 운영자 폰으로 즉시 푸시 ──
  // (발견→확인 간격을 줄이는 용도. 수정은 사람이 승인 — 자동 수정은 하지 않는다)
  if (fail && issues.length) {
    try {
      const webpush = require('web-push');
      const keyFile = fs.readFileSync('C:/ssabom/appdata/mpc-vapid-keys.txt', 'utf8');
      const pub = [...keyFile.matchAll(/VAPID_PUBLIC=(\S+)/g)].pop()[1];   // 파일의 마지막 쌍 = 현행 열쇠
      const priv = [...keyFile.matchAll(/VAPID_PRIVATE=(\S+)/g)].pop()[1];
      webpush.setVapidDetails('mailto:bag8516@gmail.com', pub, priv); // 실존 주소 필수 — 가짜면 애플만 403
      const r = await fetch('https://idqnxrwrnisxjbovvpli.supabase.co/functions/v1/esc-push-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dump: true, key: ADMIN_KEY }),
      });
      const OPERATOR = '0xf07ab48453b4f97cc15966a6f06f815399ea00c1';
      const subs = (((await r.json()).subs) || []).filter(s => s.wallet === OPERATOR);
      const body = issues.slice(0, 3).join('\n').slice(0, 170);
      let sent = 0;
      for (const s of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title: '🚨 에스크로 점검 이상', body }),
          );
          sent++;
        } catch (e) { console.error('운영자 알림 개별 실패:', e.statusCode || e.message); }
      }
      console.log(sent ? `운영자 알림: 폰으로 발송 완료 (${sent}건)` : '운영자 알림: 발송 실패 — 구독 없음 또는 전송 오류');
    } catch (e) { console.log('운영자 알림 발송 실패:', e.message); }
  }

  console.log(fail ? '결과: ⚠️ 이상 항목 있음 — 위 내용 확인 필요' : '결과: ✅ 전체 정상');
  process.exit(fail ? 2 : 0);
})();
