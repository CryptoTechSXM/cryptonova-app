"use strict";
/**
 * V8_46_CreditPreservation.test.js — item 8. Entering a tier where you already
 * hold referral commission must NOT destroy the balance.
 *
 * WHAT THIS IS A REGRESSION FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-07-29. The owner reported "withdrew $1k twice but Total Withdrawn is
 * wrong". Reconciling USDC inflows against the per-matrix ledgers gave
 * $1,970.00 received = $2,000.00 gross x 0.985, against a stored total of
 * $1,947.50 — short exactly $52.50. Sixteen payouts, fifteen reconciled to the
 * cent. T3.1 MatA paid $51.71 net with totalWithdrawn reading $0.00.
 *
 * The receipt (tx 0xb11eee58) removed all doubt: withdrawPartial(uint256) with
 * arg $52.50, WithdrawalFeeCharged $0.79 AND EarningsWithdrawn $51.71, status
 * SUCCESS. So withdrawCore ran and the counter WAS incremented at :996. It was
 * zeroed afterwards — withdrawal at block 44796516 (~21:40 UTC), joinedAt now
 * 23:30:02 UTC, nearly two hours later.
 *
 * ROOT CAUSE: _register read `!hasEverJoined` as "no record exists yet" and built
 * a fresh Member struct with withdrawable/totalEarned/totalWithdrawn/
 * crossingReserve all 0. The flag actually means "never took a SEAT here". Two
 * paths write real values without setting it:
 *
 *   _credit (:928)     adds withdrawable + totalEarned. Referral commission is
 *                      credited into the matrix where the member's DOWNLINE
 *                      entered, so every upline accrues a genuine claim in tiers
 *                      they have never occupied.
 *   withdrawCore(:948) gates on `require(available > 0)`, never on membership,
 *                      so that holder can withdraw — incrementing totalWithdrawn
 *                      while hasEverJoined is still false.
 *
 * So entering that tier later overwrote live money. The owner lost only the
 * RECORD because he had already withdrawn; had he entered first, the balance
 * itself would have been deleted, with the USDC left in the matrix as
 * unattributed surplus and no claim against it.
 *
 * WHY THE FIXTURE LOOKS THE WAY IT DOES
 * ─────────────────────────────────────────────────────────────────────────────
 * The production shape is cross-TIER: the upline is globalJoined in TierRouter
 * (they are a member of the system) but has never joined that particular tier's
 * matrix. A single-tier fixture reproduces that exactly using the existing owner
 * helper TierRouter.setGlobalJoined — which is what makes _register resolve the
 * referrer as l1 (:327-330, the V8.36 cross-pair rule) and therefore credit a
 * member who holds no seat here. No impersonation of the credit itself and no
 * storage poking: the commission is earned through the real payment path.
 *
 * C1 is the fund-loss case and FAILS on V8.45.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const FEE  = 10_000_000n;
const SIZE = 4;

async function deployTier() {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(await cnova.getAddress(), await usdc.getAddress(), owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(await usdc.getAddress(), owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter"))
    .deploy(await usdc.getAddress(), owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(await usdc.getAddress(), FEE, owner.address);

  const dp = {
    usdc: await usdc.getAddress(), cnova: await cnova.getAddress(),
    treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const lib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  await lib.waitForDeployment();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await lib.getAddress() },
  });

  const matA = await MX.deploy(dp, FEE, SIZE, true,  0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, SIZE, false, 0, SPLITS, CP_BPS);
  await matA.setPartner(await matB.getAddress());
  await matB.setPartner(await matA.getAddress());
  for (const m of [matA, matB]) {
    await m.setPairManager(await pm.getAddress());
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await pm.addPair(await matA.getAddress(), await matB.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, await pm.getAddress(), FEE);
  await tr.setTierMatrices(0, await matA.getAddress(), await matB.getAddress());
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(await tr.getAddress());
  await pm.setEntryThresholds(1, 2);
  // W1 (accountOne) is the fallback sponsor for everyone. In production it IS a
  // registered member, so _register's l1 resolution (:324-331) finds it. Without
  // this the fixture silently produces referrer == address(0) for every entrant
  // and any assertion about referrers tests nothing. Found the hard way.
  await tr.setGlobalJoined(W1.address, true);
  return { usdc, tr, pm, matA, matB, owner, W1, pmAddr: await pm.getAddress() };
}

async function newWallet(ctx) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
  return w;
}

/** Seat `member` into `matrix` by impersonating the PairManager, exactly as
 *  PairManagerV8.registerFor does. Same helper the pair-guard suite uses. */
async function forceSeat(ctx, matrix, member, referrer) {
  const addr = await matrix.getAddress();
  await ctx.usdc.mint(ctx.owner.address, FEE);
  await ctx.usdc.connect(ctx.owner).transfer(addr, FEE);
  await ethers.provider.send("hardhat_impersonateAccount", [ctx.pmAddr]);
  await ethers.provider.send("hardhat_setBalance",
    [ctx.pmAddr, "0x" + (10n ** 20n).toString(16)]);
  const pmSigner = await ethers.getSigner(ctx.pmAddr);
  const tx = await matrix.connect(pmSigner).enterFor(member, referrer, { gasLimit: 16_000_000 });
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [ctx.pmAddr]);
  return tx;
}

/**
 * Produce the exact production state: `upline` holds referral commission in
 * matA and has NEVER taken a seat there.
 *
 * setGlobalJoined is the owner helper TierRouter already exposes (:1657). It is
 * what makes _register's cross-pair referrer rule (:327-330) resolve the upline
 * as l1 without the upline holding a seat in this matrix — which is precisely
 * the production situation, where the upline is a member of the system but has
 * never entered THIS tier.
 */
async function creditUplineWithoutSeating(ctx, upline) {
  await ctx.tr.setGlobalJoined(upline.address, true);
  const downline = await newWallet(ctx);
  await forceSeat(ctx, ctx.matA, downline.address, upline.address);

  const rec = await ctx.matA.getMember(upline.address);
  // The premise must hold or the test proves nothing. Assert it explicitly —
  // a fixture that silently fails to set up produces a passing test for the
  // wrong reason, which is how bypass_scan_full.js reported a confident zero
  // twice on 2026-07-29.
  expect(rec.hasEverJoined, "fixture: upline must NOT have joined matA").to.equal(false);
  expect(rec.withdrawable, "fixture: upline must hold commission in matA").to.be.gt(0n);
  return { downline, credited: rec.withdrawable, earned: rec.totalEarned };
}

describe("V8.46 item 8 — commission is preserved when the holder finally joins", function () {
  this.timeout(900_000);

  it("C1: joining a tier does NOT destroy a commission balance already held there", async () => {
    const ctx = await deployTier();
    const upline = await newWallet(ctx);
    const { credited } = await creditUplineWithoutSeating(ctx, upline);

    // THE FIX. Pre-V8.46 _register built a fresh struct here and this balance
    // went to zero — real money, with the USDC left in the matrix unattributed.
    await forceSeat(ctx, ctx.matA, upline.address, ctx.W1.address);

    const after = await ctx.matA.getMember(upline.address);
    expect(after.hasEverJoined).to.equal(true);
    // GTE, not EQUAL. Taking a seat legitimately earns — the entrant picks up a
    // pool share from their own entry, measured here as +$0.25 on a $10 fee. The
    // claim under test is that the PRE-EXISTING credit was not destroyed, so the
    // floor is what they already held. On V8.45 this read $0.25: the fresh struct
    // wiped the $0.95 and left only the new share, which is exactly the failure.
    expect(after.withdrawable, "commission balance must survive entry").to.be.gte(credited);
  });

  it("C2: withdrawal history survives entry (the measured 0xe8Ad7bbA case)", async () => {
    const ctx = await deployTier();
    const upline = await newWallet(ctx);
    await creditUplineWithoutSeating(ctx, upline);

    // A commission-only holder CAN withdraw: withdrawCore gates on
    // `available > 0`, not on membership. This is the step that made the live
    // case survivable — the money was already out when the reset landed.
    await ctx.matA.connect(upline).withdraw();
    const withdrawn = await ctx.matA.getMemberTotalWithdrawn(upline.address);
    expect(withdrawn, "the holder must be able to withdraw without a seat").to.be.gt(0n);
    expect((await ctx.matA.getMember(upline.address)).hasEverJoined,
      "withdrawing must NOT set hasEverJoined — that is the whole trap").to.equal(false);

    await forceSeat(ctx, ctx.matA, upline.address, ctx.W1.address);

    expect(await ctx.matA.getMemberTotalWithdrawn(upline.address),
      "totalWithdrawn must survive entry").to.equal(withdrawn);
  });

  it("C3: totalEarned survives entry", async () => {
    const ctx = await deployTier();
    const upline = await newWallet(ctx);
    const { earned } = await creditUplineWithoutSeating(ctx, upline);
    expect(earned).to.be.gt(0n);

    await forceSeat(ctx, ctx.matA, upline.address, ctx.W1.address);

    expect((await ctx.matA.getMember(upline.address)).totalEarned,
      "lifetime earnings must survive entry").to.be.gte(earned);
  });

  it("C4: a genuinely new member is still initialised correctly", async () => {
    // Guards against the fix breaking normal registration — the fields are now
    // written individually rather than as a struct, so the ordinary path has to
    // be re-proven, not assumed.
    const ctx = await deployTier();
    const fresh = await newWallet(ctx);

    const before = await ctx.matA.getMember(fresh.address);
    expect(before.hasEverJoined).to.equal(false);
    expect(before.id).to.equal(0n);

    await forceSeat(ctx, ctx.matA, fresh.address, ctx.W1.address);

    const after = await ctx.matA.getMember(fresh.address);
    expect(after.hasEverJoined).to.equal(true);
    expect(after.id, "id must be assigned").to.be.gt(0n);
    expect(after.joinedAt, "joinedAt must be set").to.be.gt(0n);
    expect(after.totalWithdrawn).to.equal(0n);
    expect(after.cyclesCompleted).to.equal(0n);
    expect(after.referrer, "referrer must be resolved on first entry").to.equal(ctx.W1.address);
    expect(await ctx.matA.isActiveInMatrix(fresh.address)).to.equal(true);
  });

  it("C5: the referrer guard still resolves an upline on first real entry", async () => {
    // This tests the RISK INTRODUCED BY THE FIX ITSELF. The old code assigned
    // `referrer: l1` unconditionally; the new code writes it only when the slot
    // is empty, so that a referrer already on file is never rewritten. If that
    // guard were wrong, a commission-only holder would enter with NO upline and
    // lose their entire chain-pay position — a worse bug than the one being fixed.
    //
    // A commission-only holder has referrer == address(0), because _credit never
    // builds the struct. So the guard must let the write through.
    const ctx = await deployTier();
    const upline = await newWallet(ctx);
    await creditUplineWithoutSeating(ctx, upline);

    expect((await ctx.matA.getMember(upline.address)).referrer,
      "fixture: a commission-only holder has no referrer yet").to.equal(ethers.ZeroAddress);

    await forceSeat(ctx, ctx.matA, upline.address, ctx.W1.address);

    expect((await ctx.matA.getMember(upline.address)).referrer,
      "the guard must not block the legitimate first write").to.equal(ctx.W1.address);
  });
});
