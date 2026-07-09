const { ethers } = require("hardhat");
require("dotenv").config();
const { writeFileSync } = require("fs");

// 기존 배포 주소 (deployed-polygon.json)
const PROXY_ADDR    = "0x958eed8B9c77f79420c3cde1998DF4EFb27e5972";
const MULTISIG_ADDR = "0x944936BF08e9aeB817Dad323Fd4888A9f1D80e87";

async function main() {
  const [owner1] = await ethers.getSigners();
  console.log("\n════════════════════════════════════════");
  console.log("  거래 타임아웃 10분 → 24시간 업그레이드");
  console.log("════════════════════════════════════════");
  console.log("실행 지갑 (오너1):", owner1.address);

  const balance = await ethers.provider.getBalance(owner1.address);
  console.log("잔액:", ethers.formatEther(balance), "POL");
  if (balance === 0n) {
    console.error("❌ POL 잔액 부족");
    process.exit(1);
  }

  // ── 사전 확인: 진행 중(PENDING/ACTIVE) 거래가 있으면 중단 ──
  // 업그레이드 순간 기존 10분 거래가 24시간 거래로 바뀌므로, 열린 거래가 없을 때 실행해야 안전
  console.log("\n⓪ 진행 중 거래 확인...");
  console.log("   (수동 확인 필요: 카카오 회원 중 진행 중 거래가 없는 시간대에 실행하세요)");

  // ── ① 새 구현체 배포 (TRADE_TIMEOUT = 24 hours) ──
  console.log("\n① 새 MPCEscrow 구현체 배포 중...");
  const MPCEscrow = await ethers.getContractFactory("MPCEscrow");
  const impl = await MPCEscrow.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("   ✅ 새 구현체:", implAddr);

  const newTimeout = await impl.TRADE_TIMEOUT();
  console.log("   새 구현체 TRADE_TIMEOUT:", newTimeout.toString(), "초 (86400 = 24시간)");
  if (newTimeout !== 86400n) {
    console.error("❌ TRADE_TIMEOUT이 24시간이 아닙니다. 컨트랙트를 확인하세요.");
    process.exit(1);
  }

  // ── ② 멀티시그에 업그레이드 트랜잭션 제출 ──
  console.log("\n② 멀티시그에 업그레이드 제출...");
  const multisigAbi = [
    "function submitTransaction(address to, uint256 value, bytes calldata data) external returns (uint256)",
    "function confirmTransaction(uint256 txId) external",
    "function transactionCount() view returns (uint256)",
    "function getTransaction(uint256 txId) view returns (address to, uint256 value, bytes data, bool executed, uint256 confirmations)",
  ];
  const proxyAbi = ["function upgradeTo(address newImplementation) external", "function implementation() view returns (address)"];

  const multisig = new ethers.Contract(MULTISIG_ADDR, multisigAbi, owner1);
  const proxyIface = new ethers.Interface(proxyAbi);
  const upgradeCalldata = proxyIface.encodeFunctionData("upgradeTo", [implAddr]);

  const submitTx = await multisig.submitTransaction(PROXY_ADDR, 0, upgradeCalldata);
  await submitTx.wait();
  const txId = (await multisig.transactionCount()) - 1n;
  console.log("   ✅ 제출 완료. 멀티시그 txId:", txId.toString());

  // ── ③ 오너1 서명 ──
  console.log("\n③ 오너1 서명 중...");
  const confirm1 = await multisig.confirmTransaction(txId);
  await confirm1.wait();
  console.log("   ✅ 오너1 서명 완료 (1/2)");

  // ── ④ 오너2 서명 (OWNER2_PRIVATE_KEY 있으면 자동, 없으면 안내) ──
  if (process.env.OWNER2_PRIVATE_KEY) {
    console.log("\n④ 오너2 서명 중...");
    const owner2 = new ethers.Wallet(process.env.OWNER2_PRIVATE_KEY, ethers.provider);
    const multisig2 = multisig.connect(owner2);
    const confirm2 = await multisig2.confirmTransaction(txId);
    await confirm2.wait();
    console.log("   ✅ 오너2 서명 완료 (2/2) → 자동 실행됨");
  } else {
    console.log("\n④ ⚠️ OWNER2_PRIVATE_KEY가 .env에 없습니다.");
    console.log("   오너2 지갑으로 아래를 실행해야 업그레이드가 완료됩니다:");
    console.log(`   멀티시그(${MULTISIG_ADDR})의 confirmTransaction(${txId})`);
    process.exit(0);
  }

  // ── ⑤ 검증 ──
  console.log("\n⑤ 업그레이드 검증...");
  const proxy = new ethers.Contract(PROXY_ADDR, proxyAbi, ethers.provider);
  const currentImpl = await proxy.implementation();
  console.log("   프록시의 현재 구현체:", currentImpl);
  if (currentImpl.toLowerCase() !== implAddr.toLowerCase()) {
    console.error("❌ 구현체가 교체되지 않았습니다!");
    process.exit(1);
  }

  const escrowViaProxy = new ethers.Contract(PROXY_ADDR, ["function TRADE_TIMEOUT() view returns (uint256)"], ethers.provider);
  const liveTimeout = await escrowViaProxy.TRADE_TIMEOUT();
  console.log("   프록시 경유 TRADE_TIMEOUT:", liveTimeout.toString(), "초");
  if (liveTimeout !== 86400n) {
    console.error("❌ TRADE_TIMEOUT 검증 실패!");
    process.exit(1);
  }

  console.log("\n════════════════════════════════════════");
  console.log("  ✅ 업그레이드 완료! 거래 유효시간 24시간");
  console.log("════════════════════════════════════════");

  writeFileSync("deployed-polygon.json", JSON.stringify({
    network: "polygon", chainId: 137,
    deployedAt: new Date().toISOString(),
    deployer: owner1.address,
    contracts: {
      MultisigWallet: MULTISIG_ADDR,
      MPCEscrow_Implementation: implAddr,
      MPCEscrowProxy: PROXY_ADDR,
    },
    multisigOwners: [
      "0x9A1f2405650F43213a0ddbbBAfa933c24125F458",
      "0xF07ab48453B4f97cC15966a6F06F815399ea00c1",
    ],
    note: "TRADE_TIMEOUT upgraded 10min -> 24h",
  }, null, 2));
  console.log("✅ deployed-polygon.json 갱신 완료");
}

main().catch(e => { console.error("❌", e); process.exit(1); });
