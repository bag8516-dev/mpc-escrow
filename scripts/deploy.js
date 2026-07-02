const { ethers } = require("hardhat");
require("dotenv").config();
const { writeFileSync } = require("fs");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n════════════════════════════════════════");
  console.log("  MPC 에스크로 배포 시작");
  console.log("════════════════════════════════════════");
  console.log("배포자 주소:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("잔액:", ethers.formatEther(balance), "MATIC\n");

  if (balance === 0n) {
    console.error("❌ 잔액 부족. https://faucet.polygon.technology 에서 MATIC 받기");
    process.exit(1);
  }

  // ① MultisigWallet
  console.log("① MultisigWallet 배포 중...");
  const owner1 = process.env.MULTISIG_OWNER_1 || deployer.address;
  const owner2 = process.env.MULTISIG_OWNER_2 || deployer.address;
  const owners = [...new Set([owner1, owner2])];
  if (owners.length < 2) owners.push("0x000000000000000000000000000000000000dEaD");

  const MultisigWallet = await ethers.getContractFactory("MultisigWallet");
  const multisig = await MultisigWallet.deploy(owners);
  await multisig.waitForDeployment();
  const multisigAddr = await multisig.getAddress();
  console.log("   ✅", multisigAddr);

  // ② MPCEscrow 구현체
  console.log("\n② MPCEscrow 구현체 배포 중...");
  const MPCEscrow = await ethers.getContractFactory("MPCEscrow");
  const impl = await MPCEscrow.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("   ✅", implAddr);

  // ③ MPCEscrowProxy
  console.log("\n③ MPCEscrowProxy 배포 중...");
  const initData = MPCEscrow.interface.encodeFunctionData("initialize", [multisigAddr]);
  const Proxy = await ethers.getContractFactory("MPCEscrowProxy");
  const proxy = await Proxy.deploy(implAddr, multisigAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log("   ✅", proxyAddr);

  console.log("\n════════════════════════════════════════");
  console.log("  배포 완료!");
  console.log("════════════════════════════════════════");
  console.log("MultisigWallet :", multisigAddr);
  console.log("구현체          :", implAddr);
  console.log("Proxy (사용주소):", proxyAddr);
  console.log("\n▶ frontend CONFIG 업데이트:");
  console.log(`  ESCROW_PROXY: '${proxyAddr}',`);
  console.log(`  CHAIN_ID: 80002,`);
  console.log(`  RPC_URL: 'https://rpc-amoy.polygon.technology',`);
  console.log(`  EXPLORER: 'https://amoy.polygonscan.com',`);

  writeFileSync("deployed-amoy.json", JSON.stringify({
    network: "amoy", chainId: 80002,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: { MultisigWallet: multisigAddr, MPCEscrow_Implementation: implAddr, MPCEscrowProxy: proxyAddr },
    multisigOwners: owners,
  }, null, 2));
  console.log("\n✅ deployed-amoy.json 저장 완료");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
