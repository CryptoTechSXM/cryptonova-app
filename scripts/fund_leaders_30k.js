// fund_leaders_30k.js — top selected leader wallets up to EXACTLY $30,000 USDC
// (owner 2026-08-08, V8.48 shakedown wave: wallet-funded upgrades all tiers).
//
// Rules (owner): target $30,000 TOTAL per wallet — mint only the shortfall,
// SKIP any wallet already at or above $30,000. Never reduces anyone.
// MockUSDC.mint is onlyOwner — run with the deployer key (default signer).
//
// Run (contracts repo):
//   DRY_RUN=1 npx hardhat run scripts/fund_leaders_30k.js --network baseSepolia
//   npx hardhat run scripts/fund_leaders_30k.js --network baseSepolia
//
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

const ADDRESSES_FILE = process.env.ADDRESSES_FILE || "deployed_addresses_v8_47.json";
const TARGET = 30_000_000_000n; // $30,000 in 6-decimal USDC
const DRY    = process.env.DRY_RUN === "1";

// 94 unique wallets (owner list 2026-08-08, deduplicated from 115 pasted lines)
const LEADERS = [
"0x6419E0192cDA27f8d6899A7c5A89Bcf8f7ff459F","0x702e7d2b3fF45d3EBf05f1e3baD36a07400d0c2D",
"0xAdf9C692CB9C77e641Cd2438F117a7570963F238","0xF0382F843FF71aE90D5683b9ba1aC0C58F141Cca",
"0x0dCD36Fb20E7221b18c28372FC65ef90810E3c5a","0x007f95d040D6f7f35364E38B982d15Ab5E76EFF7",
"0x114019778288E07e6DD276AF8dcAFe6bBcf21Ee2","0x18750a2cB86e7d2c5dFC47175BCA1F3f19F2C290",
"0x20325876F47c5D30DA4Ac38C52a73eF342eAfd56","0x4716E1424ED24b8Aaf6DE25d9E4eb6FFD5072fB9",
"0x4Cf7f43A4A2Df2e86fd68D35562Eb96bBE5ea5Cd","0x509F1A8d9d615916FA38dD87393b5609001387F4",
"0x50A7B10E32a667fFbe57033f33a79f7cf05Cb13C","0x5E28D5f82a04c3954A575db26b919Bd2F52a2b54",
"0x5F3F81525655Ec12659bC1eF7D74e0D1b99D9A74","0x6B6a03727aee58A1b1bEec71F9F42dBb6f9140f0",
"0x6c854F94757893616A952e2E67aDAb5112573e86","0x7010AD1e57DA7E7c07C30ce1c2413EeE2a613BaC",
"0x7308daF433804e8F10Dd267C70332609bd491477","0x788b70FE1453cCc12E3D76aE18c1952046Fa02Af",
"0x89276Ce886DC8977C16B7cBfE28D7C953bab69dc","0x8b779FB8893E012C7D7A7D4A8Ee0a3e11c8Dfe14",
"0x8e9DA9Cfca45C5EAa1f4ffC4EACAd05F4d258b07","0x976F80A147C204B8dD005E9787Cc47982D547025",
"0x99b52ee99D518687a092b250123DB256f1B7ceE3","0x9C8E3B2e3A1AB2193d82052813d55AEBEc51F001",
"0x9FA824D9C7Bf04394c42F2f6d1BbD54897C65db1","0xa19aEA715aB3Dcf53cbC13719da4aE1Cc4DDDa7b",
"0xAB6F8a78b9bA3031Fa2A033740B897813869e6A9","0xac7A0Ab46613007d7b1d0DD5e6D3733825A2644E",
"0xB888Ca03c30c331Ce6Ec5f73Cd4F948E43B86B51","0xBF62a5972a5eFb7482031299aB95C71ba911D716",
"0xC6b7f1Db252bf7688deD8EA9C68b47A593069C2a","0xC84661f7eC577aAD5f8Ab447E9f6ACb1c43602a6",
"0xd1FD2D1D6C5c1f063D72666F065B9717549721D5","0xdE580069839F42108064A0FcE2a3a9A802F072D6",
"0x95EBdE6a7C0A91699EAC972C8cD3284F45d5e1e5","0xfBD6Fa7d7ffF900f826896a5c91F371bF3489333",
"0x3289a65C0eE26fD369A6BbD45D214209832DB8F0","0x79470c63b5421e333Ab4149b3206d55A39c17532",
"0x7a98CeefA295D81683CD1ad16c905D71b0211Bbf","0x9e0413A671f48da6317473e81eB089136e9f1273",
"0x1CA3316Ebc2F991C073ccdD1A25c68d482589A94","0x301Afb29e6F4b68C97F20686aD23e7adc3955170",
"0xd4C441c795E86939fd19fc2eD05918Bb75F1C905","0x145805E87cE365aD6C2636b8f6E10B6550f3dC2a",
"0x185B19c7D3872692981568985b21AE6F7f6BE2A4","0x46CC052B2EB70f869B8CEaE6f217d475a4e0c6D5",
"0x728FF08035FFfbC5a2f512a081CC88a4221f5F00","0x737c3309c3D6F5702C8F4bb81494568f8d0d1bE5",
"0x832b95A579478784fada54AD7b62c7963e21feFb","0x96482BB0C13903563bD647BCfA77c67230010b2a",
"0x0ddb6a96fa15f98e823cd6632f9b14373cd1c74b","0x75784FE21F201f8B1F909cF9B055Ef5E19Fb7385",
"0x6fa5c7C8EbdEA1bC1E4782c18Ac8Bc7E41C050F6","0xb3ceb3cb0841432cb12fde53c8a3d47b7b9416b3",
"0xd64e08fc20829632dd842213a590b0c0b1b70b1f","0x0d103cb2eb0f447ebc4a6656272d333301988705",
"0x3c17556855cfBd29b6F7a41eBfdbe8e914B7bbDD","0xFa92031d2580AA8Ad041C29C1Cb674072142ea0C",
"0x3A4BFA9b368bc0A49D612424f2A0F2590F783CA0","0x0AF857609673Ad0C16403264b75FF8adA0244e93",
"0x0f50998163F3DeE028a3D72153659D08aede45F3","0x141a5B0d42B0ba2AF1BE4eC771B96Db460896a50",
"0x19a59fbD6d2c1289668795D41453e1505B7B8102","0x1acc02252BfB5c7434771Bf848F6D77d11F60949",
"0x1D3E33aAFFDb694E5a45d793B6946120467e93AB","0x26388a81eb9448DF02144cc765Bb448444e61f9B",
"0x305029890b8Bc7806CaF641B0cf8FC8b3e0ec137","0x391ab9edC83960e6ec468bDb7e6abE5858656F68",
"0x473C629A054eE4CE4d962e2C6092Bd215Ef02Fc6","0x5179A012b54EE6E6c7db92f820C9b3d8126Eead2",
"0x536685F063927d3B45394270A0aa785bB5B588f0","0x5d52218FF7Fe7678F87252A0bDA33c122B1B3191",
"0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435","0x7974967be8d32965Ac320135cF98c51F4b16A610",
"0x7CAFC198D7f59c43fCAec0d177Ca8610fc4b14BD","0x84A4D33A4EF25e5dE8dCA960aB7AF592351E4650",
"0x8E2d895624Bb82dc7148f5b4b576159616C8aAcC","0x8fb7ca44D27c67b0cFED5153aeEE4F70F4aed6c2",
"0xa2Dfd8c3b99b4395550558acf6cFFe79017b702C","0xacb1Afd6a6B525daE853D7E7C351917b438C4EeB",
"0xb231B42397B717D11176D06dDE0078589C6200f4","0xc731b6eA3057B66bE73512cFE2db4eF1D290dCEa",
"0xd56e7dF24D182Bc64Bd3Caa322951912A6cEf54c","0xD6FbdF7Ade38c8066c8798aECd0dB94DcD5CdCfe",
"0xD887d66b7bA50141e12F7C136B8D872FCe0571ae","0xdE5fe7cBDc941CC83C25780C9c72FB4F6274A4A3",
"0xdFD9e186b8D8A9000cBeE47BE14310a43Bdf602e","0xe8Ad7bbA862002414566a3e28f664E8BeA7F5ad5",
"0xF1AD812938B7a57Bb1B5E9E34C0ACb9B12Bdf8d3","0xF28D6416Bdf5dC272B08BCA98761a0b3b94c0a5E",
"0xF6193F6Cd1133e725B981DFb47ff4373fCD9131F","0xf675bA5425e23ed1DEB2a481C7e499a956e237dd",
];

const usd = v => "$" + (Number(v) / 1e6).toFixed(2);

async function main() {
  const addrs = JSON.parse(fs.readFileSync(path.join(__dirname, ADDRESSES_FILE), "utf8"));
  const [deployer] = await ethers.getSigners();
  const usdc = await ethers.getContractAt("MockUSDC", addrs.usdc || addrs.USDC, deployer);
  const owner = await usdc.owner();
  console.log(`Funder (deployer): ${deployer.address} | USDC owner: ${owner}${DRY ? "  [DRY RUN]" : ""}`);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error("deployer is not MockUSDC owner — cannot mint");
  }
  let nonce = await ethers.provider.getTransactionCount(deployer.address);
  let topped = 0, skipped = 0, minted = 0n;
  for (const a of LEADERS) {
    const addr = ethers.getAddress(a);
    const bal  = BigInt(await usdc.balanceOf(addr));
    if (bal >= TARGET) {
      console.log(`  SKIP  ${addr}  already ${usd(bal)}`);
      skipped++;
      continue;
    }
    const need = TARGET - bal;
    if (DRY) {
      console.log(`  WOULD MINT ${usd(need)} -> ${addr}  (has ${usd(bal)})`);
    } else {
      const tx = await usdc.mint(addr, need, { nonce: nonce++ });
      await tx.wait();
      console.log(`  MINT  ${usd(need)} -> ${addr}  (had ${usd(bal)})  tx ${tx.hash.slice(0, 18)}…`);
    }
    topped++; minted += need;
    await new Promise(r => setTimeout(r, 150)); // pace under the RPC cap
  }
  console.log(`\nDone: ${topped} topped up (${usd(minted)} total minted), ${skipped} already at/above $30k, ${LEADERS.length} wallets checked.`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
