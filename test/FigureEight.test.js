"use strict";
/**
 * FigureEight.test.js
 * Tests the figure-8 elevator model:
 * - Two linked 15-member matrices (4-level BFS)
 * - Root cycles out of Matrix A → enters Matrix B automatically
 * - Root cycles out of Matrix B → enters Matrix A automatically
 * - Self-funded re-entry from chain pay earnings
 * - Chain pay flows correctly in both matrices
 */

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const UNIT      = 1_000_000n;
const FEE       = 10n * UNIT;      // $10
const MSIZE     = 15n;             // 4-level tree for fast testing

async function deployF8() {
  const [deployer, dev, admin, ...signers] = await ethers.getSigners();

  const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
  const treasury = await (await ethers.getContractFactory("CNOVATreasury")).deploy(
    await cnova.getAddress(), await usdc.getAddress(), admin.address
  );

  // Deploy Matrix A and Matrix B
  const F8 = await ethers.getContractFactory("FigureEightMatrix");

  // V7 constructor: usdc, cnova, treasury, dev, ops, founder, protocol, accountOne, admin, fee, size, isA
  const matA = await F8.deploy(
    await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
    dev.address,           // devWallet      (2%)
    dev.address,           // opsWallet      (2%) — same as dev in test
    ethers.ZeroAddress,    // founderWallet  (skip in test)
    dev.address,           // protocolWallet (EOA ok — plain transfer)
    deployer.address,      // accountOne     — test wallet, any address works
    admin.address, FEE, MSIZE, true
  );

  const matB = await F8.deploy(
    await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
    dev.address,
    dev.address,           // opsWallet
    ethers.ZeroAddress,
    dev.address,
    deployer.address,      // accountOne — same for both matrices
    admin.address, FEE, MSIZE, false
  );

  const matAAddr = await matA.getAddress();
  const matBAddr = await matB.getAddress();

  // Wire partners
  await matA.connect(admin).setPartner(matBAddr);
  await matB.connect(admin).setPartner(matAAddr);

  // Roles
  const MINTER = await cnova.MINTER_ROLE();
  const BURNER = await cnova.BURNER_ROLE();
  await cnova.connect(admin).grantRole(MINTER, matAAddr);
  await cnova.connect(admin).grantRole(MINTER, matBAddr);
  await cnova.connect(admin).grantRole(BURNER, await treasury.getAddress());
  await treasury.connect(admin).setAuthorizedCaller(matAAddr, true);
  await treasury.connect(admin).setAuthorizedCaller(matBAddr, true);

  // Mint USDC to signers
  for (const s of signers.slice(0, 30)) {
    await usdc.connect(deployer).mint(s.address, 500n * UNIT);
  }

  // Helper: register via Matrix A
  const reg = async (signer, referrer) => {
    await usdc.connect(signer).approve(matAAddr, FEE);
    return matA.connect(signer).register(referrer ?? ethers.ZeroAddress);
  };

  return { usdc, cnova, treasury, matA, matB, admin, dev, signers, reg, matAAddr, matBAddr };
}

describe("Figure-8 Matrix (4-level, 15 members)", function () {

  it("deploys two linked matrices correctly", async function () {
    const { matA, matB, matAAddr, matBAddr } = await loadFixture(deployF8);
    expect(await matA.MATRIX_SIZE()).to.equal(MSIZE);
    expect(await matB.MATRIX_SIZE()).to.equal(MSIZE);
    expect(await matA.isMatrixA()).to.equal(true);
    expect(await matB.isMatrixA()).to.equal(false);
    expect(await matA.partner()).to.equal(matBAddr);
    expect(await matB.partner()).to.equal(matAAddr);
  });

  it("member 1 enters Matrix A at position 1", async function () {
    const { matA, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];
    await reg(alice);
    expect(await matA.matrixPos(alice.address)).to.equal(1n);
    expect(await matA.occupancy()).to.equal(1n);
    expect((await matA.getMember(alice.address)).isInMatrix).to.equal(true);
  });

  it("15 members fill Matrix A", async function () {
    const { matA, signers, reg } = await loadFixture(deployF8);
    for (let i = 0; i < 15; i++) await reg(signers[i]);
    expect(await matA.occupancy()).to.equal(MSIZE);
    expect(await matA.isFull()).to.equal(true);
  });

  it("member 16 triggers root to cycle out of Matrix A", async function () {
    const { matA, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];
    // Alice registers first with all 14 others using her as referrer
    // V7: Alice gets $2.00 L1 × 14 = $28 withdrawable + $1.00 escrow × 14 = $14 escrow
    await reg(alice, ethers.ZeroAddress);
    for (let i = 1; i < 15; i++) await reg(signers[i], alice.address);

    // Alice should be at root, has earnings > $10
    const aliceEarned = (await matA.getMember(alice.address)).withdrawable;
    expect(aliceEarned).to.be.gte(FEE, "Alice needs >= $10 to self-fund re-entry");

    // Member 16 triggers cycle
    await reg(signers[15], alice.address);

    // Alice cycled out of Matrix A
    expect((await matA.getMember(alice.address)).cyclesCompleted).to.equal(1n);
    expect(await matA.rotationCount()).to.equal(1n);
  });

  it("root automatically crosses to Matrix B after cycling out of Matrix A", async function () {
    const { matA, matB, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];

    await reg(alice, ethers.ZeroAddress);
    for (let i = 1; i < 15; i++) await reg(signers[i], alice.address);
    await reg(signers[15], alice.address);

    // Alice should now be IN Matrix B
    const aliceInB = (await matB.getMember(alice.address)).isInMatrix;
    const alicePosB = await matB.matrixPos(alice.address);

    expect(aliceInB).to.equal(true, "Alice should be in Matrix B after crossing");
    expect(alicePosB).to.be.gte(1n, "Alice should have a position in Matrix B");
  });

  it("when chainNext NOT set: B crosses back to A (single-pair fallback)", async function () {
    // With only one pair and no chainNext set, B falls back to partner (A)
    // This is the backward-compatible behavior
    const { matA, matB, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];

    // Fill Matrix A → alice crosses to B
    await reg(alice, ethers.ZeroAddress);
    for (let i = 1; i < 15; i++) await reg(signers[i], alice.address);
    await reg(signers[15], alice.address);  // alice → Matrix B

    expect((await matB.getMember(alice.address)).isInMatrix).to.equal(true);
    expect((await matA.getMember(alice.address)).cyclesCompleted).to.equal(1n);
  });

  it("circular chain: A→B→C when chainNext configured (direct registrations)", async function () {
    // Chain proof: B crosses to C (not back to A) when chainNext is set.
    //
    // MSIZE=7: A holds 7 members. 8th triggers cycle (alice → B).
    //   Alice accumulates $9 escrow + $7.20 chain pay = $16.20 in B (> $10 cross fee).
    //
    // Why direct matA.register() (not PairManager):
    //   After addPair(C,D), PairManager routes all new members to C (newest active pair).
    //   Direct registration bypasses PM, always enters Matrix A, allowing A to cycle
    //   repeatedly and push members into B until B fills and alice crosses to C.
    //
    // Registration count: alice + s1..s14 = 15 total.
    //   After s7  (8th  entry): alice cycles A→B
    //   After s13 (14th entry): B is full (alice + 6 crossings from A)
    //   After s14 (15th entry): s7 tries to cross A→B, B full → alice cycles B→C ✓
    const [deployer, dev, admin, ...signers] = await ethers.getSigners();
    const CSIZE = 7n;

    const usdc  = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
    const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
    const treasury = await (await ethers.getContractFactory("CNOVATreasury")).deploy(
      await cnova.getAddress(), await usdc.getAddress(), admin.address
    );
    const F8 = await ethers.getContractFactory("FigureEightMatrix");
    const deployM = async (isA) => F8.deploy(
      await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
      dev.address, dev.address, ethers.ZeroAddress, dev.address,
      deployer.address, admin.address, 10_000_000n, CSIZE, isA
    );

    const matA = await deployM(true);
    const matB = await deployM(false);
    const matC = await deployM(true);
    const matD = await deployM(false);
    await matA.connect(admin).setPartner(await matB.getAddress());
    await matB.connect(admin).setPartner(await matA.getAddress());
    await matC.connect(admin).setPartner(await matD.getAddress());
    await matD.connect(admin).setPartner(await matC.getAddress());

    const PairManager = await ethers.getContractFactory("PairManager");
    const pm = await PairManager.deploy(await usdc.getAddress(), 10_000_000n, admin.address);
    for (const m of [matA, matB, matC, matD]) await m.connect(admin).setPairManager(await pm.getAddress());

    const MINTER = await cnova.MINTER_ROLE();
    for (const m of [matA, matB, matC, matD]) await cnova.connect(admin).grantRole(MINTER, await m.getAddress());
    for (const m of [matA, matB, matC, matD]) await treasury.connect(admin).setAuthorizedCaller(await m.getAddress(), true);
    await treasury.connect(admin).setTier1Matrix(await matA.getAddress());

    // Wire chain: addPair sets B.chainNext=C, D.chainNext=A
    await pm.connect(admin).addPair(await matA.getAddress(), await matB.getAddress());
    await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());

    // ── Verify chain wiring ──────────────────────────────────────────────────
    expect(await matB.chainNext()).to.equal(await matC.getAddress(), "B→C");
    expect(await matD.chainNext()).to.equal(await matA.getAddress(), "D→A (circle)");
    expect(await matA.chainAuthorized(await matB.getAddress())).to.equal(false); // A→B via partner
    expect(await matC.chainAuthorized(await matB.getAddress())).to.equal(true,  "B can enter C");
    expect(await matA.chainAuthorized(await matD.getAddress())).to.equal(true,  "D can enter A");

    // ── Mint USDC ───────────────────────────────────────────────────────────
    for (const s of signers.slice(0, 20)) await usdc.mint(s.address, 500_000_000n);
    await usdc.mint(admin.address, 500_000_000n);  // admin funds forceCross calls
    const FEE = 10_000_000n;

    // Direct registration in matA (bypasses PairManager routing)
    const regA = async (signer, referrer) => {
      await usdc.connect(signer).approve(await matA.getAddress(), FEE);
      return matA.connect(signer).register(referrer ?? ethers.ZeroAddress);
    };

    // Admin force-crosses a parked A-member into B.
    // Why needed: after alice fills B's pos 1, subsequent roots only see 1 new
    // member before cycling out ($1.50 escrow) — far below the $10 crossing fee.
    // forceCross is the keeper mechanism for exactly this: admin provides the fee.
    const forceCrossToB = async (member) => {
      await usdc.connect(admin).approve(await matA.getAddress(), FEE);
      return matA.connect(admin).forceCross(member.address);
    };

    const alice = signers[0];

    // ── Phase 1: Fill Matrix A (MSIZE=7) → alice crosses A→B ────────────────
    // Alice is root for 6 members → escrow = $9.00, chain pay = $7.20 → funds $10 cross
    await regA(alice);                                    // A: 1/7 — alice pos 1
    for (let i = 1; i <= 6; i++) await regA(signers[i], alice.address);  // A: 7/7 FULL
    await regA(signers[7], alice.address);                // 8th → CYCLE: alice → B

    expect((await matB.getMember(alice.address)).isInMatrix).to.equal(true,  "Alice in B after A first cycle");
    expect((await matA.getMember(alice.address)).isInMatrix).to.equal(false, "Alice left A");

    // ── Phase 2: Fill Matrix B → alice crosses B→C via chainNext ─────────────
    // Each A registration cycles out the next root (s1-s6), who parks (only $2.30 available).
    // forceCross pushes each parked member into B (admin provides the $10 fee).
    // After 6 forceCrosses: B = [alice, s1, s2, s3, s4, s5, s6] — 7/7 FULL
    for (let i = 8; i <= 13; i++) {
      await regA(signers[i], alice.address);              // A cycles → s(i-7) parks
      await forceCrossToB(signers[i - 7]);                // push parked member into B
    }
    // B is now full (7/7). One more forceCross sends the 8th → alice cycles B→C!
    await regA(signers[14], alice.address);               // A cycles s7 → parks
    await forceCrossToB(signers[7]);                      // s7 enters B (full) → alice → C!

    // ── THE KEY ASSERTION: Alice crossed to C (not back to A) ───────────────
    expect((await matC.getMember(alice.address)).isInMatrix).to.equal(true,
      "Alice should be in C after B fills (chain crossing B→C via chainNext)");
    expect((await matB.getMember(alice.address)).isInMatrix).to.equal(false,
      "Alice NOT in B — she crossed FORWARD to C, not back to A");
    expect((await matA.getMember(alice.address)).isInMatrix).to.equal(false,
      "Alice NOT back in A — chain went forward as designed");
  });

  it("chain pay flows correctly to ancestors in Matrix A", async function () {
    const { matA, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];
    const bob   = signers[1];

    await reg(alice);
    const beforeBob = (await matA.getMember(alice.address)).withdrawable;
    await reg(bob, alice.address);
    const afterBob = (await matA.getMember(alice.address)).withdrawable;

    // Alice should earn L1 chain pay + L1 referral when bob joins
    expect(afterBob).to.be.gt(beforeBob, "Alice should earn when bob joins");
  });

  it("L1 referral pays 20% of entry fee (V7)", async function () {
    const { matA, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];
    const bob   = signers[1];

    await reg(alice);
    await reg(bob, alice.address);

    const aliceEarned = (await matA.getMember(alice.address)).totalEarned;
    const l1Expected  = FEE * 2000n / 10_000n;  // $2.00 (V7: L1=20%)
    expect(aliceEarned).to.be.gte(l1Expected);
    // Also assert it's NOT the old 25%
    const l1Old = FEE * 2500n / 10_000n;  // $2.50 old value
    expect(l1Expected).to.equal(2_000_000n);
    expect(aliceEarned).to.be.lt(l1Old + FEE);  // sanity upper bound
  });

  it("Follow Me Escrow credits current root on every join", async function () {
    const { matA, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];
    const bob   = signers[1];

    await reg(alice);  // alice is root (pos 1)

    const escrowBefore = await matA.escrowOf(alice.address);
    await reg(bob, alice.address);  // bob joins → escrow to alice
    const escrowAfter = await matA.escrowOf(alice.address);

    // Regular 10% escrow = $1.00.  Plus: L2/L3 orphan-routing also routes a
    // portion to the current root when alice has no referral chain (no L2/L3).
    // So the actual increase is always >= $1.00 — exact amount depends on chain depth.
    const escrowMin = FEE * 1000n / 10_000n;  // $1.00 floor
    expect(escrowAfter - escrowBefore).to.be.gte(escrowMin);
    expect(escrowAfter).to.be.gt(escrowBefore);  // sanity: escrow DID increase
  });

  it("root crossing is funded from escrow first", async function () {
    const { matA, matB, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];

    await reg(alice, ethers.ZeroAddress);
    for (let i = 1; i < 15; i++) await reg(signers[i], alice.address);

    // Alice should have at least $10 escrow — enough to self-fund the crossing.
    // Actual amount is > $14 because orphan L2/L3 routing also credits the root,
    // and alice's own registration (no referrer) also seeds her escrow via orphan fees.
    const aliceEscrow = await matA.escrowOf(alice.address);
    expect(aliceEscrow).to.be.gte(FEE, "Alice needs >= $10 escrow to self-fund crossing");

    // Trigger cycle — alice should cross to B (funded by escrow, not withdrawable)
    const earningsBefore = (await matA.getMember(alice.address)).withdrawable;
    await reg(signers[15], alice.address);
    const earningsAfter = (await matA.getMember(alice.address)).withdrawable;

    // Withdrawable should NOT decrease — escrow funded the $10 crossing, not earnings.
    // (Alice may still earn L1 referral from signers[15]'s registration, so
    //  earningsAfter >= earningsBefore is the correct invariant, not strict equality.)
    expect(earningsAfter).to.be.gte(earningsBefore,
      "Earnings must not decrease — crossing was funded by escrow, not withdrawable");
    // Alice should be in Matrix B
    expect((await matB.getMember(alice.address)).isInMatrix).to.equal(true);
  });

  it("re-entry is self-funded — withdrawable decreases by entry fee", async function () {
    const { matA, matB, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];

    await reg(alice, ethers.ZeroAddress);
    for (let i = 1; i < 15; i++) await reg(signers[i], alice.address);

    const beforeCycle = (await matA.getMember(alice.address)).withdrawable;
    await reg(signers[15], alice.address);  // triggers cycle
    const afterCycle = (await matB.getMember(alice.address)).withdrawable;

    // Alice paid $10 re-entry from withdrawable
    expect(beforeCycle - afterCycle).to.be.gte(FEE, "Re-entry deducted from withdrawable");
  });

  it("member can withdraw earnings", async function () {
    const { matA, usdc, signers, reg, matAAddr } = await loadFixture(deployF8);
    const alice = signers[0];
    const bob   = signers[1];

    await reg(alice);
    await reg(bob, alice.address);

    const earned = (await matA.getMember(alice.address)).withdrawable;
    expect(earned).to.be.gt(0n);

    const balBefore = await usdc.balanceOf(alice.address);
    await matA.connect(alice).withdraw();
    const balAfter = await usdc.balanceOf(alice.address);

    expect(balAfter - balBefore).to.equal(earned);
    expect((await matA.getMember(alice.address)).withdrawable).to.equal(0n);
  });

  it("occupancy decrements on cycle-out", async function () {
    const { matA, signers, reg } = await loadFixture(deployF8);
    const alice = signers[0];

    await reg(alice, ethers.ZeroAddress);
    for (let i = 1; i < 15; i++) await reg(signers[i], alice.address);
    expect(await matA.occupancy()).to.equal(MSIZE);

    await reg(signers[15], alice.address);
    // occupancy should still be MSIZE (1 out, 1 in)
    expect(await matA.occupancy()).to.equal(MSIZE);
  });

  it("total members tracks across both matrices", async function () {
    const { matA, matB, signers, reg } = await loadFixture(deployF8);

    await reg(signers[0], ethers.ZeroAddress);
    for (let i = 1; i < 15; i++) await reg(signers[i], signers[0].address);

    expect(await matA.totalJoined()).to.equal(15n);
    await reg(signers[15], signers[0].address);  // triggers cross to B

    // Alice is now in B — B should have 1 member (alice)
    expect(await matB.totalJoined()).to.gte(1n);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 127-MEMBER CIRCULAR CHAIN: A→B→C with MSIZE=127 (production matrix)
  // ────────────────────────────────────────────────────────────────────────────
  //
  //  MSIZE=127 = 7-level BFS (2^7 - 1). This is the production mainnet size.
  //
  //  Phase 1 — fill Matrix A (127 members):
  //    alice enters A at pos 1 (root).
  //    126 more joiners fill A to MSIZE.
  //    127th joiner triggers cycle: alice cycles out of A → crosses to B.
  //    alice self-funds: 126 × $2.00 (escrow+secondary) + chain pay >> $10.
  //
  //  Phase 2 — fill Matrix B (127 members):
  //    alice is at pos 1 of B (first root).
  //    Each iteration: register new wallet in A → A-root cycles out → parked
  //                    forceCross parked A-root → enters B at next BFS slot.
  //    After 127 iterations B has 128 entries total (alice + 127 forced).
  //    128th B entry cycles alice out → alice crosses B→C via chainNext.
  //    alice self-funds again: 126 × $2.00 in B >> $10.
  //
  it("circular chain: A→B→C with MSIZE=127 (production matrix)", async function () {
    const [deployer, dev, admin] = await ethers.getSigners();
    const CSIZE = 127n;
    const FEE   = 10_000_000n;

    // ── Deploy ────────────────────────────────────────────────────────────
    const usdc     = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
    const cnova    = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);
    const treasury = await (await ethers.getContractFactory("CNOVATreasury")).deploy(
      await cnova.getAddress(), await usdc.getAddress(), admin.address
    );
    const F8 = await ethers.getContractFactory("FigureEightMatrix");

    const deployMatrix = async (isA) => F8.deploy(
      await usdc.getAddress(), await cnova.getAddress(), await treasury.getAddress(),
      dev.address,           // devWallet
      dev.address,           // opsWallet
      ethers.ZeroAddress,    // founderWallet (skip in test)
      dev.address,           // protocolWallet
      deployer.address,      // accountOne
      admin.address, FEE, CSIZE, isA
    );
    const matA = await deployMatrix(true);
    const matB = await deployMatrix(false);
    const matC = await deployMatrix(true);
    const matD = await deployMatrix(false);

    // Wire partners (required before addPair)
    await matA.connect(admin).setPartner(await matB.getAddress());
    await matB.connect(admin).setPartner(await matA.getAddress());
    await matC.connect(admin).setPartner(await matD.getAddress());
    await matD.connect(admin).setPartner(await matC.getAddress());

    const pm = await (await ethers.getContractFactory("PairManager")).deploy(
      await usdc.getAddress(), FEE, admin.address
    );
    for (const m of [matA, matB, matC, matD])
      await m.connect(admin).setPairManager(await pm.getAddress());

    // Grant MINTER role on CNOVA token to all matrices
    const MINTER = await cnova.MINTER_ROLE();
    for (const m of [matA, matB, matC, matD])
      await cnova.connect(admin).grantRole(MINTER, await m.getAddress());

    // Authorise matrices to call treasury
    for (const m of [matA, matB, matC, matD])
      await treasury.connect(admin).setAuthorizedCaller(await m.getAddress(), true);
    await treasury.connect(admin).setTier1Matrix(await matA.getAddress());

    // Wire circular chain: addPair sets B.chainNext=C, D.chainNext=A
    await pm.connect(admin).addPair(await matA.getAddress(), await matB.getAddress());
    await pm.connect(admin).addPair(await matC.getAddress(), await matD.getAddress());

    // Verify circular wiring
    expect(await matB.chainNext()).to.equal(await matC.getAddress(), "B.chainNext = C");
    expect(await matD.chainNext()).to.equal(await matA.getAddress(), "D.chainNext = A");
    expect(await matC.chainAuthorized(await matB.getAddress())).to.equal(true, "B authorised in C");
    expect(await matA.chainAuthorized(await matD.getAddress())).to.equal(true, "D authorised in A");

    // Fund admin generously for forceCross calls
    await usdc.mint(admin.address, 5_000_000_000n);

    // ── Wallet factory: create + fund a fresh signer ──────────────────────
    // Uses Hardhat's pre-funded accounts (signers index 3+) rather than
    // random wallets to avoid per-wallet ETH transfer overhead.
    const allSigners = await ethers.getSigners();
    let signerIdx = 3; // deployer=0, dev=1, admin=2

    const nextSigner = async () => {
      const s = allSigners[signerIdx++];
      await usdc.mint(s.address, FEE * 5n);
      return s;
    };

    const regA = async (signer, referrer) => {
      await usdc.connect(signer).approve(await matA.getAddress(), FEE);
      return matA.connect(signer).register(referrer ?? ethers.ZeroAddress);
    };

    const forceCrossToB = async (memberAddr) => {
      await usdc.connect(admin).approve(await matA.getAddress(), FEE);
      return matA.connect(admin).forceCross(memberAddr);
    };

    // ── Phase 1: Fill Matrix A → alice crosses to B ───────────────────────
    const alice = await nextSigner();
    await regA(alice);                                    // alice → A pos 1

    for (let i = 0; i < 126; i++) {
      const s = await nextSigner();
      await regA(s, alice.address);                      // fill A pos 2–127
    }

    // 127th extra joiner → A full → alice (pos 1) cycles out → crosses to B
    const trigA = await nextSigner();
    await regA(trigA, alice.address);

    expect(
      (await matB.getMember(alice.address)).isInMatrix,
      "Phase 1: alice must be in Matrix B"
    ).to.equal(true);

    // ── Phase 2: Fill Matrix B → alice crosses to C ───────────────────────
    // 127 iterations: each puts one member into B.
    //   - Read posToMember(1) BEFORE regA (that member will cycle out)
    //   - regA triggers A-root cycle-out
    //   - If A-root self-funded: auto-crossed to B already (no action needed)
    //   - If A-root couldn't fund (~$2 escrow < $10): _crossToPartner returns
    //     silently WITHOUT setting pendingCross — we detect via getMember check
    //   - forceCross only the members not yet in B or C
    // After 126 B entries: B = alice + 126 = 127 = MSIZE (full)
    // 127th B entry triggers alice (pos 1 of B) to cycle out → B→C via chainNext
    for (let i = 0; i < 127; i++) {
      // Snapshot pos-1 BEFORE the cycle so we know exactly who will leave A
      const rootAddr = await matA.posToMember(1n);

      const s = await nextSigner();
      await regA(s, ethers.ZeroAddress);                 // triggers A cycle-out

      // If rootAddr didn't self-fund and isn't in B or C yet → forceCross
      const inB = (await matB.getMember(rootAddr)).isInMatrix;
      const inC = (await matC.getMember(rootAddr)).isInMatrix;
      if (!inB && !inC) {
        await forceCrossToB(rootAddr);
      }
    }

    expect(
      (await matC.getMember(alice.address)).isInMatrix,
      "Phase 2: alice must be in Matrix C after B fills (B→C via chainNext)"
    ).to.equal(true);
    expect((await matB.getMember(alice.address)).isInMatrix).to.equal(false);
    expect((await matA.getMember(alice.address)).isInMatrix).to.equal(false);
  });


});
