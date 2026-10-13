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
const mtime = f => fs.statSync(f).mtimeMs;

const JOBS = [
  { key: 'err-triage', name: '오류 신고 자동 분류', maxAge: 2.5 * H,
    last: () => mtime('C:/ssabom/appdata/mpc-err-state.json') },
  { key: 'chain-stats', name: '온체인 현황 집계', maxAge: 14 * H,
    last: () => kstToMs(JSON.parse(fs.readFileSync('C:/Projects/mpc-landing/stats.json', 'utf8')).updated) },
  { key: 'daily-audit', name: '일일 장부 점검', maxAge: 27 * H,
    last: () => mtime('C:/ssabom/appdata/audit-history.jsonl') },
];

// 방금 켜졌거나 절전에서 깬 직후에는 예약 작업이 따라잡을 시간을 준다
if (os.uptime() < 20 * 60) { console.log('부팅 직후라 건너뜀'); process.exit(0); }

let st = {};
try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
const now = Date.now();
const late = [];

for (const j of JOBS) {
  let age;
  try { age = now - j.last(); } catch (e) { age = Infinity; }
  const ageH = age === Infinity ? '확인 불가' : (age / H).toFixed(1) + '시간';
  if (age > j.maxAge) {
    if (!st[j.key] || now - st[j.key] > REALERT) { late.push(`${j.name} ${ageH} 전`); st[j.key] = now; }
    console.log(`지연: ${j.key} ${ageH}`);
  } else {
    delete st[j.key];
    console.log(`정상: ${j.key} ${ageH} 전`);
  }
}

fs.writeFileSync(STATE, JSON.stringify(st));
if (late.length) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'notify-op.js'), '자동 작업이 멈춘 것 같아요', late.join(' / ')], { stdio: 'inherit' });
  } catch (e) { console.log('알림 발송 실패:', e.message); process.exit(1); }
}
