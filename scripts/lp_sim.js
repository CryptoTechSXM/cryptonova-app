/**
 * lp_sim.js
 * Simulate USDC/CNOVA AMM trading activity on the live CryptoNovaLP pool.
 * Shows price discovery, fee accumulation, LP value growth, and comparison
 * with the CNOVADirectSale bonding curve floor price.
 *
 * Reads LP pool address from deployed_addresses_lp.json.
 * Uses FILL_FUNDER_KEY wallet to send simulated trades via multiple sub-wallets.
 *
 * Usage:
 *   node scripts/lp_sim.js
 *   ROUNDS=20 BUY_SIZE=5 SELL_PCT=30 node scripts/lp_sim.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs          = require("fs");
const path        = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const LP_FILE   = path.join(__dirname, "../deployed_addresses_lp.json");
const ADDR_FILE = process.env.ADDRESSES_FILE
  ?? path.join(__dirname, "../deployed_addresses_v8_22.json");

const ROUNDS    = parseInt(process.env.ROUNDS   ?? "15");  // # of swap rounds
const BUY_SIZE  = parseFloat(process.env.BUY_SIZE ?? "10"); // USDC per buy swap
const SELL_PCT  = parseFloat(process.env.SELL_PCT  ?? "40"); // % of CNOVA held to sell back
const DELAY_MS  = parseInt(process.env.DELAY_MS   ?? "2000"); // ms between rounds

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const LP_ABI = [
  "function swapUSDCForCNOVA(uint256 usdcIn, uint256 minCnovaOut) returns (uint256)",
  "function swapCNOVAForUSDC(uint256 cnovaIn, uint256 minUsdcOut) returns (uint256)",
  "function getReserves() view returns (uint256 reserveUSDC, uint256 reserveCNOVA)",
  "function getCNOVAPrice() view returns (uint256)",
  "function quoteUSDCForCNOVA(uint256 usdcIn) view returns (uint256 cnovaOut, uint256 priceImpactBps)",
  "function getLPShare(address provider) view returns (uint256 shareBps)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function addLiquidity(uint256 usdcAmount, uint256 cnovaAmount) returns (uint256 lpMinted)",
];

const DIRECT_SALE_ABI = [
  "function getFloorPrice() view returns (uint256)",
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(n, dec, places = 4) {
  return parseFloat(ethers.formatUnits(n, dec)).toFixed(places);
}

function humanPrice(rU, rC) {
  // (reserveUSDC / 1e6) / (reserveCNOVA / 1e18)
  return (Number(rU) / 1e6) / (Number(rC) / 1e18);
}

function bar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load addresses
  if (!fs.existsSync(LP_FILE)) {
    throw new Error(`LP addresses not found. Run deploy_lp.js first.\nExpected: ${LP_FILE}`);
  }
  const lpAddrs  = JSON.parse(fs.readFileSync(LP_FILE,   "utf8"));
  const addrs    = JSON.parse(fs.readFileSync(ADDR_FILE, "utf8"));

  const LP_ADDR         = lpAddrs.lpPool;
  const USDC_ADDR       = addrs.usdc;
  const CNOVA_ADDR      = addrs.cnova;
  const DIRECT_SALE_ADDR= addrs.directSale;

  // RPC + signer (funder wallet)
  const RPC_URL     = process.env.BASE_SEPOLIA_RPC ?? process.env.RPC_URL;
  const FUNDER_KEY  = process.env.FILL_FUNDER_KEY;
  if (!RPC_URL)    throw new Error("BASE_SEPOLIA_RPC not set");
  if (!FUNDER_KEY) throw new Error("FILL_FUNDER_KEY not set");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const funder   = new ethers.Wallet(FUNDER_KEY, provider);

  // Derive 5 sim trader wallets from funder key (deterministic, no new keys)
  const traders = Array.from({ length: 5 }, (_, i) =>
    ethers.HDNodeWallet
      .fromMnemonic(ethers.Mnemonic.fromEntropy(ethers.id(FUNDER_KEY + i).slice(0, 34)))
      .connect(provider)
  );

  const usdc      = new ethers.Contract(USDC_ADDR,        ERC20_ABI,        funder);
  const cnova     = new ethers.Contract(CNOVA_ADDR,       ERC20_ABI,        funder);
  const lp        = new ethers.Contract(LP_ADDR,          LP_ABI,           funder);
  const directSale= DIRECT_SALE_ADDR
    ? new ethers.Contract(DIRECT_SALE_ADDR, DIRECT_SALE_ABI, provider)
    : null;

  const usdcDec  = Number(await usdc.decimals());
  const cnovaDec = Number(await cnova.decimals());
  const buyAmt   = ethers.parseUnits(String(BUY_SIZE), usdcDec);

  // ── Header ────────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║           CryptoNova LP Simulation (USDC/CNOVA)         ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  LP Pool    : ${LP_ADDR}`);
  console.log(`  Rounds     : ${ROUNDS}`);
  console.log(`  Buy size   : $${BUY_SIZE} USDC per round`);
  console.log(`  Sell back  : ${SELL_PCT}% of held CNOVA per round`);

  // ── Fund traders with USDC from funder ───────────────────────────────────
  console.log("\n⏳  Funding trader wallets with USDC...");
  const usdcPerTrader = ethers.parseUnits(String(BUY_SIZE * ROUNDS * 2), usdcDec);
  for (const t of traders) {
    const bal = await usdc.balanceOf(t.address);
    if (bal < usdcPerTrader) {
      const topup = usdcPerTrader - bal;
      const tx = await usdc.transfer(t.address, topup);
      await tx.wait();
    }
    // Fund ETH for gas
    const ethBal = await provider.getBalance(t.address);
    if (ethBal < ethers.parseEther("0.003")) {
      const tx = await funder.sendTransaction({
        to: t.address,
        value: ethers.parseEther("0.003"),
      });
      await tx.wait();
    }
  }
  console.log("✅  Traders funded\n");

  // ── Snapshot initial state ────────────────────────────────────────────────
  let [rU, rC] = await lp.getReserves();
  const initPrice = humanPrice(rU, rC);

  let floorPrice = null;
  if (directSale) {
    try {
      const fp = await directSale.getFloorPrice();
      floorPrice = parseFloat(ethers.formatUnits(fp, usdcDec));
    } catch (_) {}
  }

  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  Pool snapshot (before sim):`);
  console.log(`    USDC  reserve : ${fmt(rU, usdcDec, 2)} USDC`);
  console.log(`    CNOVA reserve : ${fmt(rC, cnovaDec, 2)} CNOVA`);
  console.log(`    AMM price     : $${initPrice.toFixed(6)} per CNOVA`);
  if (floorPrice) {
  console.log(`    Bonding floor : $${floorPrice.toFixed(6)} per CNOVA`);
  console.log(`    AMM premium   : ${(((initPrice / floorPrice) - 1) * 100).toFixed(2)}%`);
  }
  console.log("─────────────────────────────────────────────────────────────\n");

  // ── Price history ─────────────────────────────────────────────────────────
  const priceHistory = [initPrice];
  let totalBuys = 0, totalSells = 0;
  let totalUsdcVolume = 0, totalCnovaVolume = 0;

  // ── Simulation rounds ─────────────────────────────────────────────────────
  for (let round = 1; round <= ROUNDS; round++) {
    const trader = traders[round % traders.length];
    const traderLp = lp.connect(trader);
    const traderUsdc = usdc.connect(trader);
    const traderCnova = cnova.connect(trader);
    const lpAddr = LP_ADDR;

    // ── BUY: USDC → CNOVA ─────────────────────────────────────────────────
    try {
      await traderUsdc.approve(lpAddr, buyAmt);
      const [quotedCnova, impactBps] = await lp.quoteUSDCForCNOVA(buyAmt);
      const minOut = quotedCnova * 95n / 100n; // 5% slippage tolerance
      const tx = await traderLp.swapUSDCForCNOVA(buyAmt, minOut);
      await tx.wait();
      totalBuys++;
      totalUsdcVolume += BUY_SIZE;
    } catch (e) {
      console.log(`  ⚠️  Buy round ${round} failed: ${e.message.slice(0, 60)}`);
    }

    // ── SELL: CNOVA → USDC (partial) ──────────────────────────────────────
    try {
      const cBal = await cnova.balanceOf(trader.address);
      if (cBal > 0n) {
        const sellAmt = cBal * BigInt(Math.round(SELL_PCT)) / 100n;
        if (sellAmt > 0n) {
          await traderCnova.approve(lpAddr, sellAmt);
          const tx = await traderLp.swapCNOVAForUSDC(sellAmt, 0n);
          await tx.wait();
          totalSells++;
          totalCnovaVolume += parseFloat(ethers.formatUnits(sellAmt, cnovaDec));
        }
      }
    } catch (e) {
      console.log(`  ⚠️  Sell round ${round} failed: ${e.message.slice(0, 60)}`);
    }

    // ── Print round stats ──────────────────────────────────────────────────
    [rU, rC] = await lp.getReserves();
    const price = humanPrice(rU, rC);
    priceHistory.push(price);

    const priceChange = ((price / initPrice) - 1) * 100;
    const direction   = price >= (priceHistory[priceHistory.length - 2] ?? price) ? "↑" : "↓";

    console.log(
      `  Round ${String(round).padStart(2)} | ` +
      `USDC: ${fmt(rU, usdcDec, 0).padStart(7)} | ` +
      `CNOVA: ${fmt(rC, cnovaDec, 0).padStart(9)} | ` +
      `Price: $${price.toFixed(6)} ${direction} | ` +
      `Δ: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%`
    );

    await sleep(DELAY_MS);
  }

  // ── Final state ───────────────────────────────────────────────────────────
  [rU, rC] = await lp.getReserves();
  const finalPrice = humanPrice(rU, rC);
  const lpSupply   = await lp.totalSupply();
  const funderLpBal= await lp.balanceOf(funder.address);
  const funderShare= funderLpBal > 0n
    ? Number((funderLpBal * 10_000n) / lpSupply) / 100
    : 0;

  // Funder's current entitlement
  const funderUSDC  = funderLpBal > 0n ? rU * funderLpBal / lpSupply : 0n;
  const funderCNOVA = funderLpBal > 0n ? rC * funderLpBal / lpSupply : 0n;

  const priceMin = Math.min(...priceHistory);
  const priceMax = Math.max(...priceHistory);
  const priceRange = priceMax - priceMin;

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    Simulation Complete                   ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  console.log("\n  📊  Price Chart (AMM spot price per CNOVA):");
  priceHistory.forEach((p, i) => {
    const pct = priceRange > 0 ? ((p - priceMin) / priceRange) * 100 : 50;
    const lbl = i === 0 ? "seed" : `r${String(i).padStart(2)}`;
    console.log(`  ${lbl.padStart(4)} $${p.toFixed(6)}  ${bar(pct)}`);
  });

  console.log("\n  📈  Pool Summary:");
  console.log(`    USDC  reserve : ${fmt(rU, usdcDec, 2)} USDC`);
  console.log(`    CNOVA reserve : ${fmt(rC, cnovaDec, 2)} CNOVA`);
  console.log(`    AMM price now : $${finalPrice.toFixed(6)}`);
  console.log(`    Init price    : $${initPrice.toFixed(6)}`);
  console.log(`    Price change  : ${((finalPrice / initPrice - 1) * 100).toFixed(2)}%`);
  console.log(`    Price low     : $${priceMin.toFixed(6)}`);
  console.log(`    Price high    : $${priceMax.toFixed(6)}`);

  if (floorPrice) {
    const premium = ((finalPrice / floorPrice) - 1) * 100;
    console.log(`\n  ⚖️   vs Bonding Curve Floor ($${floorPrice.toFixed(6)}):`);
    console.log(`    AMM ${premium >= 0 ? "premium" : "discount"}: ${Math.abs(premium).toFixed(2)}%`);
    if (premium < 0) {
      console.log(`    ⚡ Arb opportunity: buy AMM, sell to DirectSale`);
    } else {
      console.log(`    ✅ AMM trades above floor — healthy demand signal`);
    }
  }

  console.log("\n  🔄  Volume:");
  console.log(`    Buy  rounds : ${totalBuys}  (~$${(totalUsdcVolume).toFixed(2)} USDC)`);
  console.log(`    Sell rounds : ${totalSells}  (~${totalCnovaVolume.toFixed(2)} CNOVA)`);

  if (funderLpBal > 0n) {
    console.log("\n  💎  Funder LP Position:");
    console.log(`    LP tokens  : ${ethers.formatUnits(funderLpBal, 18)}`);
    console.log(`    Pool share : ${funderShare.toFixed(2)}%`);
    console.log(`    USDC value : ${fmt(funderUSDC, usdcDec, 2)} USDC`);
    console.log(`    CNOVA value: ${fmt(funderCNOVA, cnovaDec, 2)} CNOVA`);
  }

  console.log("\n✅  lp_sim.js complete.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
