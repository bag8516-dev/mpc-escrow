// MPC 온체인 현황 집계 (폴리곤) — 하루 2번 예약 실행
// Transfer 로그를 전부 적립해 지갑별 잔액을 직접 계산한다 (폴리곤스캔 무료 API는 홀더 수를 안 줌).
// 집계 결과는 stats.json 으로 홈페이지 저장소에 자동 게시. 상태(잔액 장부)는 금고 폴더에만 둔다.
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RPC_MAIN = 'https://polygon-mainnet.infura.io/v3/c750d5ee07fc43eeaf0e9d64fff90ff2';
const RPC_FALLBACK = 'https://rpc-mainnet.matic.quiknode.pro';
const TOKEN = '0x2d854416d2749B1F0eb8a4B2Ab9027989F2ba262';
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const CHUNK = 9500;
const STATE_DIR = 'C:/ssabom/appdata/mpc-chain';
const STATE = path.join(STATE_DIR, 'state.json');
const LANDING = 'C:/Projects/mpc-landing';
const ZERO = '0x0000000000000000000000000000000000000000';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RPC_EXTRA = ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'];
async function getProvider() {
  // 1순위 전용 노드 → 안 되면 공용망 순서대로 (실제 호출로 생사 확인)
  for (const url of [RPC_MAIN, RPC_FALLBACK, ...RPC_EXTRA]) {
    try {
      const req = new ethers.FetchRequest(url);
      req.setHeader('Origin', 'https://mpcescrow.com');
      const p = new ethers.JsonRpcProvider(req, 137, { staticNetwork: true });
      await p.getBlockNumber();
      if (url !== RPC_MAIN) console.log('조회망 전환:', url.split('/')[2]);
      return p;
    } catch (_) {}
  }
  throw new Error('모든 조회망 응답 없음');
}

// 토큰 배포 블록 탐색 (최초 1회): getCode 이진 탐색
async function findDeployBlock(p, latest) {
  let lo = 0, hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await p.getCode(TOKEN, mid);
    if (code && code !== '0x') hi = mid; else lo = mid + 1;
  }
  return lo;
}

// 타임스탬프로 블록 찾기 (24시간 전 경계): 이진 탐색
async function blockAtTime(p, target, latest) {
  let lo = 0, hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await p.getBlock(mid);
    if (b.timestamp < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// 구간 조회: 결과가 1만 건을 넘으면 반으로 쪼개 재귀 조회 (대량 전송 시기 대응)
async function getLogsRange(p, from, to, depth = 0) {
  const filter = { address: TOKEN, topics: [TRANSFER], fromBlock: from, toBlock: to };
  for (let i = 0; i < 3; i++) {
    try { return await p.getLogs(filter); }
    catch (e) {
      if (String(e.message || e).includes('more than 10000') && from < to) {
        const mid = Math.floor((from + to) / 2);
        return (await getLogsRange(p, from, mid, depth + 1)).concat(await getLogsRange(p, mid + 1, to, depth + 1));
      }
      if (i === 2) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

async function main() {
  const p = await getProvider();
  const latest = await p.getBlockNumber();
  const SAFE = latest - 30; // 체인 재구성 여유

  fs.mkdirSync(STATE_DIR, { recursive: true });
  let st = { lastBlock: null, balances: {}, history: [] };
  if (fs.existsSync(STATE)) st = JSON.parse(fs.readFileSync(STATE, 'utf8'));

  if (st.lastBlock === null) {
    st.lastBlock = (await findDeployBlock(p, SAFE)) - 1;
    console.log('토큰 배포 블록 탐색:', st.lastBlock + 1);
  }

  // ── Transfer 적립 (지갑별 잔액 장부 갱신) ──
  const bal = st.balances; // { addr: wei 문자열 }
  const add = (a, v) => { if (a === ZERO) return; const x = BigInt(bal[a] || '0') + v; if (x === 0n) delete bal[a]; else bal[a] = x.toString(); };
  let scanned = 0, txCount = 0, sinceSave = 0;
  for (let from = st.lastBlock + 1; from <= SAFE; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, SAFE);
    const logs = await getLogsRange(p, from, to);
    for (const l of logs) {
      const v = BigInt(l.data);
      add('0x' + l.topics[1].slice(26), -v);
      add('0x' + l.topics[2].slice(26), v);
      txCount++;
    }
    scanned += (to - from + 1);
    st.lastBlock = to;
    if (++sinceSave >= 50) { fs.writeFileSync(STATE, JSON.stringify(st)); sinceSave = 0; console.log(`스캔 ${to}까지 저장 (누적 전송 ${txCount}건)`); }
  }
  console.log(`신규 스캔: ${scanned.toLocaleString()} 블록, 전송 ${txCount}건`);

  // ── 24시간 이동량: 최근 구간만 다시 읽어 합산 ──
  const nowB = await p.getBlock(SAFE);
  const dayStart = await blockAtTime(p, nowB.timestamp - 86400, SAFE);
  let moved = 0n, movedTx = 0;
  for (let from = dayStart; from <= SAFE; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, SAFE);
    const logs = await getLogsRange(p, from, to);
    for (const l of logs) { moved += BigInt(l.data); movedTx++; }
  }

  // ── 홀더·총 발행량 ──
  const holders = Object.keys(bal).filter(a => BigInt(bal[a]) > 0n).length;
  const token = new ethers.Contract(TOKEN, ['function totalSupply() view returns (uint256)'], p);
  const supply = await token.totalSupply();

  const day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const prev = st.history.length ? st.history[st.history.length - 1] : null;
  if (!prev || prev.d !== day) st.history.push({ d: day, holders });
  else prev.holders = holders;
  st.history = st.history.slice(-400);
  const yest = st.history.filter(h => h.d !== day).pop();
  const delta = yest ? holders - yest.holders : 0;

  fs.writeFileSync(STATE, JSON.stringify(st));

  const stats = {
    updated: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
    holders, holdersDelta: delta,
    moved24h: Math.round(Number(ethers.formatUnits(moved, 18))),
    tx24h: movedTx,
    totalSupply: Math.round(Number(ethers.formatUnits(supply, 18))),
  };
  console.log('집계:', JSON.stringify(stats));

  // ── 홈페이지 저장소에 게시 (market.json과 같은 흐름) ──
  fs.writeFileSync(path.join(LANDING, 'stats.json'), JSON.stringify(stats));
  try {
    const diff = execSync(`git -C ${LANDING} status --porcelain stats.json`).toString().trim();
    if (diff) {
      execSync(`git -C ${LANDING} add stats.json`);
      execSync(`git -C ${LANDING} commit -m "chain stats ${stats.updated}"`);
      execSync(`git -C ${LANDING} push origin main`);
      console.log('stats.json 게시 완료');
    } else console.log('stats.json 변화 없음');
  } catch (e) { console.log('⚠️ stats.json 게시 실패:', e.message); }
}

// 일시적 네트워크 장애 대비: 재시도는 스크립트 안에서 한다 (예약 작업이 새 명령을 만들면 허용 창이 떠서 멈춘다)
(async () => {
  for (let a = 1; a <= 3; a++) {
    try { await main(); return; }
    catch (e) {
      console.log(`⚠️ 체인 현황 집계 ${a}/3회 실패:`, e.message);
      if (a < 3) await new Promise(r => setTimeout(r, 2 * 60 * 1000)); // 도구 1회 실행 한도(10분) 안에 끝나도록 2분 간격
    }
  }
  console.log('⚠️ 체인 현황 집계 실패: 3회 모두 실패');
  process.exit(1);
})();
