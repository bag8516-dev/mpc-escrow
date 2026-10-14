// 거래(판매 글) 유효기간 24시간 → 3일 업그레이드 (2026-10-15 사용자 결정)
// 실행: npx hardhat run scripts/upgrade-timeout-3d.js --network polygon
// 키는 저장소 .env 가 아니라 금고 파일 C:\ssabom\appdata\mpc-escrow.env 에서 읽는다 (PRIVATE_KEY=오너 지갑, OWNER2_PRIVATE_KEY=다른 오너)
const { ethers } = require("hardhat");
const { writeFileSync, readFileSync } = require("fs");

const PROXY_ADDR    = "0x958eed8B9c77f79420c3cde1998DF4EFb27e5972";
const MULTISIG_ADDR = "0x944936BF08e9aeB817Dad323Fd4888A9f1D80e87";
const NEW_TIMEOUT   = 3n * 86400n;
const REVEALED = ethers.id("TradeRevealed(bytes32,address,uint256,uint256,uint256)");
const ENDED = [ethers.id("TradeCompleted(bytes32,address,address)"), ethers.id("TradeCancelled(bytes32,address)"), ethers.id("TradeExpired(bytes32)")];

async function main() {
  const [owner1] = await ethers.getSigners();
  console.log("실행 지갑:", owner1.address, "/ 잔액", ethers.formatEther(await ethers.provider.getBalance(owner1.address)), "POL");

  // ⓪ 사전 확인: 업그레이드 순간 "24시간은 지났지만 3일은 안 지난" 판매 글이 있으면 그 글이 장터에 다시 살아난다.
  //    판매자가 24시간에 동의하고 올린 글이므로, 그런 글이 없을 때만 진행한다 (--force 없음: 있으면 중단).
  const cache = JSON.parse(readFileSync("scripts/audit-cache.json", "utf8"));
  const t = {};
  for (const l of cache.logs) {
    const id = l.topics[1];
    if (l.topics[0] === REVEALED) t[id] = { blk: l.blockNumber, open: true };
    else if (t[id] && ENDED.includes(l.topics[0])) t[id].open = false;
  }
  const head = await ethers.provider.getBlockNumber();
  const nowTs = (await ethers.provider.getBlock(head)).timestamp;
  const esc = new ethers.Contract(PROXY_ADDR, ["function getTrade(bytes32) view returns (tuple(address seller,address buyer,uint256 mpcAmount,uint256 usdtPricePerMPC,uint256 usdtAmount,uint256 krwPerUsdt,uint256 createdAt,uint256 sellerDepositBlock,uint8 status))", "function TRADE_TIMEOUT() view returns (uint256)"], ethers.provider);
  const risky = [];
  for (const [id, v] of Object.entries(t)) {
    if (!v.open || head - v.blk > 3 * 86400 / 2 + 20000) continue; // 3일보다 확실히 오래된 글은 볼 필요 없음
    const tr = await esc.getTrade(id);
    if (Number(tr.status) !== 2) continue;
    const age = nowTs - Number(tr.createdAt);
    if (age > 86400 && age < 3 * 86400) risky.push({ id, ageH: (age / 3600).toFixed(1), mpc: ethers.formatUnits(tr.mpcAmount, 18) });
  }
  if (risky.length) {
    console.error("❌ 24시간은 지났지만 3일은 안 지난 판매 글이 " + risky.length + "건 있습니다. 이 글들이 되살아나므로 지금은 업그레이드하지 않습니다.");
    risky.forEach(r => console.error("   ", r.ageH + "시간", r.mpc, "MPC", r.id.slice(0, 10)));
    console.error("   해당 판매자가 반환을 끝내거나 3일이 지난 뒤 다시 실행하세요.");
    process.exit(2);
  }
  console.log("⓪ 되살아날 판매 글 없음 (캐시 기준 블록 " + cache.cursor + ", 현재 " + head + ")");
  console.log("   라이브 TRADE_TIMEOUT:", (await esc.TRADE_TIMEOUT()).toString());

  // ① 새 구현체 배포
  const F = await ethers.getContractFactory("MPCEscrow");
  const impl = await F.deploy(); await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  const nt = await impl.TRADE_TIMEOUT();
  console.log("① 새 구현체", implAddr, "TRADE_TIMEOUT", nt.toString());
  if (nt !== NEW_TIMEOUT) { console.error("❌ 새 구현체 TRADE_TIMEOUT 이 3일이 아님"); process.exit(1); }

  // ② 멀티시그 제출 + 오너1 서명
  const msAbi = ["function submitTransaction(address,uint256,bytes) external returns (uint256)", "function confirmTransaction(uint256) external", "function transactionCount() view returns (uint256)"];
  const ms = new ethers.Contract(MULTISIG_ADDR, msAbi, owner1);
  const calldata = new ethers.Interface(["function upgradeTo(address)"]).encodeFunctionData("upgradeTo", [implAddr]);
  await (await ms.submitTransaction(PROXY_ADDR, 0, calldata)).wait();
  const txId = (await ms.transactionCount()) - 1n;
  await (await ms.confirmTransaction(txId)).wait();
  console.log("② 멀티시그 txId", txId.toString(), "오너1 서명 (1/2)");

  // ③ 오너2 서명 → 2/2 되면 자동 실행
  if (!process.env.OWNER2_PRIVATE_KEY) {
    console.log("③ OWNER2_PRIVATE_KEY 없음 — 다른 오너 지갑으로 confirmTransaction(" + txId + ") 을 실행해야 완료됩니다.");
    return;
  }
  const owner2 = new ethers.Wallet(process.env.OWNER2_PRIVATE_KEY, ethers.provider);
  await (await ms.connect(owner2).confirmTransaction(txId)).wait();
  console.log("③ 오너2 서명 (2/2) → 실행");

  // ④ 검증
  const live = await esc.TRADE_TIMEOUT();
  const cur = await new ethers.Contract(PROXY_ADDR, ["function implementation() view returns (address)"], ethers.provider).implementation();
  console.log("④ 프록시 구현체", cur, "/ 라이브 TRADE_TIMEOUT", live.toString());
  if (cur.toLowerCase() !== implAddr.toLowerCase() || live !== NEW_TIMEOUT) { console.error("❌ 검증 실패"); process.exit(1); }

  const prev = JSON.parse(readFileSync("deployed-polygon.json", "utf8"));
  prev.contracts.MPCEscrow_Implementation = implAddr;
  prev.deployedAt = new Date().toISOString();
  prev.note = "TRADE_TIMEOUT upgraded 24h -> 3d";
  writeFileSync("deployed-polygon.json", JSON.stringify(prev, null, 2));
  console.log("✅ 완료: 판매 글 유효기간 3일. deployed-polygon.json 갱신");
}
main().catch(e => { console.error("❌", e.message || e); process.exit(1); });
