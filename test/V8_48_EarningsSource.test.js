"use strict";
/**
 * V8_48_EarningsSource.test.js — scope item 37.
 *
 * `_credit()` used to move money and emit NOTHING. Two of the four earning paths were
 * therefore invisible: the 2.5% direct earn and the L1 referral payment. Chain pay and
 * pool share emitted, so a dashboard could attribute exactly those two — a member watched
 * a balance rise with no way to learn why. An ORPHANED L1 emitted `OrphanFeeRouted`, so
 * the failure case was traceable while the success case was silent.
 *
 * THE INVARIANT THAT MAKES THE EVENT WORTH HAVING:
 *   the sum of a member's EarningsCredited amounts MUST equal their totalEarned.
 * A breakdown that does not add up to the balance is worse than no breakdown, because it
 * looks authoritative. That is asserted below, per member, per matrix.
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
const FEE    = 10_000_000n;

const SRC = { DIRECT_ENTRY: 1n, L1_REFERRAL: 2n, CHAIN_PAY: 3n, POOL_SHARE: 4n, ORPHAN_ACCT1: 5n };

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

/** Impersonate a pair matrix and call rescueReentry; return the routed destination. */
async function routeRescue(ctx, fromMatrixAddr, member, referrer) {
  await ethers.provider.send("hardhat_impersonateAccount", [fromMatrixAddr]);
  await ethers.provider.send("hardhat_setBalance",
    [fromMatrixAddr, "0x56BC75E2D63100000"]);            // 100 ETH for gas
  const asMatrix = await ethers.getSigner(fromMatrixAddr);

  await ctx.usdc.mint(fromMatrixAddr, FEE);
  await ctx.usdc.connect(asMatrix).approve(ctx.pmAddr, FEE);

  const tx = await ctx.pm.connect(asMatrix)
    .rescueReentry(member, referrer, 0, { gasLimit: 16_000_000 });
  const rc = await tx.wait();
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [fromMatrixAddr]);

  const ev = rc.logs
    .map(l => { try { return ctx.pm.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find(e => e.name === "MemberRouted");
  expect(ev, "MemberRouted not emitted").to.not.equal(undefined);
  return ev.args[2];                                      // dest
}


describe("V8.48 item 37 — every credit says where it came from", function () {
  this.timeout(600_000);

  async function creditsOf(matrix) {
    // The event is declared in MatrixLogicLib but emitted through the matrix (delegatecall),
    // so the logs carry the MATRIX address and need decoding with the library's ABI.
    const lib = await ethers.getContractFactory("MatrixLogicLib");
    const logs = await ethers.provider.getLogs({
      address: await matrix.getAddress(), fromBlock: 0, toBlock: "latest",
    });
    const out = [];
    for (const lg of logs) {
      let d = null;
      try { d = lib.interface.parseLog(lg); } catch { d = null; }
      if (d && d.name === "EarningsCredited") {
        out.push({ member: d.args.member, payer: d.args.payer, source: d.args.source, amount: d.args.amount });
      }
    }
    return out;
  }

  it("the breakdown SUMS TO THE BALANCE for every member", async function () {
    const ctx = await deployPair(7);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    for (let i = 10; i < 16; i++) await reg(ctx, ctx.sigs[i], ctx.W1.address);

    const credits = await creditsOf(ctx.a);
    expect(credits.length, "credits must be emitted at all").to.be.gt(0);

    const summed = new Map();
    for (const c of credits) {
      summed.set(c.member, (summed.get(c.member) ?? 0n) + c.amount);
    }

    // Every member who earned anything must have their events add up to totalEarned.
    for (const [member, total] of summed) {
      const m = await ctx.a.getMember(member);
      expect(total, `EarningsCredited for ${member} must sum to totalEarned`).to.equal(m.totalEarned);
    }

    // And nobody has earnings the event stream cannot account for.
    for (let i = 10; i < 16; i++) {
      const addr = ctx.sigs[i].address;
      const m = await ctx.a.getMember(addr);
      if (m.totalEarned > 0n) {
        expect(summed.get(addr), `${addr} earned but emitted no credits`).to.equal(m.totalEarned);
      }
    }
  });

  it("names the SOURCE and the PAYER, not just the amount", async function () {
    const ctx = await deployPair(7);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    const entrant = ctx.sigs[10];
    await reg(ctx, entrant, ctx.W1.address);

    const credits = await creditsOf(ctx.a);

    // The entrant's own 2.5% carve — payer is the entrant themselves.
    const direct = credits.filter(c => c.source === SRC.DIRECT_ENTRY && c.member === entrant.address);
    expect(direct.length, "direct-earn credit must be emitted").to.be.gt(0);
    expect(direct[0].payer, "direct earn is funded by the member's own entry").to.equal(entrant.address);

    // W1 is the referrer — the L1 credit must name the ENTRANT as payer, which is the
    // whole point: "who paid me" is the question a member actually asks.
    const l1 = credits.filter(c => c.source === SRC.L1_REFERRAL && c.member === ctx.W1.address);
    expect(l1.length, "L1 referral credit must be emitted — this path was SILENT before").to.be.gt(0);
    expect(l1[0].payer, "L1 names the member whose entry generated it").to.equal(entrant.address);
  });

  it("the two paths that were silent before now emit", async function () {
    const ctx = await deployPair(7);
    await reg(ctx, ctx.W1, ethers.ZeroAddress);
    for (let i = 10; i < 14; i++) await reg(ctx, ctx.sigs[i], ctx.W1.address);

    const credits = await creditsOf(ctx.a);
    const sources = new Set(credits.map(c => c.source));
    expect(sources.has(SRC.DIRECT_ENTRY), "direct earn (2.5%) was silent before item 37").to.equal(true);
    expect(sources.has(SRC.L1_REFERRAL),  "L1 referral was silent before item 37").to.equal(true);
  });
});
