const hre = require("hardhat");
async function main() {
  const provider = hre.ethers.provider;
  const [signer] = await hre.ethers.getSigners();
  console.log("signer:", signer.address);
  
  const ABI = ["function commitTrade(bytes32 commitHash) returns (bytes32)", "function multisig() view returns (address)"];
  const proxy = new hre.ethers.Contract("0x9b5b465088F85F587A67b8AFCaFae14001Dcacc6", ABI, signer);
  
  const multisig = await proxy.multisig();
  console.log("multisig:", multisig);

  const secret = hre.ethers.hexlify(hre.ethers.randomBytes(32));
  const fakeHash = hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [secret]));
  console.log("commitHash:", fakeHash);
  
  try {
    const gas = await proxy.commitTrade.estimateGas(fakeHash);
    console.log("estimateGas OK:", gas.toString());
  } catch(e) {
    console.log("estimateGas FAIL:", e.message);
    console.log("reason:", e.reason);
    console.log("data:", e.data);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
