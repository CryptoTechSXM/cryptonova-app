"use strict";
/**
 * community_sim.js — Slow-drip community simulation for V8.30 community test
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers one HD-wallet member at a time with a random delay between each
 * join (default 1–5 minutes). Designed to mimic organic community growth so
 * the keeper, rescue system, SF, and coupon flow can all be tested under
 * realistic timing.
 *
 * What it does:
 *   1. Funds the next HD wallet with ETH + USDC
 *   2. Registers that wallet via TierRouter (referrer = AccountOne / W1)
 *   3. Waits a random MIN_DELAY–MAX_DELAY seconds
 *   4. Repeats until COUNT wallets are registered or you press Ctrl+C
 *
 * Env vars:
 *   COUNT=200         total members to simulate (default 200)
 *   HDR_OFFSET=0      BIP-44 start index (increment between runs)
 *   MIN_DELAY=60      min seconds between joins (default 60 = 1 min)
 *   MAX_DELAY=300     max seconds between joins (default 300 = 5 min)
 *   REFERRER=0x...    override referrer (default = AccountOne from addresses file)
 *   COUPON_CODE=      if set, first join uses this plaintext coupon code
 *
 * Run:
 *   npx hardhat run scripts/community_sim.js --network baseSepolia
 *
 * Stop cleanly: Ctrl+C — the script will finish the current member's TX
 * then exit gracefully.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { ethers }       = require("hardhat");
const { NonceManager } = require("ethers");
const fs               = require("fs");
const path             = require("path");
require("dotenv").config();

// ── Config ────────────────────────────────────────────────────────────────────
const ADDRESSES_FILE = path.join(
  __dirname,
  process.env.ADDRESSES_FILE || "deployed_addresses_v8_30.json"
);

const COUNT      = Number(process.env.COUNT      || 200);
const HDR_OFFSET = Number(process.env.HDR_OFFSET || 0);
const MIN_DELAY  = Number(process.env.MIN_DELAY  || 60);   // seconds
const MAX_DELAY  = Number(process.env.MAX_DELAY  || 300);  // seconds
const COUPON_CODE = process.env.COUPON_CODE || "";

// ETH to send each sim wallet for gas
const ETH_PER_WALLET  = ethers.parseEther("0.005");
// Extra buffer in case gas spikes — re-tops up if wallet falls below this
const ETH_MIN_BALANCE = ethers.parseEther("0.002");

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function fmt(usdc6) {
  return `$${(Number(usdc6) / 1e6).toFixed(2)}`;
}

function fmtTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    throw new Error(`Addresses file not found: ${ADDRESSES_FILE}\nRun deploy_v8.js first.`);
  }
  const addrs = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));

  const [deployer] = await ethers.getSigners();
  const funder     = new NonceManager(deployer);

  const usdc        = await ethers.getContractAt("IERC20",               addrs.usdc,                  deployer);
  const tierRouter  = await ethers.getContractAt("TierRouter",            addrs.tierRouter,             deployer);
  const t1MatA      = await ethers.getContractAt("FigureEightMatrixV8",   addrs.tiers.T1.matA,          deployer);

  const T1_FEE      = await t1MatA.ENTRY_FEE();
  const referrer    = process.env.REFERRER || addrs.accountOne;

  // Coupon setup
  let couponHash = ethers.ZeroHash;
  if (COUPON_CODE) {
    couponHash = ethers.keccak256(ethers.toUtf8Bytes(COUPON_CODE));
    log(`Coupon code set — will use on first registration (hash: ${couponHash.slice(0, 10)}…)`);
  }

  // Derive HD wallet mnemonic from DEPLOYER_PRIVATE_KEY's mnemonic if available,
  // otherwise use MNEMONIC env var directly
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    throw new Error("MNEMONIC env var required for HD wallet derivation");
  }
  const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic);

  log(`Community sim starting`);
  log(`  Addresses file : ${path.basename(ADDRESSES_FILE)}`);
  log(`  Count          : ${COUNT} members`);
  log(`  HDR offset     : ${HDR_OFFSET}`);
  log(`  Delay range    : ${fmtTime(MIN_DELAY)} – ${fmtTime(MAX_DELAY)}`);
  log(`  Entry fee      : ${fmt(T1_FEE)}`);
  log(`  Referrer       : ${referrer}`);
  log(`  Deployer       : ${deployer.address}`);
  log(`─────────────────────────────────────────────────────`);

  let stopped = false;
  process.on("SIGINT", () => {
    log("Ctrl+C received — stopping after current member…");
    stopped = true;
  });

  let succeeded = 0;
  let skipped   = 0;
  let failed    = 0;

  for (let i = 0; i < COUNT; i++) {
    if (stopped) break;

    const walletIndex = HDR_OFFSET + i;
    const path44      = `m/44'/60'/0'/0/${walletIndex}`;
    const wallet      = hdNode.derivePath(path44).connect(ethers.provider);
    const addr        = wallet.address;

    log(`── Member ${i + 1}/${COUNT} — wallet #${walletIndex} (${addr})`);

    try {
      // ── Fund with ETH ──
      const ethBal = await ethers.provider.getBalance(addr);
      if (ethBal < ETH_MIN_BALANCE) {
        const toSend = ETH_PER_WALLET - ethBal;
        await (await funder.sendTransaction({ to: addr, value: toSend })).wait();
        log(`  ↳ Funded ${ethers.formatEther(toSend)} ETH for gas`);
      } else {
        log(`  ↳ ETH balance sufficient (${ethers.formatEther(ethBal)} ETH)`);
      }

      // ── Fund with USDC ──
      const usdcBal = await usdc.balanceOf(addr);
      if (usdcBal < T1_FEE) {
        // Deployer transfers USDC from its own balance
        const toSend = T1_FEE - usdcBal;
        await (await usdc.connect(funder).transfer(addr, toSend)).wait();
        log(`  ↳ Funded ${fmt(toSend)} USDC`);
      } else {
        log(`  ↳ USDC balance sufficient (${fmt(usdcBal)})`);
      }

      // ── Approve USDC ──
      const walletSigner = wallet;
      const pmAddr       = addrs.tiers.T1.pm;  // T1 PairManager
      const allowance    = await usdc.allowance(addr, pmAddr);
      if (allowance < T1_FEE) {
        const usdcW = usdc.connect(walletSigner);
        await (await usdcW.approve(pmAddr, ethers.MaxUint256)).wait();
        log(`  ↳ USDC approved for PairManager`);
      }

      // ── Register ──
      const trW = tierRouter.connect(walletSigner);
      let tx;
      if (COUPON_CODE && i === 0 && couponHash !== ethers.ZeroHash) {
        // Use coupon on first registration only
        const matAW = t1MatA.connect(walletSigner);
        const usdcW = usdc.connect(walletSigner);
        await (await usdcW.approve(addrs.tiers.T1.matA, ethers.MaxUint256)).wait();
        tx = await matAW.registerWithCoupon(referrer, couponHash, { gasLimit: 800_000 });
        log(`  ↳ Registered WITH COUPON (${COUPON_CODE})`);
      } else {
        tx = await trW.register(1, referrer, { gasLimit: 800_000 });
        log(`  ↳ register() submitted`);
      }
      const receipt = await tx.wait();
      log(`  ↳ Confirmed — tx: ${receipt.hash.slice(0, 10)}… gas: ${receipt.gasUsed.toLocaleString()}`);

      // ── Quick status snapshot ──
      const t1Occ = await t1MatA.occupancy();
      log(`  ↳ T1 MatA occupancy: ${t1Occ}`);

      succeeded++;
    } catch (err) {
      const reason = err?.reason || err?.message?.split('\n')[0] || String(err);
      log(`  ✗ FAILED: ${reason}`);
      failed++;
    }

    if (!stopped && i < COUNT - 1) {
      const delay = randomDelay(MIN_DELAY, MAX_DELAY);
      log(`  ⏳ Next member in ${fmtTime(delay)}…`);
      log(`─────────────────────────────────────────────────────`);
      await sleep(delay);
    }
  }

  log(`═════════════════════════════════════════════════════`);
  log(`Community sim complete`);
  log(`  Succeeded : ${succeeded}`);
  log(`  Failed    : ${failed}`);
  log(`  Skipped   : ${skipped}`);
  log(`  Next HDR_OFFSET to use: ${HDR_OFFSET + succeeded + failed}`);
  log(`═════════════════════════════════════════════════════`);
}

main().catch(err => {
  console.error("\nFatal error:", err.message || err);
  process.exit(1);
});
