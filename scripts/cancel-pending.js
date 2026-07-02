const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;

  const confirmedNonce = await provider.getTransactionCount(deployer.address, "latest");
  const pendingNonce = await provider.getTransactionCount(deployer.address, "pending");

  console.log("주소:", deployer.address);
  console.log("confirmed nonce:", confirmedNonce);
  console.log("pending nonce:", pendingNonce);

  if (pendingNonce <= confirmedNonce) {
    console.log("pending 트랜잭션 없음");
    return;
  }

  // pending 트랜잭션 취소: 같은 nonce로 자신에게 0 전송, 훨씬 높은 가스비로 replace
  for (let nonce = confirmedNonce; nonce < pendingNonce; nonce++) {
    console.log(`nonce ${nonce} 취소 중...`);
    const tx = await deployer.sendTransaction({
      to: deployer.address,
      value: 0n,
      nonce: nonce,
      maxFeePerGas: ethers.parseUnits("2000", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1000", "gwei"),
      gasLimit: 21000,
    });
    console.log(`  tx: ${tx.hash}`);
    await tx.wait();
    console.log(`  nonce ${nonce} 취소 완료 ✅`);
  }
  console.log("모든 pending 트랜잭션 취소 완료!");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
