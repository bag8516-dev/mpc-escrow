const { ethers } = require("hardhat");
require("dotenv").config();
const { writeFileSync } = require("fs");

const MULTISIG_ADDR = "0x701Da90026588430a1b39Cd8bb595811fca52510";
const IMPL_ADDR     = "0x095A08282d5a108c914B43403257710Fd3489787";

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("배포자:", deployer.address);
  console.log("잔액:", ethers.formatEther(balance), "MATIC\n");

  console.log("③ MPCEscrowProxy 배포 중...");
  const MPCEscrow = await ethers.getContractFactory("MPCEscrow");
  const initData = MPCEscrow.interface.encodeFunctionData("initialize", [MULTISIG_ADDR]);
  const Proxy = await ethers.getContractFactory("MPCEscrowProxy");
  const proxy = await Proxy.deploy(IMPL_ADDR, MULTISIG_ADDR, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log("   ✅", proxyAddr);

  console.log("\n════════════════════════════════════════");
  console.log("  배포 완료!");
  console.log("════════════════════════════════════════");
  console.log("MultisigWallet :", MULTISIG_ADDR);
  console.log("구현체          :", IMPL_ADDR);
  console.log("Proxy (사용주소):", proxyAddr);

  writeFileSync("deployed-polygon.json", JSON.stringify({
    network: "polygon", chainId: 137,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      MultisigWallet: MULTISIG_ADDR,
      MPCEscrow_Implementation: IMPL_ADDR,
      MPCEscrowProxy: proxyAddr,
    },
  }, null, 2));
  console.log("\n✅ deployed-polygon.json 저장 완료");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
