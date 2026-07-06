require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      accounts: { count: 300 },
      allowUnlimitedContractSize: true,
    },
  },
  paths: {
    sources:   "./contracts",
    tests:     "./test",
    cache:     "/tmp/hh-cache",
    artifacts: "/tmp/hh-artifacts",
  },
};
