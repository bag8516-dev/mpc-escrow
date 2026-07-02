require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
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
      accounts: [PRIVATE_KEY],
      gasPrice: 35000000000,
    },
    mumbai: {
      url: "https://rpc-mumbai.maticvigil.com",
      chainId: 80001,
      accounts: [PRIVATE_KEY],
      gasPrice: 35000000000,
    },
    polygon: {
      url: "https://icy-green-pallet.matic.quiknode.pro/93742044e6bc41d9c0515376f1a8b0d8e8ef2efd/",
      chainId: 137,
      accounts: [PRIVATE_KEY],
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
