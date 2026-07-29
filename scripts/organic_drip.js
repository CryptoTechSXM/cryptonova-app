"use strict";
/**
 * organic_drip.js — V8.36 Slow-drip organic growth simulation
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers one wallet every 2–5 minutes (random), mimicking real member growth.
 * After each registration it scans recent wallets for parked members and
 * upgrade-eligible members and handles both automatically.
 *
 * Rules:
 *   ✅  One registration at a time with 2–5 min random delay
 *   ✅  $700 USDC minted per wallet (enough for T1 → T6 journey)
 *   ✅  selfRescue()    — called FROM the member wallet when parked
 *   ✅  manualUpgrade() — called FROM the member wallet when gate open + cycled out
 *   ❌  NO forceCross  — keeper handles automation
 *   ❌  NO CNOVA buy / sell
 *
 * Env vars (in /root/keeper/.env):
 *   FILL_MNEMONIC         BIP-44 mnemonic for fill wallets (required)
 *   DEPLOYER_PRIVATE_KEY  MockUSDC owner — mints USDC + funds ETH (required)
 *   BASE_SEPOLIA_RPC      Base Sepolia RPC URL (required)
 *   ADDRESSES_FILE        deployed_addresses_v8_36.json (default)
 *   HDR_OFFSET=0          BIP-44 start index (default 0)
 *   COUNT=500             Total wallets to register (default 500)
 *   DELAY_MIN=2           Min minutes between regs (default 2)
 *   DELAY_MAX=5           Max minutes between regs (default 5)
 *   USDC_PER_WALLET=700   USDC $ per wallet (default 700)
 *   SCAN_WINDOW=30        Wallets to scan per round (default 30)
 *
 * Run on VPS:
 *   tmux new -s drip
 *   cd /root/keeper
 *   node organic_drip.js 2>&1 | tee -a organic_drip.log
 *   Ctrl+B D  ← detach;  tmux attach -t drip  ← re-attach
 *
 * Continue: HDR_OFFSET=500 node organic_drip.js
 */

const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const ADDR_FILE    = process.env.ADDRESSES_FILE   || "deployed_addresses_v8_36.json";
const HDR_OFFSET   = Number(process.env.HDR_OFFSET     ?? 0);
const COUNT        = Number(process.env.COUNT          ?? 500);
const DELAY_MIN_MS = Number(process.env.DELAY_MIN      ?? 2) * 60_000;
const DELAY_MAX_MS = Number(process.env.DELAY_MAX      ?? 5) * 60_000;
const USDC_PER_WAL = BigInt(Number(process.env.USDC_PER_WALLET ?? 700) * 1_000_000);
const SCAN_WINDOW  = Number(process.env.SCAN_WINDOW    ?? 30);
const ETH_PER_WAL  = ethers.parseEther("0.01");

const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];
const TR_ABI = [
  "function register(address referrer) external",
  "function globalJoined(address) external view returns (bool)",
  "function memberHighestTier(address) external view returns (uint8)",
  "function manualUpgrade(uint8 targetTierIndex) external",
  "function tierVelocityGreen(uint8 tierIndex) external view returns (bool)",
];
const MAT_ABI = [
  "function parkedAt(address) external view returns (uint256)",
  "function getMember(address) external view returns (tuple(bool hasEverJoined, bool isInMatrix, uint256 id, address referrer, uint256 totalEarned, uint256 withdrawable, uint256 totalWithdrawn, uint32 cyclesCompleted))",
  "function selfRescue() external",
  "function ENTRY_FEE() external view returns (uint256)",
  "function crossingReserveOf(address) external view returns (uint256)",
  "function occupancy() external view returns (uint256)",
];
const PM_ABI = ["function ENTRY_FEE() external view returns (uint256)"];

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const fmt6   = n  => "$" + (Number(n) / 1_000_000).toFixed(2);
const ts     = () => new Date().toISOString().slice(11, 19) + "Z";
const short  = a  => a.slice(0, 10) + "…";
const randMs = () => DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);

function makeWallet(index, provider) {
  const mnemo = process.env.FILL_MNEMONIC;
  if (!mnemo) throw new Error("FILL_MNEMONIC not set in .env");
  return ethers.HDNodeWallet
    .fromPhrase(mnemo, undefined, `m/44'/60'/0'/0/${index + HDR_OFFSET}`)
    .connect(provider);
}

async function checkRescues(scanWallets, allMats, usdc, tr) {
  for (const { wallet, address } of scanWallets) {
    let highestTier = 1;
    try { highestTier = Number(await tr.memberHighestTier(address)); } catch (_) {}

    for (const mat of allMats.filter(m => m.tier <= highestTier)) {
      let parkedAt = 0n;
      try { parkedAt = await mat.contract.parkedAt(address); } catch (_) { continue; }
      if (parkedAt === 0n) continue;

      const fee     = await mat.contract.ENTRY_FEE().catch(() => 0n);
      const reserve = await mat.contract.crossingReserveOf(address).catch(() => 0n);
      const bal     = await usdc.balanceOf(address).catch(() => 0n);
      const avail   = bal + reserve;

      if (avail < fee) {
        const topUp = fee - avail + fee / 10n;
        try {
          await (await usdc.mint(address, topUp)).wait();
          console.log(`  [${ts()}]   ⛽ rescue top-up ${short(address)} +${fmt6(topUp)} (${mat.label})`);
        } catch (_) { continue; }
      }

      try {
        await (await mat.contract.connect(wallet).selfRescue({ gasLimit: 15_000_000 })).wait();
        console.log(`  [${ts()}]   🛟 selfRescue OK  ${short(address)}  ${mat.label}`);
        break;
      } catch (e) {
        const r = (e.shortMessage || e.message || "").slice(0, 70);
        if (!r.toLowerCase().includes("not park"))
          console.log(`  [${ts()}]   ⚠ selfRescue skip ${short(address)}: ${r}`);
      }
    }
  }
}

async function checkUpgrades(scanWallets, allMats, usdc, tr, tiers, provider) {
  for (const { wallet, address } of scanWallets) {
    let highestTier = 1;
    try { highestTier = Number(await tr.memberHighestTier(address)); } catch (_) { continue; }
    if (highestTier >= 10) continue;

    const nextTier    = highestTier + 1;
    const nextTierIdx = nextTier - 1;

    let gateOpen = false;
    try { gateOpen = await tr.tierVelocityGreen(nextTierIdx); } catch (_) { continue; }
    if (!gateOpen) continue;

    let inAnyMatrix = false;
    for (const mat of allMats.filter(m => m.tier === highestTier)) {
      try { const mem = await mat.contract.getMember(address); if (mem.isInMatrix) { inAnyMatrix = true; break; } } catch (_) {}
    }
    if (inAnyMatrix) continue;

    const nextKey = `T${nextTier}`;
    if (!tiers[nextKey]) continue;
    const upgFee = await new ethers.Contract(tiers[nextKey].pm, PM_ABI, provider).ENTRY_FEE().catch(() => 0n);
    if (upgFee === 0n) continue;

    const bal = await usdc.balanceOf(address).catch(() => 0n);
    if (bal < upgFee) {
      const needed = upgFee - bal + upgFee / 10n;
      try { await (await usdc.mint(address, needed)).wait(); console.log(`  [${ts()}]   ⛽ upgrade top-up ${short(address)} +${fmt6(needed)} -> T${nextTier}`); }
      catch (_) { continue; }
    }

    const usdcAddr   = await usdc.getAddress();
    const usdcMember = new ethers.Contract(usdcAddr, USDC_ABI, wallet);
    if ((await usdcMember.allowance(address, tiers[nextKey].pm).catch(() => 0n)) < upgFee) {
      try { await (await usdcMember.approve(tiers[nextKey].pm, ethers.MaxUint256, { gasLimit: 80_000 })).wait(); }
      catch (_) { continue; }
    }

    try {
      await (await tr.connect(wallet).manualUpgrade(nextTierIdx, { gasLimit: 15_000_000 })).wait();
      console.log(`  [${ts()}]   ⬆️  manualUpgrade T${highestTier} -> T${nextTier}  ${short(address)}`);
    } catch (e) {
      const r = (e.shortMessage || e.message || "").slice(0, 70);
      if (!r.includes("not eligible") && !r.includes("velocity") && !r.includes("revert"))
        console.log(`  [${ts()}]   ⚠ upgrade skip ${short(address)}: ${r}`);
    }
  }
}

async function main() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC || process.env.BASE_SEPOLIA_RPC_URL;
  if (!rpcUrl)                           throw new Error("BASE_SEPOLIA_RPC not set");
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  if (!process.env.FILL_MNEMONIC)        throw new Error("FILL_MNEMONIC not set");

  const provider = new ethers.JsonRpcProvider(rpcUrl, 84532, { staticNetwork: true });
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const addrPath = path.join(__dirname, ADDR_FILE);
  if (!fs.existsSync(addrPath)) throw new Error(`Not found: ${addrPath}`);
  const addrs   = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  const TIERS   = addrs.tiers || {};
  const W1_ADDR = addrs.accountOne;
  const TR_ADDR = addrs.tierRouter;
  const USDC_ADDR = addrs.usdc;

  if (!TIERS.T1 || !TR_ADDR || !USDC_ADDR || !W1_ADDR)
    throw new Error("Addresses file missing required fields (tiers.T1 / tierRouter / usdc / accountOne)");

  const usdc = new ethers.Contract(USDC_ADDR, USDC_ABI, deployer);
  const tr   = new ethers.Contract(TR_ADDR,   TR_ABI,   provider);

  const allMats = [];
  for (let t = 1; t <= 10; t++) {
    const key = `T${t}`;
    if (!TIERS[key]) continue;
    const { matA, matB } = TIERS[key];
    if (matA) allMats.push({ tier: t, label: `T${t}A`, contract: new ethers.Contract(matA, MAT_ABI, provider) });
    if (matB) allMats.push({ tier: t, label: `T${t}B`, contract: new ethers.Contract(matB, MAT_ABI, provider) });
  }

  const T1_FEE    = await new ethers.Contract(TIERS.T1.pm, PM_ABI, provider).ENTRY_FEE();
  const deployBal = await provider.getBalance(deployer.address);
  const estHrs    = ((COUNT * (DELAY_MIN_MS + DELAY_MAX_MS) / 2) / 3_600_000).toFixed(1);

  console.log(`\n  ======================================================`);
  console.log(`  organic_drip.js — V8.36 Organic Growth Simulation`);
  console.log(`  ======================================================`);
  console.log(`  Deployer:    ${deployer.address}`);
  console.log(`               ${ethers.formatEther(deployBal)} ETH`);
  console.log(`  W1/referrer: ${W1_ADDR}`);
  console.log(`  Wallets:     ${COUNT}  (BIP-44 offset ${HDR_OFFSET}–${HDR_OFFSET + COUNT - 1})`);
  console.log(`  Delay:       ${DELAY_MIN_MS/60000}–${DELAY_MAX_MS/60000} min random  (~${estHrs}h total)`);
  console.log(`  USDC/wallet: ${fmt6(USDC_PER_WAL)}  |  T1 fee: ${fmt6(T1_FEE)}`);
  console.log(`  Scan window: last ${SCAN_WINDOW} wallets`);
  console.log(`  Started:     ${new Date().toLocaleString()}`);
  console.log(`  NO forceCross. NO CNOVA activity. Keeper handles automation.`);
  console.log(`  ======================================================\n`);

  if (!(await tr.globalJoined(W1_ADDR).catch(() => false))) {
    console.error("  W1 not registered — run seed_w1.js first"); process.exit(1);
  }
  console.log(`  W1 confirmed registered\n`);

  const reg       = { ok: 0, skip: 0, fail: 0 };
  const walletPool = [];
  const startTime  = Date.now();
  const PAD        = String(COUNT).length;

  for (let i = 0; i < COUNT; i++) {
    const wallet = makeWallet(i, provider);
    const addr   = wallet.address;
    const num    = `${String(i + 1).padStart(PAD)}/${COUNT}`;
    const shortA = short(addr);

    if (await tr.globalJoined(addr).catch(() => false)) {
      console.log(`  [${ts()}] ${num}  ${shortA}  SKIP`);
      walletPool.push({ wallet, address: addr }); reg.skip++; continue;
    }

    // ETH
    if ((await provider.getBalance(addr)) < ETH_PER_WAL / 2n) {
      process.stdout.write(`  [${ts()}] ${num}  ${shortA}  ETH...`);
      try { await (await deployer.sendTransaction({ to: addr, value: ETH_PER_WAL })).wait(); process.stdout.write(" OK\n"); }
      catch (e) { process.stdout.write(` FAIL: ${(e.shortMessage||e.message||"").slice(0,40)}\n`); reg.fail++; continue; }
    }

    // USDC
    const usdcBal = await usdc.balanceOf(addr);
    if (usdcBal < USDC_PER_WAL) {
      process.stdout.write(`  [${ts()}] ${num}  ${shortA}  USDC mint...`);
      try { await (await usdc.mint(addr, USDC_PER_WAL - usdcBal)).wait(); process.stdout.write(" OK\n"); }
      catch (e) { process.stdout.write(` FAIL: ${(e.shortMessage||e.message||"").slice(0,40)}\n`); reg.fail++; continue; }
    }

    // Approve
    if ((await usdc.allowance(addr, TIERS.T1.pm)) < T1_FEE) {
      process.stdout.write(`  [${ts()}] ${num}  ${shortA}  approve...`);
      try { await (await new ethers.Contract(USDC_ADDR, USDC_ABI, wallet).approve(TIERS.T1.pm, ethers.MaxUint256, { gasLimit: 80_000 })).wait(); process.stdout.write(" OK\n"); }
      catch (e) { process.stdout.write(` FAIL: ${(e.shortMessage||e.message||"").slice(0,40)}\n`); reg.fail++; continue; }
    }

    // Register
    let regOk = false;
    process.stdout.write(`  [${ts()}] ${num}  ${shortA}  register...`);
    try {
      await (await tr.connect(wallet).register(W1_ADDR, { gasLimit: 10_000_000 })).wait();
      reg.ok++; regOk = true; process.stdout.write(" OK\n");
    } catch (e) {
      process.stdout.write(` FAIL: ${(e.shortMessage||e.message||"").slice(0,70)}\n`); reg.fail++;
    }

    if (regOk) walletPool.push({ wallet, address: addr });

    // Snapshot
    try {
      const tA1 = allMats.find(m => m.label === "T1A");
      const tB1 = allMats.find(m => m.label === "T1B");
      if (tA1 && tB1) {
        const [oA, oB, w1t] = await Promise.all([tA1.contract.occupancy(), tB1.contract.occupancy(), tr.memberHighestTier(W1_ADDR)]);
        console.log(`  [${ts()}]   T1 MatA ${oA}/127  MatB ${oB}/127  W1->T${w1t}  ok:${reg.ok} skip:${reg.skip} fail:${reg.fail}  +${Math.round((Date.now()-startTime)/60000)}m`);
      }
    } catch (_) {}

    // Scan
    const scan = walletPool.slice(-SCAN_WINDOW);
    await checkRescues(scan, allMats, usdc, tr);
    await checkUpgrades(scan, allMats, usdc, tr, TIERS, provider);

    // Delay
    if (i < COUNT - 1) {
      const ms = randMs();
      const sec = Math.round(ms / 1000);
      console.log(`  [${ts()}]   next in ${(sec/60).toFixed(1)} min -> ${new Date(Date.now()+ms).toLocaleTimeString()}\n`);
      await sleep(ms);
    }
  }

  const totalMin = Math.round((Date.now() - startTime) / 60000);
  console.log(`\n  ======================================================`);
  console.log(`  DRIP COMPLETE  ok:${reg.ok}  skip:${reg.skip}  fail:${reg.fail}  ${totalMin}m`);
  console.log(`  Next: HDR_OFFSET=${HDR_OFFSET + COUNT} node organic_drip.js`);
  console.log(`  ======================================================\n`);
}

main().catch(e => { console.error("\n  FATAL:", e.message || e); process.exit(1); });
