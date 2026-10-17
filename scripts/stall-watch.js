// 자동 작업 멈춤 감시: 앱 밖(윈도우 작업 스케줄러)에서 30분마다 돌며, 작업 결과물이 제때 갱신됐는지 본다.
// 원인이 허용 창이든 앱 종료든 PC 꺼짐이든, 결과물이 늙었으면 운영자 폰으로 알린다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const H = 3600 * 1000;
const STATE = 'C:/ssabom/appdata/stall-watch-state.json';
const REALERT = 6 * H;

const kstToMs = s => Date.parse(s.replace(' ', 'T') + ':00+09:00');
const WORK = 'C:/Users/박세진/OneDrive/Desktop/업무관련';
const mtime = f => fs.statSync(f).mtimeMs;

const JOBS = [
  { key: 'err-triage', name: '오류 신고 자동 분류', maxAge: 2.5 * H,
    last: () => mtime('C:/ssabom/appdata/mpc-err-heartbeat.txt') },
  { key: 'chain-stats', name: '온체인 현황 집계', maxAge: 13 * H,
    last: () => kstToMs(JSON.parse(fs.readFileSync('C:/Projects/mpc-landing/stats.json', 'utf8')).updated) },
  { key: 'daily-audit', name: '일일 장부 점검', maxAge: 27 * H,
    last: () => mtime('C:/ssabom/appdata/audit-history.jsonl') },
  { key: 'weekly-review', name: '주간 자가 점검', maxAge: 8.5 * 24 * H,
    last: () => Math.max(...fs.readdirSync(WORK + '/주간점검').map(f => mtime(WORK + '/주간점검/' + f))) },
  // 매월 1일 09:40에 전월 PDF가 생긴다. 2~8일에만 확인하고 그 밖의 날은 건너뛴다
  { key: 'monthly-report', name: '월간 운영 리포트', maxAge: 0,
    last: () => {
      const k = new Date(Date.now() + 9 * H), d = k.getUTCDate();
      if (d < 2 || d > 8) return null;
      const p = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() - 1, 1));
      const f = WORK + '/운영리포트/' + p.getUTCFullYear() + '-' + String(p.getUTCMonth() + 1).padStart(2, '0') + '.pdf';
      if (!fs.existsSync(f)) throw new Error('전월 PDF 없음');
      return Date.now();
    } },
];

// 방금 켜졌거나 절전에서 깬 직후에는 예약 작업이 따라잡을 시간을 준다
if (os.uptime() < 20 * 60) { console.log('부팅 직후라 건너뜀'); process.exit(0); }

let st = {};
try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
const now = Date.now();
const late = [];
const alerted = [];   // 이번에 알리기로 한 항목. 알림이 실패하면 상태에서 빼서 다음에 다시 알린다

for (const j of JOBS) {
  let age;
  try { const t = j.last(); if (t === null) { delete st[j.key]; continue; } age = now - t; } catch (e) { age = Infinity; }
  const ageH = age === Infinity ? '결과물 없음' : (age / H).toFixed(1) + '시간 전';
  if (age > j.maxAge) {
    if (!st[j.key] || now - st[j.key] > REALERT) { late.push(`${j.name} ${ageH}`); st[j.key] = now; alerted.push(j.key); }
    console.log(`지연: ${j.key} ${ageH}`);
  } else {
    delete st[j.key];
    console.log(`정상: ${j.key} ${ageH}`);
  }
}

// 서버 5분 자동 호출: 함수 직접 호출로 응답 확인 + (SQL 6번 적용 시) 마지막 자동 호출 경과 초 확인
const SB = 'https://idqnxrwrnisxjbovvpli.supabase.co';
const PUB = 'sb_publishable_1Pd6p7r3MRyVQ9vZBABNIg_rv7h71Qh';
async function serverCheck() {
  const problems = [];
  let callKey;
  try { callKey = fs.readFileSync('C:/ssabom/appdata/mpc-esc-call-key.txt', 'utf8').split('\n')[2].match(/[0-9a-f]{32}/)[0]; }
  catch (e) { return '서버 호출 키 파일을 읽지 못함 (' + String(e.message).slice(0, 40) + ')'; }   // 이 한 곳이 죽으면 다른 지연 알림까지 같이 사라지던 것을 막는다
  try {
    const r = await fetch(SB + '/functions/v1/esc-push-send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ call: callKey }), signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error || (j.errors && j.errors.length)) problems.push('서버 함수 응답 이상 (' + (j.error || r.status) + ')');
    else {
      console.log('정상: 서버 함수 응답');
      if (j.audit && j.audit.ran === false && !j.audit.skipped) problems.push('서버 일일 점검이 돌지 않음');
    }
  } catch (e) { problems.push('서버 함수 호출 실패'); }
  try {
    const r = await fetch(SB + '/rest/v1/rpc/esc_cron_age', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: PUB, Authorization: 'Bearer ' + PUB }, body: '{}', signal: AbortSignal.timeout(20000) });
    if (r.status === 404) console.log('서버 5분 호출 시각 조회: SQL 6번 미적용 (건너뜀)');
    else if (r.ok) {
      const age = await r.json();
      if (age === null) console.log('서버 5분 호출: 아직 기록 없음');
      else if (age > 900) problems.push('서버 5분 자동 호출이 ' + Math.round(age / 60) + '분째 안 불림');
      else console.log('정상: 서버 5분 호출 ' + age + '초 전');
    } else problems.push('서버 호출 시각 조회 실패 (' + r.status + ')');
  } catch (e) { problems.push('서버 호출 시각 조회 실패'); }
  try {   // 로컬 파일이 아니라 실제로 공개된 홈페이지의 집계가 낡았는지 본다 (push 가 실패해도 로컬은 새것이라 '정상'으로 보이던 것)
    const r = await fetch('https://mpcescrow.com/stats.json?t=' + Date.now(), { signal: AbortSignal.timeout(20000) });
    const age = Date.now() - kstToMs((await r.json()).updated);
    if (!r.ok || !(age < 13 * H)) problems.push('공개 홈페이지 온체인 현황이 ' + (Number.isFinite(age) ? (age / H).toFixed(1) + '시간 전 것' : '읽히지 않음'));
    else console.log('정상: 공개 홈페이지 현황 ' + (age / H).toFixed(1) + '시간 전');
  } catch (e) { problems.push('공개 홈페이지 현황을 읽지 못함'); }
  return problems.join(' / ');
}

(async () => {
  let sp;
  try { sp = await serverCheck(); } catch (e) { sp = '서버 점검 자체가 실패 (' + String(e.message).slice(0, 40) + ')'; }
  if (sp) {
    if (!st.server || now - st.server > REALERT) { late.push(sp); st.server = now; alerted.push('server'); }
    console.log('지연: server ' + sp);
  } else delete st.server;
  let failed = false;
  if (late.length) {
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'notify-op.js'), '자동 작업이 멈춘 것 같아요', late.join(' / ')], { stdio: 'inherit' });
    } catch (e) {
      console.log('알림 발송 실패:', e.message);
      for (const k of alerted) delete st[k];   // 알리지 못했으니 6시간 재알림 대기에 넣지 않는다
      failed = true;
    }
  }
  fs.writeFileSync(STATE, JSON.stringify(st));
  if (failed) process.exit(1);
})();
