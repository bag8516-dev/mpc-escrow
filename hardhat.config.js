require("@nomicfoundation/hardhat-toolbox");
// 키는 금고 파일에서 먼저 읽고(C:\ssabom\appdata, 저장소 밖), 없으면 저장소 .env (값은 비워 둠)
require("dotenv").config({ path: "C:/ssabom/appdata/mpc-escrow.env" });
require("dotenv").config();

// 키가 없으면 계정 없이 둔다. 예전에는 누구나 아는 하드햇 테스트 키로 대체돼서, 키 없이 배포 스크립트를 돌리면 그 키로 시도됐다
const ACCOUNTS = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];
const POLYGONSCAN_API = process.env.POLYGONSCAN_API_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    amoy: {
      url: "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: ACCOUNTS,
      gasPrice: 35000000000,
    },
    mumbai: {
      url: "https://rpc-mumbai.maticvigil.com",
      chainId: 80001,
      accounts: ACCOUNTS,
      gasPrice: 35000000000,
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",   // 전용 노드 주소(키 포함)는 저장소에 두지 않는다. 금고의 mpc-escrow.env 에 POLYGON_RPC_URL 로 둔다
      chainId: 137,
      accounts: ACCOUNTS,
      gasPrice: "auto",
    },
  },
  etherscan: {
    apiKey: { polygonAmoy: POLYGONSCAN_API, polygonMumbai: POLYGONSCAN_API, polygon: POLYGONSCAN_API },
    customChains: [{
      network: "polygonAmoy",
      chainId: 80002,
      urls: {
        apiURL: "https://api-amoy.polygonscan.com/api",
        browserURL: "https://amoy.polygonscan.com",
      },
    }],
  },
  paths: { sources: "./contracts", artifacts: "./artifacts", cache: "./cache" },
};
