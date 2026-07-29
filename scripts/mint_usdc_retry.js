/**
 * mint_usdc_retry.js — Retry the 61 wallets that failed in mint_usdc_bulk.js
 * due to "in-flight transaction" RPC throttling.
 * Adds 1500ms delay between each mint to avoid the issue.
 * Run: node scripts/mint_usdc_retry.js
 */

const { ethers } = require("ethers");
const path  = require("path");
const fs    = require("fs");
require("dotenv").config();

const AMOUNT_USDC = 5_000n * 1_000_000n; // 5000 USDC, 6 decimals
const DELAY_MS    = 1500;                 // ms between each tx

const FAILED_WALLETS = [
  "0x07D104352D9A709b963Df0A70B96D4f19d5432D4",
  "0x09ac468Bd0cd8796Dd45B1E8Db42F564CE40EeBa",
  "0x0a3e4d64CAfc52B183384102C075F80b51694D6e",
  "0x0ad1405C53032042F3F2626B3b1609eA87721502",
  "0x0b3D66e5aa6A6D8AF19950DEfD9474FD9ebe86eb",
  "0x0D7Cda79bfa74a49DbC54D2A911FFF6bd292bc13",
  "0x0dCD36Fb20E7221b18c28372FC65ef90810E3c5a",
  "0x1134b945A3d7e2DB40F6C00F43f4a885FE9393DD",
  "0x1157e8A88AA72c78A6931c0740C073a9cAfa21Fb",
  "0x118Dd02AEa326eDBF08AC4CA7b7926af75741126",
  "0x15ec37c187dddfa829394474872f2166658ca431",
  "0x17152Cb14DFe1A057e7cA875C9fAb0f2a7c32844",
  "0x176fDE2c9138b13Cbfe7a319E2C90b583e2f8d23",
  "0x1acc02252BfB5c7434771Bf848F6D77d11F60949",
  "0x1C56C63A7c501aCbcCd32cdab0485B0a8eC906b7",
  "0x1CA3316Ebc2F991C073ccdD1A25c68d482589A94",
  "0x1FC40BAc579c8EbF451Ae3071d0beA33E9531944",
  "0x233B203c909BC27ebEcF06A6B139CD02ea0ac00A",
  "0x23CEb27468E42090Feab4684553381f720B3Ca8a",
  "0x24f0c951b7d9C2Bc433B450a95704dE97370EaA2",
  "0x279a23E494371ad325425E85765185eD2583C4A8",
  "0x2d1604152F702aab1c1CA09Bed8EC61644dD268d",
  "0x2DbD8eE0c619640eEee20298392bb81Aa8185152",
  "0x473C629A054eE4CE4d962e2C6092Bd215Ef02Fc6",
  "0x47f78250eF66d821715FE676EB15e25c2Bf9F8e2",
  "0x4B81Dd8459A14d16b28C32243DA6D79Ea3B9A009",
  "0x5704E5F537069127a8a53e7C85D522264a0135eD",
  "0x57f841206AA18480a74FbAa65B5C6231C9a8CDa5",
  "0x5a358ef99c2e76bD7C082cfB931BEdEbAC49a738",
  "0x5bd38cf173E569BE12756e9F431F7bfE5e4366BE",
  "0x779262e7F4FddF0d0eC795EDBBE94E051fb6e3AA",
  "0x77e7351200DbdB00E616a5c0aE7b0bb5D23452C2",
  "0x784B231f830f25888aCc780c2172E75Df6e6E0f0",
  "0x7974967be8d32965Ac320135cF98c51F4b16A610",
  "0x7a245ED3799D31C0D90BA0cfe3191c0CF9a46FBa",
  "0x7a66F06674e7A0a46e026fd2f4762dbD15987AA9",
  "0x8c58B1AB5AEd772F5b1c43422077531067a80e49",
  "0x8E2d895624Bb82dc7148f5b4b576159616C8aAcC",
  "0x8f4D58487AD3C83D3920B6c88f8Ee1254dc8C3cf",
  "0x9388867f5C0477e8B26974f9b41f1BC0B416476a",
  "0x95EBdE6a7C0A91699EAC972C8cD3284F45d5e1e5",
  "0x964eA413F4C5D660E4C9545f99330df49E80ACD3",
  "0xa2f6FBfDf7bfB5601c3f3C6Ef3FbF6CEFf4044Ed",
  "0xacb1Afd6a6B525daE853D7E7C351917b438C4EeB",
  "0xAcCcc8446c8C0bd8F98b89ba1AaD24B0aB63fFD3",
  "0xAdf9C692CB9C77e641Cd2438F117a7570963F238",
  "0xAe9C58337Bfb61Bd274195eCb8794b50E4118297",
  "0xb231B42397B717D11176D06dDE0078589C6200f4",
  "0xb464C1eF79d4F3Ad4109bF5D66E6066F44611918",
  "0xc2c021fa5ef49ac60b966f3f3b8cae5d2398defb",
  "0xd136d23643A2eBeE50Bbe62F20B3E77aFF7c4a30",
  "0xd3e4ef897805cf81E3b6b9f3E5AD44A94b936f91",
  "0xd56e7dF24D182Bc64Bd3Caa322951912A6cEf54c",
  "0xD6FbdF7Ade38c8066c8798aECd0dB94DcD5CdCfe",
  "0xd81B9491D43afd4E5BB9d2e8c912c8861B42A9f9",
  "0xD887d66b7bA50141e12F7C136B8D872FCe0571ae",
  "0xdE5fe7cBDc941CC83C25780C9c72FB4F6274A4A3",
  "0xdFD9e186b8D8A9000cBeE47BE14310a43Bdf602e",
  "0xEb99B4ee8Aa31bE7CDBA386457802e7a86E070D5",
  "0xedB52653fFf4AF2d04565d8710e85C87D0245097",
  "0xfBD6Fa7d7ffF900f826896a5c91F371bF3489333",
];

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!process.env.BASE_SEPOLIA_RPC_URL) { console.error("FATAL: BASE_SEPOLIA_RPC_URL not set"); process.exit(1); }
  if (!process.env.DEPLOYER_PRIVATE_KEY)  { console.error("FATAL: DEPLOYER_PRIVATE_KEY not set"); process.exit(1); }
  if (!process.env.ADDRESSES_FILE)        { console.error("FATAL: ADDRESSES_FILE not set"); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const addrsPath = path.join(__dirname, process.env.ADDRESSES_FILE);
  const addrs = JSON.parse(fs.readFileSync(addrsPath, "utf8"));
  const usdc = new ethers.Contract(addrs.usdc, USDC_ABI, deployer);

  console.log(`Retrying ${FAILED_WALLETS.length} failed wallets (${DELAY_MS}ms delay between each)…\n`);

  let ok = 0, fail = 0;
  const stillFailed = [];

  for (let i = 0; i < FAILED_WALLETS.length; i++) {
    const addr = FAILED_WALLETS[i];
    try {
      const tx = await usdc.mint(addr, AMOUNT_USDC);
      await tx.wait();
      console.log(`[${i + 1}/${FAILED_WALLETS.length}] ✓ ${addr}`);
      ok++;
    } catch (e) {
      const errMsg = (e.message || "").slice(0, 100);
      console.log(`[${i + 1}/${FAILED_WALLETS.length}] ✗ ${addr} — ${errMsg}`);
      fail++;
      stillFailed.push(addr);
    }
    if (i < FAILED_WALLETS.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nDone. ✓ ${ok} minted  ✗ ${fail} still failed`);
  if (stillFailed.length > 0) {
    console.log("\nStill failed:");
    stillFailed.forEach(a => console.log(`  ${a}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
