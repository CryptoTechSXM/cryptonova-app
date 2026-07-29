/**
 * fix_wiring_v8_28.js
 *
 * Recovery script for interrupted V8.28 deploy.
 * All core contracts deployed successfully. This script:
 *   1. Completes governance wiring on matrices / PairManagers / SF / BBR
 *   2. Grants CNOVA MINTER_ROLE + GOVERNOR_ROLE
 *   3. Deploys CommunityWallet + wires it everywhere
 *   4. Deploys CNOVADirectSale + wires it
 *   5. Writes deployed_addresses_v8_28.json
 *   6. Seeds W1 as T1 MatA root (if not already registered)
 *
 * All setGovernance / grantRole calls are idempotent — safe to re-run
 * if any partially completed.
 *
 * Run:
 *   npx hardhat run scripts/fix_wiring_v8_28.js --network baseSepolia
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

// ── Deployed addresses from the interrupted deploy ────────────────────────────
const USDC_ADDR     = "0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a";
const CNOVA_ADDR    = "0x5eFe45CC9A902c2d8Cae97Eec22BF10629e0FF47";
const TREASURY_ADDR = "0xE81E8606427d62A32C1809052aD579c2b8D0D44e";
const SF_ADDR       = "0x1Bcb0A0cfa161716Ad96B98d7eC6E8894E2773c0";
const BBR_ADDR      = "0x11eF1E1Ed241F6e9864bA31f003e3F3f5c2f2D13";
const TR_ADDR       = "0x4CAEf2333c4473f5ceFD05879D9578568B700475";
const MF_ADDR       = "0x22E105E69eD87dEc936e912718A1356AA432e8dc";
const KEEPER_ADDR   = "0x74e800B637a49635A5492ba2B6554FF21ba79C4d";
const GOV_ADDR      = "0xEF44f14E6257E36a7F0E306863eA7c87dEf3242C";
const LQ_RESERVE    = "0x961fDE5C78200891f36858B2940a2B6d4F1Af854";

const DEPLOYER_ADDR  = "0xCd0Af6a4116f2062c1594aDf34c1821D45175506";
const ACCOUNT_ONE    = "0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435";
const DEV_WALLET     = "0x7fc2158892F14b9A1fB6e39B788d4d08daF49C0a";
const OPS_WALLET     = "0xa23A0492A823a2FfB6D3998dDd487695F5ba4019";

const TIERS = {
  1:  { pm: "0xf6252FCBA7d4cdf2EA2d93FF5D0d77ecd3EF02ca", matA: "0xFc4C04a2a572D4233240500eFFb83cdCe67542aE", matB: "0x3c42aDFfF73cE5ce96467D964712df48313139f3", fee: 10n },
  2:  { pm: "0xF046C1E99A0665CE3ca768F54BE5519032c30918", matA: "0xB8ae94A1988bDF1A6a4bEefd82aE824fD926462a", matB: "0x76FaF66a98349baB084d626FFEe3F29A295D1ef2", fee: 25n },
  3:  { pm: "0xE6Af149901954C4c72e75aB6BaFb3Caf8c0227b4", matA: "0x1D651da57fFaa6A97D3715B8b871b3D2896B09Ff", matB: "0x5dDFf7f49869b41A53C25e6d785Cb7b92274c5D2", fee: 50n },
  4:  { pm: "0xf94aE8753a9019233A8fDB79BDBB27CdD530aD15", matA: "0x7d02b5399004ef4455CC9CE19F596cA1906C57FC", matB: "0xb351B1f4c17D7a0843A251a8f34e25bdF0616550", fee: 100n },
  5:  { pm: "0xE67C75097BAEb252CB40A0aF68ad4152e948Cae3", matA: "0xdab2EEAfe3a6A26b0548728b9Cf2aDf4751eB222", matB: "0xBfC252C2d932B209Ce9763a4561808e1C12Aa269", fee: 250n },
  6:  { pm: "0x251924b6cFDA6b4EC1Cf7d688Ef33EAB3D06C9A5", matA: "0x582f6a5E60C9d4BC71aC8B4688bDBc7277619534", matB: "0xb9DE92A12a9468D3173b427f80e46f13e9a11a92", fee: 500n },
  7:  { pm: "0x86aA5a48DF6CcF7Bf67F2552a915c469D8961564", matA: "0xDcfD5A513ceAD92685A2367A36E2c36eb70C7888", matB: "0x49E2785996f6EA3aa760C440627671cb1CF1ef06", fee: 1000n },
  8:  { pm: "0xB38C3caBC74357D04da8527c328e79A37EB9C97c", matA: "0x2fDC614Dc9a17B99B9ef7F500f6dDE3B87F715B5", matB: "0x2e097ec043a5Ea06037372D7FbD4B6af20479BA7", fee: 2500n },
  9:  { pm: "0x39B437b01e700BF95cB3049Ed10894Af905d2E85", matA: "0xB231528D4293d6664B1Fe038BD265782e599a941", matB: "0xb8F3da3c691220b0C81B67A750a7F03231EF25Ee", fee: 5000n },
  10: { pm: "0x8cc2380d4f44Ca05e3eFdf9128B17C625b948513", matA: "0xC713bDa52a8966F4a5fCB7914ffe2AfB4ae4F559", matB: "0x2897535fea613F795392117aF8871490E97E668D", fee: 10000n },
};

const UNIT = 1_000_000n;
const ADDRESSES_FILE = path.join(__dirname, "deployed_addresses_v8_28.json");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Safe call — catches "already known" and "nonce too low" RPC errors and retries once
async function safe(label, fn) {
  try {
    const tx = await fn();
    if (tx && tx.wait) await tx.wait();
    console.log(`  ✓  ${label}`);
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("already known") || msg.includes("nonce too low") || msg.includes("replacement fee too low")) {
      console.log(`  ⚠  ${label} — RPC conflict, retrying in 6s...`);
      await sleep(6000);
      try {
        const tx = await fn();
        if (tx && tx.wait) await tx.wait();
        console.log(`  ✓  ${label} (retry OK)`);
      } catch (e2) {
        console.log(`  ✗  ${label} FAILED: ${e2.reason || e2.message?.slice(0, 120)}`);
      }
    } else {
      // Likely already set / no-op revert — log and continue
      console.log(`  ℹ  ${label} skipped: ${e.reason || msg.slice(0, 120)}`);
    }
  }
  await sleep(1500); // brief gap between every call to avoid mempool collisions
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n── fix_wiring_v8_28.js ──────────────────────────────────────────");
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  GOV      : ${GOV_ADDR}`);
  console.log(`  KEEPER   : ${KEEPER_ADDR}`);
  console.log("─────────────────────────────────────────────────────────────────\n");

  // Contract handles
  const cnova       = await ethers.getContractAt("CNOVAToken",          CNOVA_ADDR,   deployer);
  const sf          = await ethers.getContractAt("StabilityFund",       SF_ADDR,      deployer);
  const bbr         = await ethers.getContractAt("CNOVABuybackReserve", BBR_ADDR,     deployer);
  const tierRouter  = await ethers.getContractAt("TierRouter",          TR_ADDR,      deployer);
  const keeper      = await ethers.getContractAt("MatrixKeeper",        KEEPER_ADDR,  deployer);
  const usdc        = await ethers.getContractAt("MockUSDC",            USDC_ADDR,    deployer);

  // ── 1. Governance wiring (idempotent) ─────────────────────────────────────
  console.log("── [1] Governance wiring ────────────────────────────────────────");
  await safe("keeper.setGovernance",     () => keeper.setGovernance(GOV_ADDR));
  await safe("tierRouter.setGovernance", () => tierRouter.setGovernance(GOV_ADDR));
  await safe("sf.setGovernance",         () => sf.setGovernance(GOV_ADDR));
  await safe("bbr.setGovernance",        () => bbr.setGovernance(GOV_ADDR));

  for (const [tNum, t] of Object.entries(TIERS)) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", t.matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", t.matB, deployer);
    const pm = await ethers.getContractAt("PairManagerV8",       t.pm,   deployer);
    await safe(`T${tNum} MatA.setGovernance`, () => mA.setGovernance(GOV_ADDR));
    await safe(`T${tNum} MatB.setGovernance`, () => mB.setGovernance(GOV_ADDR));
    await safe(`T${tNum} PM.setGovernance`,   () => pm.setGovernance(GOV_ADDR));
  }
  console.log("  ✓  All governance wiring complete\n");

  // ── 2. CNOVA role grants ──────────────────────────────────────────────────
  console.log("── [2] CNOVA role grants ────────────────────────────────────────");
  const MINTER_ROLE   = await cnova.MINTER_ROLE();
  const GOVERNOR_ROLE = await cnova.GOVERNOR_ROLE();

  for (const [tNum, t] of Object.entries(TIERS)) {
    await safe(`MINTER_ROLE → T${tNum} MatA`, () => cnova.grantRole(MINTER_ROLE, t.matA));
    await safe(`MINTER_ROLE → T${tNum} MatB`, () => cnova.grantRole(MINTER_ROLE, t.matB));
  }
  await safe("GOVERNOR_ROLE → V8Governance", () => cnova.grantRole(GOVERNOR_ROLE, GOV_ADDR));
  console.log("  ✓  All CNOVA roles granted\n");

  // ── 3. CommunityWallet ───────────────────────────────────────────────────
  console.log("── [3] CommunityWallet deploy + wiring ──────────────────────────");
  const CommunityWallet = await ethers.getContractFactory("CommunityWallet", deployer);
  const cw     = await CommunityWallet.deploy(USDC_ADDR, DEPLOYER_ADDR);
  await cw.waitForDeployment();
  const cwAddr = await cw.getAddress();
  console.log(`  ✓  CommunityWallet  ${cwAddr}`);

  await safe("cw.setEnrollor(TierRouter)", () => cw.setEnrollor(TR_ADDR));
  const CW_GOV_ROLE = await cw.GOVERNOR_ROLE();
  await safe("CW GOVERNOR_ROLE → V8Governance", () => cw.grantRole(CW_GOV_ROLE, GOV_ADDR));
  await safe("tierRouter.setCommunityWallet",   () => tierRouter.setCommunityWallet(cwAddr));
  await safe("sf.setCommunityWallet",            () => sf.setCommunityWallet(cwAddr));
  await safe("keeper.setCommunityWallet",        () => keeper.setCommunityWallet(cwAddr));

  for (const [tNum, t] of Object.entries(TIERS)) {
    const mA = await ethers.getContractAt("FigureEightMatrixV8", t.matA, deployer);
    const mB = await ethers.getContractAt("FigureEightMatrixV8", t.matB, deployer);
    await safe(`T${tNum} MatA.setCommunityWallet`, () => mA.setCommunityWallet(cwAddr));
    await safe(`T${tNum} MatB.setCommunityWallet`, () => mB.setCommunityWallet(cwAddr));
  }
  console.log("  ✓  CommunityWallet fully wired\n");

  // ── 4. CNOVADirectSale ────────────────────────────────────────────────────
  console.log("── [4] CNOVADirectSale deploy + wiring ──────────────────────────");
  const DS_SF_TARGET = 500n  * UNIT;
  const DS_LQ_TARGET = 1000n * UNIT;

  const CNOVADirectSale = await ethers.getContractFactory("CNOVADirectSale", deployer);
  const ds     = await CNOVADirectSale.deploy(
    USDC_ADDR, CNOVA_ADDR, TREASURY_ADDR, SF_ADDR, LQ_RESERVE, DS_SF_TARGET, DS_LQ_TARGET
  );
  await ds.waitForDeployment();
  const dsAddr = await ds.getAddress();
  console.log(`  ✓  CNOVADirectSale   ${dsAddr}`);

  const DIRECT_SALE_ROLE = await cnova.DIRECT_SALE_ROLE();
  await safe("DIRECT_SALE_ROLE → CNOVADirectSale", () => cnova.grantRole(DIRECT_SALE_ROLE, dsAddr));
  await safe("ds.setGovernance", () => ds.setGovernance(GOV_ADDR));
  console.log("  ✓  CNOVADirectSale wired\n");

  // ── 5. Write addresses file ───────────────────────────────────────────────
  console.log("── [5] Save addresses ───────────────────────────────────────────");
  const tierAddresses = {};
  for (const [t, v] of Object.entries(TIERS)) {
    tierAddresses[`T${t}`] = { pm: v.pm, matA: v.matA, matB: v.matB };
  }
  const out = {
    network: "baseSepolia",
    deployedAt: new Date().toISOString(),
    matrixSize: 127,
    deployer: DEPLOYER_ADDR, admin: DEPLOYER_ADDR,
    accountOne: ACCOUNT_ONE, devWallet: DEV_WALLET, opsWallet: OPS_WALLET,
    usdc: USDC_ADDR, cnova: CNOVA_ADDR, treasury: TREASURY_ADDR,
    stabilityFund: SF_ADDR, buybackReserve: BBR_ADDR, tierRouter: TR_ADDR,
    matrixFactory: MF_ADDR, matrixKeeper: KEEPER_ADDR,
    v8Governance: GOV_ADDR, communityWallet: cwAddr,
    liquidityReserve: LQ_RESERVE, directSale: dsAddr,
    tiers: tierAddresses,
  };
  fs.writeFileSync(ADDRESSES_FILE, JSON.stringify(out, null, 2));
  console.log(`  ✓  deployed_addresses_v8_28.json written\n`);

  // ── 6. W1 seed ────────────────────────────────────────────────────────────
  console.log("── [6] W1 seed ──────────────────────────────────────────────────");
  const w1Key = process.env.SEED_W1_KEY || process.env.W1_PRIVATE_KEY;
  if (!w1Key) {
    console.log("  ⚠  W1_PRIVATE_KEY not set — skipping. Run seed_w1.js manually.");
  } else {
    try {
      const w1Wallet = new ethers.Wallet(w1Key, ethers.provider);
      const W1_ADDR  = w1Wallet.address;
      const alreadyJoined = await tierRouter.globalJoined(W1_ADDR);
      if (alreadyJoined) {
        console.log(`  ✓  W1 (${W1_ADDR}) already registered — skip`);
      } else {
        const t1Fee = TIERS[1].fee * UNIT;
        const w1Eth = await ethers.provider.getBalance(W1_ADDR);
        if (w1Eth < ethers.parseEther("0.01")) {
          await (await deployer.sendTransaction({ to: W1_ADDR, value: ethers.parseEther("0.02") })).wait();
          console.log("  ↳  Funded W1 with 0.02 ETH");
        }
        await (await usdc.mint(W1_ADDR, t1Fee)).wait();
        await (await usdc.connect(w1Wallet).approve(TIERS[1].pm, t1Fee)).wait();
        await (await tierRouter.connect(w1Wallet).register(ethers.ZeroAddress, { gasLimit: 3_000_000 })).wait();
        console.log(`  ✓  W1 (${W1_ADDR}) registered as T1 MatA root`);
      }
      await safe("tierRouter.setDefaultReferrer(W1)", () => tierRouter.setDefaultReferrer(w1Wallet.address));
    } catch (e) {
      console.log(`  ⚠  W1 seed failed: ${e.reason || e.message?.slice(0, 120)}`);
      console.log("     Run scripts/seed_w1.js manually.");
    }
  }

  console.log("\n─────────────────────────────────────────────────────────────────");
  console.log("  V8.28 wiring complete.");
  console.log(`  MatrixKeeper : ${KEEPER_ADDR}`);
  console.log(`  T1 MatA      : ${TIERS[1].matA}`);
  console.log(`  T1 MatB      : ${TIERS[1].matB}`);
  console.log(`  SF           : ${SF_ADDR}`);
  console.log(`  V8Governance : ${GOV_ADDR}`);
  console.log(`  CW           : ${cwAddr}`);
  console.log(`  DirectSale   : ${dsAddr}`);
  console.log("─────────────────────────────────────────────────────────────────\n");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
