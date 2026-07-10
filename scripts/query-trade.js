// Use hardhat's ethers v6 style
const config = require("./hardhat.config.js");
const rpcUrl = config.networks.polygon.url;
const PROXY = "0x547FA64a307EdFD1B458b54Ea5ca114f5269ea8D";
const TRADE_ID = "0x64a5d994b8c169ede32836d68d6146073a361614095b33a30fbee16fe173adf2";

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({jsonrpc:"2.0",method,params,id:1})
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function main() {
  console.log("RPC:", rpcUrl.slice(0,40) + "...");
  const bn = await rpc(rpcUrl, "eth_blockNumber", []);
  console.log("Block:", parseInt(bn, 16));
  
  const code = await rpc(rpcUrl, "eth_getCode", [PROXY, "latest"]);
  console.log("Proxy code length:", code.length);
  
  // getTrade(bytes32) - using raw eth_call
  // Function selector for getTrade(bytes32) - need to compute
  // Let's use the known implementation: the function in the ABI
  // trades(bytes32) public mapping getter
  const tradeIdNoPrefix = TRADE_ID.slice(2);
  
  // ABI encode: function selector + padded bytes32
  // We'll compute selector ourselves: keccak256("getTrade(bytes32)")[0:4]
  // Instead just try calling trades() public getter
  // trades(bytes32) auto-generated getter has same signature as getTrade in some cases
  
  // Actually let's just verify the call data we used earlier was wrong
  // Let's use eth_call with all zeros to see what getTrade returns for nonexistent trade
  const zeroTradeId = "0x" + "0".repeat(64);
  const calldata = "0x" + "4185b80f" + "0".repeat(64); // getTrade(bytes32) selector + zero id
  const result = await rpc(rpcUrl, "eth_call", [{to: PROXY, data: calldata}, "latest"]);
  console.log("getTrade(zero) result length:", result.length, "first 10:", result.slice(0,20));
}
main().catch(e => console.error("ERR:", e.message));
