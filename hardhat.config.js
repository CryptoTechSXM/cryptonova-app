require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/**
 * Hardhat config for CryptoNova -- dual-chain: Base (primary) + BNB Chain (secondary)
 *
 * Required .env variables:
 *   DEPLOYER_PRIVATE_KEY   -- wallet that pays gas for deploy
 *
 *   -- Base ------------------------------------------------------------------
 *   BASE_RPC_URL           -- Base mainnet RPC (free: https://mainnet.base.org)
 *   BASESCAN_API_KEY       -- for BaseScan verification (https://basescan.org/apis)
 *
 *   -- BNB Chain -------------------------------------------------------------
 *   BSC_RPC_URL            -- BSC mainnet RPC (free: https://bsc-dataseed.binance.org/)
 *   BSCSCAN_API_KEY        -- for BscScan verification (https://bscscan.com/apis)
 */

const ZERO_KEY         = "0x" + "0".repeat(64); // placeholder — invalid key, never included in accounts
const DEPLOYER_KEY     = process.env.DEPLOYER_PRIVATE_KEY || ZERO_KEY;
const FILL_FUNDER_KEY  = process.env.FILL_FUNDER_KEY      || ZERO_KEY;
// Only include keys that are valid (not the zero placeholder)
function validKeys(...keys) { return keys.filter(k => k !== ZERO_KEY); }

// Base
const BASE_RPC         = process.env.BASE_RPC_URL         || "https://mainnet.base.org";
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const BASESCAN_KEY     = process.env.BASESCAN_API_KEY     || "";

// BSC (secondary -- kept for future multi-chain deploy)
const BSC_RPC          = process.env.BSC_RPC_URL          || "https://bsc-dataseed.binance.org/";
const BSC_TESTNET_RPC  = process.env.BSC_TESTNET_RPC_URL  || "https://data-seed-prebsc-1-s1.binance.org:8545/";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  networks: {
    hardhat: {
      chainId: 31337,
      accounts: { count: 300 },
    },

    baseSepolia: {
      url: BASE_SEPOLIA_RPC,
      chainId: 84532,
      accounts: validKeys(DEPLOYER_KEY, FILL_FUNDER_KEY),
      gasPrice: "auto",
    },

    baseMainnet: {
      url: BASE_RPC,
      chainId: 8453,
      accounts: [DEPLOYER_KEY],
      gasPrice: "auto",
    },

    bscTestnet: {
      url: BSC_TESTNET_RPC,
      chainId: 97,
      accounts: [DEPLOYER_KEY],
      gasPrice: 10000000000,
    },

    bscMainnet: {
      url: BSC_RPC,
      chainId: 56,
      accounts: [DEPLOYER_KEY],
      gasPrice: 3000000000,
    },
  },

  etherscan: {
    apiKey: BASESCAN_KEY,
    customChains: [
      {
        network: "baseMainnet",
        chainId: 8453,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=8453",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "bscMainnet",
        chainId: 56,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=56",
          browserURL: "https://bscscan.com",
        },
      },
      {
        network: "bscTestnet",
        chainId: 97,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=97",
          browserURL: "https://testnet.bscscan.com",
        },
      },
    ],
  },

  paths: {
    sources:   "./contracts",
    tests:     "./test",    cache:     "./cache",
    artifacts: "./artifacts",
  },
};
