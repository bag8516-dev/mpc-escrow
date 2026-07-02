const { ethers } = require("hardhat");
require("dotenv").config();
const { writeFileSync } = require("fs");

// 기존 구현체 재사용 (변경 없음)
const IMPL_ADDR = "0x97FdC9C1230B31a038941c64284c4a11b966927E";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n════════════════════════════════════════");
  console.log("  멀티시그 + 프록시 재배포");
  console.log("════════════════════════════════════════");
  console.log("배포자:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("잔액:", ethers.formatEther(balance), "POL\n");

  const owner1 = process.env.MULTISIG_OWNER_1;
  const owner2 = process.env.MULTISIG_OWNER_2;
  console.log("오너 1:", owner1);
  console.log("오너 2:", owner2);

  if (!owner1 || !owner2 || owner1 === owner2) {
    console.error("❌ MULTISIG_OWNER_1, MULTISIG_OWNER_2가 서로 다른 주소여야 합니다");
    process.exit(1);
  }

  // ① 새 MultisigWallet 배포
  console.log("\n① MultisigWallet 배포 중...");
  const MultisigWallet = await ethers.getContractFactory("MultisigWallet");
  const multisig = await MultisigWallet.deploy([owner1, owner2]);
  await multisig.waitForDeployment();
  const multisigAddr = await multisig.getAddress();
  console.log("   ✅", multisigAddr);

  // ② 새 Proxy 배포 (기존 구현체 재사용)
  console.log("\n② MPCEscrowProxy 배포 중...");
  const MPCEscrow = await ethers.getContractFactory("MPCEscrow");
  const initData = MPCEscrow.interface.encodeFunctionData("initialize", [multisigAddr]);
  const Proxy = await ethers.getContractFactory("MPCEscrowProxy");
  const proxy = await Proxy.deploy(IMPL_ADDR, multisigAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log("   ✅", proxyAddr);

  console.log("\n════════════════════════════════════════");
  console.log("  배포 완료!");
  console.log("════════════════════════════════════════");
  console.log("MultisigWallet :", multisigAddr);
  console.log("구현체 (재사용) :", IMPL_ADDR);
  console.log("Proxy (새 주소) :", proxyAddr);
  console.log("\n▶ frontend CONFIG 업데이트:");
  console.log(`  ESCROW_PROXY: '${proxyAddr}',`);

  writeFileSync("deployed-polygon.json", JSON.stringify({
    network: "polygon", chainId: 137,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      MultisigWallet: multisigAddr,
      MPCEscrow_Implementation: IMPL_ADDR,
      MPCEscrowProxy: proxyAddr,
    },
    multisigOwners: [owner1, owner2],
  }, null, 2));
  console.log("\n✅ deployed-polygon.json 저장 완료");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
