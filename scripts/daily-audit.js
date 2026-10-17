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

const RPC_MAIN = 'https://polygon-mainnet.infura.io/v3/c750d5ee07fc43eeaf0e9d64fff90ff2'; // 전용 노드 (2026-10)
const RPC_FALLBACK = 'https://rpc-mainnet.matic.quiknode.pro';
const PROXY = '0x958eed8B9c77f79420c3cde1998DF4EFb27e5972';
const USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const DEPLOY_BLOCK = 89500000;
const LIVE = 'https://mpcescrow.com/mpc-escrow/';
let TIMEOUT = 86400; // 기본 24h. 아래에서 컨트랙트의 TRADE_TIMEOUT 을 직접 읽어 덮는다 (업그레이드로 값이 바뀌어도 이 점검이 어긋나지 않게)

const TRANSFER  = ethers.id('Transfer(address,address,uint256)');
const REVEALED  = ethers.id('TradeRevealed(bytes32,address,uint256,uint256,uint256)');
const COMPLETED = ethers.id('TradeCompleted(bytes32,address,address)');
const CANCELLED = ethers.id('TradeCancelled(bytes32,address)');
const EXPIRED   = ethers.id('TradeExpired(bytes32)');
const pad = a => ethers.zeroPadValue(ethers.getAddress(a), 32).toLowerCase();
const num = v => Number(ethers.formatUnits(v, 18));

(async () => {
  let fail = false;
  let warn = false;   // 장애는 아니지만 감시 한 곳이 못 돈 경우. 하루는 넘어가고 이틀 이어지면 장애로 올린다
  // ── 전용 노드 상태 확인 (Origin 헤더: 대시보드 허용목록 설정 후에도 작동하도록) ──
  let p, probeErr, probeTries = 0;
  // 한 번 흔들린 걸로 이상 표시하지 않는다 (Infura 가 들쭉날쭉하게 응답하는 날이 있다). 3번까지 시도하고 전부 실패해야 이상으로 알린다.
  for (let i = 0; i < 3 && !p; i++) {
    probeTries++;
    try {
      const req = new ethers.FetchRequest(RPC_MAIN);
      req.setHeader('Origin', 'https://mpcescrow.com');
      const q = new ethers.JsonRpcProvider(req, 137, { staticNetwork: true });
      const t0 = Date.now();
      await q.getBlockNumber();
      // 블록 번호만 주고 컨트랙트 읽기는 실패하는 장애가 있었다 (2026-10-16~17, Internal error -32603). 실제 읽기까지 확인해야 '정상'이라 말할 수 있다.
      if ((await q.getCode(PROXY)).length <= 2) throw new Error('프록시 코드를 읽지 못함');
      p = q;
      console.log(`전용 노드(Infura): 정상 (${Date.now() - t0}ms)${probeTries > 1 ? ` — ${probeTries}번째 시도에서 성공` : ''}`);
    } catch (e) {
      probeErr = e;
      await sleep(2500);
    }
  }
  if (!p) {
    console.log(`⚠️ 전용 노드(Infura) 읽기 ${probeTries}번 모두 실패 (${String(probeErr.shortMessage || probeErr.message).slice(0, 60)}) — 공용 노드로 대체해 점검 계속. 앱도 자동 폴백되지만 원인 확인 필요`);
    fail = true;
    p = new ethers.JsonRpcProvider(RPC_FALLBACK);
  }
  // 전용 노드가 호출마다 들쭉날쭉하게 빈 응답(missing revert data)을 주는 장애가 있었다 (2026-10-16~17). 읽기는 재시도하고, 계속 실패하면 공용 노드로 읽는다.
  const pf = new ethers.JsonRpcProvider(RPC_FALLBACK);
  let retried = 0;
  const withFallback = async (fn) => {
    for (let i = 0; i < 2; i++) { try { return await fn(p); } catch { retried++; await sleep(1500); } }
    return fn(pf);   // 공용 노드도 실패하면 예외가 그대로 올라가 '측정 실패'로 보고된다
  };
  try {   // 거래 유효기간은 컨트랙트가 정한다. 코드의 값과 다르면 알려서 앱·서버 함수의 값도 같이 바꾸게 한다
    const t = Number(await withFallback(q => new ethers.Contract(PROXY, ['function TRADE_TIMEOUT() view returns (uint256)'], q).TRADE_TIMEOUT()));
    if (t > 0 && t !== TIMEOUT) { console.log(`ℹ️ 거래 유효기간이 ${t / 3600}시간으로 바뀜 (점검은 이 값으로 계산). 앱 화면(frontend/index.html)과 서버 함수의 값도 같은지 확인`); TIMEOUT = t; }
  } catch (e) { console.log('⚠️ 거래 유효기간 읽기 실패 — 24시간 기준으로 계산:', e.shortMessage || e.message); warn = true; }
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
    const norm = s => s.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\s+$/, ''); // BOM·개행 차이는 변조가 아님
    if (norm(live) !== norm(local)) { console.log('⚠️ 실서버 변조 의심: 배포된 index.html이 이 PC 정본과 다릅니다 — 무단 변경 또는 미배포 커밋. 즉시 확인 필요'); fail = true; }
    else console.log('변조 감시: 실서버 = 정본 일치');
  } catch (e) { console.log('⚠️ 변조 감시 실패:', e.message); fail = true; }

  // ── ②-2b 도메인 만료 감시: mpcescrow.com 연장을 놓치면 사이트 전체가 죽는다 (60일 전부터 경보) ──
  try {
    const rd = await (await fetch('https://rdap.verisign.com/com/v1/domain/mpcescrow.com', { headers: { Accept: 'application/rdap+json' } })).json();
    const exp = (rd.events || []).find(e => e.eventAction === 'expiration');
    if (!exp) throw new Error('만료일 정보 없음');
    const days = Math.floor((new Date(exp.eventDate) - Date.now()) / 86400000);
    if (days <= 60) { console.log(`⚠️ 도메인 mpcescrow.com 만료 ${days}일 전 (${exp.eventDate.slice(0, 10)}) — 가비아에서 연장 필요!`); fail = true; }
    else console.log(`도메인 만료: ${days}일 남음 (${exp.eventDate.slice(0, 10)})`);
  } catch (e) { console.log('⚠️ 도메인 만료 확인 실패:', e.message); warn = true; }

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
    const revealInfo = new Map();   // tradeId → { mpc, usdt, krw }  (시세 집계용)
    const completions = [];         // { id, block }
    let revealed = 0, done = 0;
    for (const l of evLogs) {
      const id = l.topics[1];
      if (l.topics[0] === REVEALED) {
        openTrades.set(id, { amount: BigInt('0x' + l.data.slice(2, 66)), block: l.blockNumber, seller: '0x' + l.topics[2].slice(26) });
        revealInfo.set(id, {
          mpc: Number(BigInt('0x' + l.data.slice(2, 66)) / 10n ** 18n),
          usdt: Number(BigInt('0x' + l.data.slice(66, 130))) / 1e6,
          krw: Number(BigInt('0x' + l.data.slice(130, 194))),
        });
        revealed++;
      } else if (l.topics[0] === COMPLETED) { openTrades.delete(id); done++; completions.push({ id, block: l.blockNumber }); }
      else if (l.topics[0] === CANCELLED || l.topics[0] === EXPIRED) { openTrades.delete(id); }
    }
    let locked = 0n;
    for (const t of openTrades.values()) locked += t.amount;

    // 잔액을 N 시점으로 환산: 현재 잔액 − (N 이후 들어온 순입금)
    const M = await p.getBlockNumber();
    const erc = ['function balanceOf(address) view returns (uint256)'];
    const balNow = await withFallback(q => new ethers.Contract(MPC, erc, q).balanceOf(PROXY, { blockTag: M }));
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
      if ((await r.text()).includes('ok')) console.log('신뢰 배지: 기록 완료');
      else { console.log('⚠️ 신뢰 배지 기록 실패'); warn = true; }
    } catch (e) { console.log('⚠️ 신뢰 배지 기록 실패:', e.message); warn = true; }

    const usdtBal = await withFallback(q => new ethers.Contract(USDT, erc, q).balanceOf(PROXY, { blockTag: M }));
    if (retried) console.log(`ℹ️ 전용 노드 읽기 ${retried}번 재시도함 (불안정. 매일 이어지면 노드 설정 확인)`);
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

    // ── 커뮤니티 시세: 완결 거래 집계 → 홈페이지 market.json 발행 (앱·홈이 공용) ──
    try {
      const comp = [];
      for (const cpl of completions) {
        const ri = revealInfo.get(cpl.id);
        if (!ri || !ri.mpc || !ri.usdt || !ri.krw) continue;
        let ts2 = tsCache.get(cpl.block);
        if (ts2 === undefined) { try { ts2 = (await p.getBlock(cpl.block)).timestamp; tsCache.set(cpl.block, ts2); } catch (_) {} }
        if (!ts2) continue;
        comp.push({ ts: ts2, mpc: ri.mpc, unitKrw: Math.round(ri.usdt * ri.krw / ri.mpc) });
      }
      comp.sort((a, b) => b.ts - a.ts);
      const in30 = comp.filter(c => c.ts >= nowTs - 30 * 86400);
      const avg30 = in30.length ? in30.reduce((s, c) => s + c.unitKrw * c.mpc, 0) / in30.reduce((s, c) => s + c.mpc, 0) : null;
      const fmtD = t2 => new Date((t2 + 9 * 3600) * 1000).toISOString().slice(5, 10).replace('-', '.');
      const marketData = {
        updated: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10),
        count30: in30.length, avg30: avg30 && Math.round(avg30),
        regs: revealed, // 누적 거래 등록 — 홈 에스크로 수치가 자동 갱신되도록 (2026-10-11)
        recent: comp.slice(0, 10).map(c => ({ d: fmtD(c.ts), mpc: c.mpc, unitKrw: c.unitKrw })),
      };
      fs.writeFileSync('C:/Projects/mpc-landing/market.json', JSON.stringify(marketData));
      const cp2 = require('child_process');
      if (cp2.execSync('git -C C:/Projects/mpc-landing status --porcelain market.json').toString().trim()) {
        cp2.execSync('git -C C:/Projects/mpc-landing add market.json');
        cp2.execSync('git -C C:/Projects/mpc-landing commit -m "data: 커뮤니티 시세 갱신" -- market.json');
        cp2.execSync('git -C C:/Projects/mpc-landing push origin main');
        console.log(`시세 발행: 완결 ${comp.length}건(30일 ${in30.length}건) → market.json 푸시`);
      } else console.log('시세 발행: 변동 없음');
    } catch (e) { console.log('⚠️ 시세 발행 실패:', e.message); warn = true; }

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

  // 경고는 하루는 넘어가고, 어제 기록에도 경고가 있었으면(이틀째) 장애로 올려 폰으로 알린다
  if (warn && !fail) {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync('C:/ssabom/appdata/audit-history.jsonl', 'utf8').trim().split('\n').pop()); } catch (_) {}
    if (prev.warn) { fail = true; console.log('⚠️ 같은 종류의 경고가 이틀째 이어짐 (도메인 만료·신뢰 배지·시세 발행 중 하나) — 위 줄 확인'); }
  }

  // ── 월간 리포트 재료: 하루 1줄 기록 (금고 폴더) ──
  try {
    fs.appendFileSync('C:/ssabom/appdata/audit-history.jsonl',
      JSON.stringify({ d: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), ok: !fail, warn, issues: issues.slice(0, 5) }) + '\n');
  } catch (_) {}

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

  console.log(fail ? '결과: ⚠️ 이상 항목 있음 — 위 내용 확인 필요' : (warn ? '결과: ✅ 정상 (경고 있음 — 위 ⚠️ 줄 확인, 이틀 이어지면 알림)' : '결과: ✅ 전체 정상'));
  process.exit(fail ? 2 : 0);
})();
