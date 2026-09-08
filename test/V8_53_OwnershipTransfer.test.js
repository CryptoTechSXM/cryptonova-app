// V8_53_OwnershipTransfer.test.js — REHEARSAL of the P3 hand-over (MAINNET_READINESS.md §2 P3), in-process.
// Why a test and not a runbook on `localhost`: the in-process hardhat chain dies with each `hardhat run`,
// and a localhost deploy took the owner 1h13m (session 66). So the whole flow — census → propose →
// accept (as the NEW owner) → verify → renounce the old admin roles — runs here against the V8_48
// two-tier fixture plus a real MatrixKeeper (the 1-step Ownable row) and CNOVAToken (AccessControl row).
// The scripts under test are the real ones: scripts/transfer_ownership.js and scripts/accept_ownership.js.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployTwoTiers } = require("./V8_48_BulkPartial.test.js");
const { run } = require("../scripts/transfer_ownership.js");
const { accept } = require("../scripts/accept_ownership.js");

const quiet = () => {};

async function bookFixture() {
  const ctx = await deployTwoTiers();
  const mk = await (await ethers.getContractFactory("MatrixKeeper")).deploy(await ctx.tr.getAddress(), await ctx.sf.getAddress());
  const book = {
    chainId: 31337,
    treasury: await ctx.treasury.getAddress(),
    stabilityFund: await ctx.sf.getAddress(),
    tierRouter: await ctx.tr.getAddress(),
    matrixKeeper: await mk.getAddress(),
    cnova: await ctx.cnova.getAddress(),
    tiers: {
      T1: { pm: await ctx.pm1.getAddress(), matA: await ctx.matA1.getAddress(), matB: await ctx.matB1.getAddress() },
      T2: { pm: await ctx.pm2.getAddress(), matA: await ctx.matA2.getAddress(), matB: await ctx.matB2.getAddress() },
    },
  };
  const hw = ctx.sigs[1];          // stands in for the hardware wallet
  const stranger = ctx.sigs[2];
  return { ctx, book, mk, hw, stranger, owner: ctx.owner };
}

describe("V8.53 — ownership hand-over rehearsal (transfer_ownership.js + accept_ownership.js)", function () {
  this.timeout(600_000);

  it("OT1: census runs clean on a fresh deploy — 9 two-step + 1 one-step + 1 roles row, no FAIL", async () => {
    const { book, owner } = await bookFixture();
    const r = await run({ mode: "census", book, signer: owner, log: quiet });
    expect(r.rows).to.equal(11);
    expect(r.fails).to.equal(0);
  });

  it("OT2: propose from the owner → every 2-step row pending, 1-step row moved, roles granted; a stranger cannot propose", async () => {
    const { ctx, book, mk, hw, stranger, owner } = await bookFixture();
    const bad = await run({ mode: "propose", addr: hw.address, book, signer: stranger, log: quiet });
    expect(bad.fails, "stranger: every ownable row FAILs (roles rows: lacks the role)").to.equal(11);
    expect(bad.txs).to.equal(0);

    const r = await run({ mode: "propose", addr: hw.address, book, signer: owner, log: quiet });
    expect(r.fails).to.equal(0);
    expect(r.txs, "9 transferOwnership (2-step) + 1 transferOwnership (1-step) + 1 grantRole").to.equal(11);
    expect(await ctx.tr.owner(), "2-step: owner unchanged until accept").to.equal(owner.address);
    expect(await ctx.tr.pendingOwner()).to.equal(hw.address);
    expect(await mk.owner(), "1-step: moved immediately").to.equal(hw.address);
    expect(await ctx.cnova.hasRole(ethers.ZeroHash, hw.address)).to.be.true;
    expect(await ctx.cnova.hasRole(ethers.ZeroHash, owner.address), "old admin still holds the role until renounce").to.be.true;

    const again = await run({ mode: "propose", addr: hw.address, book, signer: owner, log: quiet });
    expect(again.txs, "idempotent: second propose sends nothing").to.equal(0);
    expect(again.fails).to.equal(0);
  });

  it("OT3: verify is RED before accept, accept as the new owner takes the 9 rows, verify is GREEN after", async () => {
    const { ctx, book, hw, owner, stranger } = await bookFixture();
    await run({ mode: "propose", addr: hw.address, book, signer: owner, log: quiet });
    const before = await run({ mode: "verify", addr: hw.address, book, signer: owner, log: quiet });
    expect(before.fails, "9 two-step rows still owned by the old owner").to.equal(9);

    const wrong = await accept({ book, signer: stranger, log: quiet });
    expect(wrong.fails, "a stranger cannot accept").to.equal(9);
    expect(wrong.done).to.equal(0);

    const a = await accept({ book, signer: hw, log: quiet });
    expect(a.done).to.equal(9);
    expect(a.fails).to.equal(0);
    expect(await ctx.tr.owner()).to.equal(hw.address);
    expect(await ctx.tr.pendingOwner()).to.equal(ethers.ZeroAddress);
    expect(await ctx.matB2.owner()).to.equal(hw.address);

    const after = await run({ mode: "verify", addr: hw.address, book, signer: owner, log: quiet });
    expect(after.fails).to.equal(0);
    const a2 = await accept({ book, signer: hw, log: quiet });
    expect(a2.done, "idempotent accept").to.equal(0);
    expect(a2.skipped).to.equal(9);
  });

  it("OT4: the old owner is powerless after the hand-over; the new owner can pause and set the pauser", async () => {
    const { ctx, book, hw, owner } = await bookFixture();
    await run({ mode: "propose", addr: hw.address, book, signer: owner, log: quiet });
    await accept({ book, signer: hw, log: quiet });
    await expect(ctx.tr.connect(owner).setPauser(hw.address)).to.be.revertedWithCustomError(ctx.tr, "OwnableUnauthorizedAccount");
    await expect(ctx.tr.connect(owner).pauseSystem("old owner")).to.be.revertedWithCustomError(ctx.tr, "TRAuth");
    await ctx.tr.connect(hw).setPauser(ctx.sigs[9].address);
    await ctx.tr.connect(hw).pauseSystem("new owner");
    expect(await ctx.tr.systemPaused()).to.be.true;
  });

  it("OT5: renounce-roles removes the old admin only from the NEW admin, and never from itself", async () => {
    const { ctx, book, hw, owner } = await bookFixture();
    await run({ mode: "propose", addr: hw.address, book, signer: owner, log: quiet });
    await accept({ book, signer: hw, log: quiet });
    const selfie = await run({ mode: "renounce-roles", addr: hw.address, book, signer: hw, log: quiet });
    expect(selfie.fails, "refuses to revoke the signer's own role").to.equal(1);
    const fromOld = await run({ mode: "renounce-roles", addr: owner.address, book, signer: owner, log: quiet });
    expect(fromOld.fails, "refuses when signer == the address being revoked").to.equal(1);
    const ok = await run({ mode: "renounce-roles", addr: owner.address, book, signer: hw, log: quiet });
    expect(ok.fails).to.equal(0);
    expect(ok.txs).to.equal(1);
    expect(await ctx.cnova.hasRole(ethers.ZeroHash, owner.address)).to.be.false;
    expect(await ctx.cnova.hasRole(ethers.ZeroHash, hw.address)).to.be.true;
    const v = await run({ mode: "verify", addr: hw.address, book, signer: hw, log: quiet });
    expect(v.fails).to.equal(0);
  });
});
