"use strict";
/**
 * V8_48_Permit.test.js — item 40's contract half: selfRescueWithPermit.
 *
 * THE MEMBER REPORT THIS RETIRES (@Lavern-Gay, Rabby, 2026-08-11, via BUGS.md):
 *   "I had to click both Approval and Self-Rescue several times, even though the
 *   transaction was marked as complete." Two transactions per parked position —
 *   approve to the MATRIX (a different spender per matrix), then selfRescue. The
 *   EIP-2612 permit folds the approval into a free off-chain signature: one
 *   transaction per position, half the clicks, no dangling approvals.
 *
 * DESIGN, mirrored from TierRouter.manualUpgradeWithPermit (:911) exactly:
 *   try permit {} catch {} then rescue. The catch is NOT sloppiness — a permit is
 *   front-runnable (anyone can submit your signature first) and single-use, so a
 *   griefed or already-consumed permit must not brick the rescue when the
 *   allowance is already in place. And if NEITHER the permit NOR a standing
 *   allowance covers the shortfall, the transfer inside selfRescue reverts with
 *   the token's own error — the failure mode stays loud (PW3 pins it).
 *
 * The body lives in MatrixLogicLib (linked): the factory embeds the matrix's
 * creation code and had 532 bytes of headroom after the 45/46/47 package — a
 * lib-side body costs it one thin wrapper instead of the whole function.
 *
 * Chain-side note: MockUSDC has ERC20Permit (V8.44 G1) and IS the deployed
 * testnet token. Native USDC on Base MAINNET is the one still-unverified claim —
 * scripts/probe_base_usdc_permit.js answers it; run it before mainnet leans on
 * this function.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const M6 = (n) => ethers.parseUnits(n.toString(), 6);
const FEE = 10_000_000n;
const RESERVE = FEE / 2n;

const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];

async function deployPair(size) {
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;
  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund"))
    .deploy(usdcAddr, owner.address);
  const trLib = await (await ethers.getContractFactory("TierRouterLib")).deploy();
  const tr = await (await ethers.getContractFactory("TierRouter",
      { libraries: { TierRouterLib: trLib.target } })).deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8"))
    .deploy(usdcAddr, FEE, owner.address);
  const pmAddr = await pm.getAddress();
  const dp = {
    usdc: usdcAddr, cnova: cnovaAddr, treasury: await treasury.getAddress(),
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8",
    { libraries: { MatrixLogicLib: await matrixLib.getAddress() } });
  const a = await MX.deploy(dp, FEE, size, true,  0, SPLITS, CP_BPS);
  const b = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
  await a.setPartner(await b.getAddress());
  await b.setPartner(await a.getAddress());
  for (const m of [a, b]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(await tr.getAddress());
    await m.setStabilityFund(await sf.getAddress());
    await m.setMatrixKeeper(owner.address);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
    await tr.registerMatrix(await m.getAddress(), 0);
  }
  await pm.addPair(await a.getAddress(), await b.getAddress());
  await pm.setTierRouter(await tr.getAddress());
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, await a.getAddress(), await b.getAddress());
  return { usdc, pm, pmAddr, tr, a, b, owner, W1, sigs,
           aAddr: await a.getAddress(), bAddr: await b.getAddress() };
}

async function reg(ctx, signer, referrer) {
  await ctx.usdc.mint(signer.address, FEE);
  await ctx.usdc.connect(signer).approve(ctx.pmAddr, FEE);
  await ctx.tr.connect(signer).register(referrer, { gasLimit: 16_000_000 });
}

/** Park W1 in MatB — the real shortfall cycle-out (GF-V3's path).
 *
 *  ⛔ V8.50 ITEM E1: THE FILLERS REFER EACH OTHER, NOT W1. They used to all name W1,
 *  which handed W1 fifteen L1 commissions and made the fixture's "underfunded" member the
 *  richest wallet in the pair. It only looked underfunded because that money sat in the
 *  MatA ledger where the re-entry gate could not see it. E1 carries a member's balance
 *  across the crossing, so W1 now funds the $10 re-entry outright and never parks.
 *  Chaining the referrals leaves W1 with ONE L1 plus their own pool and chain pay — the
 *  passive member this precondition was always describing. Same change as
 *  V8_48_GhostFloor's driveW1IntoMatB; if you touch one, touch both. */
async function parkW1InMatB(ctx) {
  await reg(ctx, ctx.W1, ethers.ZeroAddress);
  for (let i = 3; i < 3 + 15; i++) {
    await reg(ctx, ctx.sigs[i], i === 3 ? ctx.W1.address : ctx.sigs[i - 1].address);
  }
  expect(await ctx.b.isActiveInMatrix(ctx.W1.address),
    "precondition: W1 must have crossed into MatB").to.equal(true);
  await ctx.b.adminForceRotateRoot({ gasLimit: 16_000_000 });
  expect(await ctx.b.parkedAt(ctx.W1.address),
    "precondition: shortfall cycle-out must PARK W1 in MatB").to.be.gt(0n);
}

/** Sign an EIP-2612 permit for MockUSDC (domain read via EIP-5267, never assumed). */
async function signPermit(usdc, signer, spender, value, deadline) {
  const d = await usdc.eip712Domain();
  const domain = { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract };
  const types = { Permit: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" },
    { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ] };
  const nonce = await usdc.nonces(signer.address);
  const sig = await signer.signTypedData(domain, types,
    { owner: signer.address, spender, value, nonce, deadline });
  return ethers.Signature.from(sig);
}

describe("V8.48 item 40 — selfRescueWithPermit: one transaction per parked position", function () {
  this.timeout(600_000);

  it("PW1: rescue with ZERO pre-approval — the permit IS the approval, one tx total", async function () {
    const ctx = await deployPair(15);
    await parkW1InMatB(ctx);

    // The state @Lavern-Gay was in: parked, shortfall, no allowance to this matrix.
    expect(await ctx.usdc.allowance(ctx.W1.address, ctx.bAddr)).to.equal(0n);
    const wd = await ctx.b.withdrawableOf(ctx.W1.address);
    const rs = await ctx.b.crossingReserveOf(ctx.W1.address);
    const shortfall = FEE - wd - rs;
    expect(shortfall, "precondition: W1 must actually have a shortfall").to.be.gt(0n);

    await ctx.usdc.mint(ctx.W1.address, shortfall);
    const balBefore = await ctx.usdc.balanceOf(ctx.W1.address);

    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    const { v, r, s } = await signPermit(ctx.usdc, ctx.W1, ctx.bAddr, shortfall, deadline);
    await ctx.b.connect(ctx.W1).selfRescueWithPermit(shortfall, deadline, v, r, s, { gasLimit: 16_000_000 });

    expect(await ctx.b.parkedAt(ctx.W1.address), "rescued — queue slot cleared").to.equal(0n);
    expect(await ctx.a.isActiveInMatrix(ctx.W1.address),
      "MatB rescue destination is the pair's MatA (item 10)").to.equal(true);
    expect(await ctx.usdc.balanceOf(ctx.W1.address),
      "wallet debited exactly the shortfall, nothing else").to.equal(balBefore - shortfall);
  });

  it("PW2: a pre-consumed (griefed) permit does not brick the rescue — the allowance it left behind is used", async function () {
    const ctx = await deployPair(15);
    await parkW1InMatB(ctx);
    const wd = await ctx.b.withdrawableOf(ctx.W1.address);
    const rs = await ctx.b.crossingReserveOf(ctx.W1.address);
    const shortfall = FEE - wd - rs;
    await ctx.usdc.mint(ctx.W1.address, shortfall);

    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    const { v, r, s } = await signPermit(ctx.usdc, ctx.W1, ctx.bAddr, shortfall, deadline);
    // The griefing: someone submits W1's permit before W1's own transaction lands.
    await ctx.usdc.connect(ctx.owner).permit(ctx.W1.address, ctx.bAddr, shortfall, deadline, v, r, s);
    // W1's tx now carries a spent permit — the inner permit call reverts, the
    // catch swallows it, and the standing allowance carries the rescue through.
    await ctx.b.connect(ctx.W1).selfRescueWithPermit(shortfall, deadline, v, r, s, { gasLimit: 16_000_000 });
    expect(await ctx.b.parkedAt(ctx.W1.address)).to.equal(0n);
    expect(await ctx.a.isActiveInMatrix(ctx.W1.address)).to.equal(true);
  });

  it("PW3: a bad signature with NO standing allowance fails LOUDLY with the token's own error", async function () {
    const ctx = await deployPair(15);
    await parkW1InMatB(ctx);
    const wd = await ctx.b.withdrawableOf(ctx.W1.address);
    const rs = await ctx.b.crossingReserveOf(ctx.W1.address);
    const shortfall = FEE - wd - rs;
    await ctx.usdc.mint(ctx.W1.address, shortfall);

    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    // A signature from the WRONG signer: permit reverts inside the catch, no
    // allowance materialises, and the transfer must surface the real reason —
    // not "Transaction failed on-chain", the exact swallowed-error class that
    // sent Sherwyn away twice in July.
    const { v, r, s } = await signPermit(ctx.usdc, ctx.owner, ctx.bAddr, shortfall, deadline);
    await expect(
      ctx.b.connect(ctx.W1).selfRescueWithPermit(shortfall, deadline, v, r, s, { gasLimit: 16_000_000 })
    ).to.be.revertedWithCustomError(ctx.usdc, "ERC20InsufficientAllowance");
    // Still parked — nothing half-happened.
    expect(await ctx.b.parkedAt(ctx.W1.address)).to.be.gt(0n);
  });
});
