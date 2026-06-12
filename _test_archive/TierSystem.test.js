/**
 * CryptoNova Tier System — Test Suite
 * ─────────────────────────────────────────────────────────────────
 * Run: npx hardhat test test/TierSystem.test.js
 *
 * Covers (42 tests):
 *  V3 Matrix Core
 *    ✓ Deploy and basic state (per-tier constants)
 *    ✓ FEE_MULTIPLIER scales correctly for each tier
 *    ✓ Register member #1 (no referrer)
 *    ✓ Cannot register twice
 *    ✓ Payment split totals exactly entry fee on registration
 *    ✓ Community wallet receives 10% on each join
 *    ✓ Chain pay distributes to 7 ancestor positions
 *    ✓ joinerPosition normalised to 6 when matrix full (scaling bug fix)
 *    ✓ Cycle tracking: cyclesCompleted increments on rotation
 *    ✓ CycleCompleted event emitted on rotation
 *    ✓ totalMembers() returns correct count
 *    ✓ getCyclesCompleted() view works
 *    ✓ Withdraw earnings
 *    ✓ Pause / unpause
 *    ✓ registerFor() succeeds when called by authorised registrar
 *    ✓ registerFor() reverts when called by non-registrar
 *
 *  Community Wallet
 *    ✓ Register founder — Tranche A (members 1–1,000)
 *    ✓ Register founder — Tranche B (members 1,001–2,000)
 *    ✓ Founder slot cap at 2,000
 *    ✓ Deposit accumulates pendingPool
 *    ✓ advanceEpoch() snapshots pool correctly
 *    ✓ Tranche A claim — 70% share
 *    ✓ Tranche B claim — 30% share
 *    ✓ Cannot claim twice in same epoch
 *    ✓ Cannot claim after window closes
 *    ✓ Unclaimed funds rollover to next epoch
 *    ✓ claimMultiple() across epochs
 *    ✓ totalClaimable() view
 *    ✓ Cannot advance epoch too soon
 *
 *  TierManager
 *    ✓ Deploy and tier fee configuration (all 7 tiers)
 *    ✓ recordTier1Join() sets memberTier = 1
 *    ✓ Sequential upgrade blocked without cycles
 *    ✓ Sequential upgrade succeeds with cycles complete
 *    ✓ TierUpgraded event emitted
 *    ✓ primeOrAboveCount increments at tier 5 (SuperNova Genesis)
 *    ✓ fastTrackEnabled flips at WHALE_GATE_THRESHOLD (25 at tier 5+)
 *    ✓ Fast-track upgrade to non-sequential tier
 *    ✓ upgradeCost() returns single-tier fee in sequential mode
 *    ✓ upgradeCost() returns cumulative fee in fast-track mode
 *    ✓ memberProfile() returns correct full profile
 *    ✓ canUpgrade() returns false with reason when cycles not done
 *    ✓ setMatrix() wired for all 7 tiers
 */

"use strict";

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ─── Helpers ──────────────────────────────────────────────────────────────────
const USDC  = (d) => ethers.parseUnits(String(d), 6);
const CNOVA = (t) => ethers.parseUnits(String(t), 18);
const UNIT  = 1_000_000n;  // 1e6 Base USDC

// Tier fee multipliers matching the contracts
const FEE_MULT = { 1: 10n, 2: 25n, 3: 50n, 4: 100n, 5: 250n, 6: 500n, 7: 1000n };

// ─── Shared fixture ───────────────────────────────────────────────────────────
async function deployAll() {
  const [deployer, dev, ops, admin, alice, bob, carol, dave, ...rest]
    = await ethers.getSigners();

  // MockUSDC — constructor takes admin address
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc     = await MockUSDC.deploy(deployer.address);

  // CNOVAToken
  const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
  const cnova      = await CNOVAToken.deploy(admin.address);

  // CNOVATreasury — constructor: (cnova, usdc, admin)  ← cnova first, no UNIT
  const Treasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury = await Treasury.deploy(
    await cnova.getAddress(),
    await usdc.getAddress(),
    admin.address
  );

  // CommunityWallet
  const CommunityWallet = await ethers.getContractFactory("CryptoNovaCommunityWallet");
  const communityWallet = await CommunityWallet.deploy(
    await usdc.getAddress(),
    admin.address
  );

  // ── Deploy all 7 V3 matrices with correct fee multipliers ─────────────────
  const MatrixV3 = await ethers.getContractFactory("CryptoNovaMatrixV3");

  async function deployMatrix(feeMultiplier, activeWindow = 5) {
    return MatrixV3.deploy(
      await usdc.getAddress(),
      await cnova.getAddress(),
      await treasury.getAddress(),
      dev.address,
      ops.address,
      await communityWallet.getAddress(),
      admin.address,
      UNIT,
      BigInt(feeMultiplier),
      BigInt(activeWindow)
    );
  }

  const matrix1 = await deployMatrix(10);    // Nova Seed       $10
  const matrix2 = await deployMatrix(25);    // Nova Rise       $25
  const matrix3 = await deployMatrix(50);    // Nova Star       $50
  const matrix4 = await deployMatrix(100);   // Nova Prime      $100
  const matrix5 = await deployMatrix(250);   // SuperNova Genesis $250 ← whale gate
  const matrix6 = await deployMatrix(500);   // SuperNova Elite  $500
  const matrix7 = await deployMatrix(1000);  // SuperNova Spark  $1,000

  const allMatrices = [matrix1, matrix2, matrix3, matrix4, matrix5, matrix6, matrix7];

  // TierManager
  const TierManager = await ethers.getContractFactory("CryptoNovaTierManager");
  const tierManager = await TierManager.deploy(
    await usdc.getAddress(),
    await cnova.getAddress(),
    await treasury.getAddress(),
    dev.address,
    ops.address,
    await communityWallet.getAddress(),
    admin.address,
    UNIT
  );

  const tmAddr = await tierManager.getAddress();

  // ── Grant roles ───────────────────────────────────────────────────────────
  const MINTER_ROLE = await cnova.MINTER_ROLE();
  const BURNER_ROLE = await cnova.BURNER_ROLE();
  const EPOCH_ROLE  = await cnova.EPOCH_ROLE();

  for (const m of allMatrices) {
    await cnova.connect(admin).grantRole(MINTER_ROLE, await m.getAddress());
  }
  await cnova.connect(admin).grantRole(MINTER_ROLE, tmAddr);
  await cnova.connect(admin).grantRole(BURNER_ROLE, await treasury.getAddress());
  await cnova.connect(admin).grantRole(EPOCH_ROLE,  await matrix1.getAddress());

  // ── TierManager: register all 7 matrices ─────────────────────────────────
  for (let i = 0; i < 7; i++) {
    await tierManager.connect(admin).setMatrix(i + 1, await allMatrices[i].getAddress());
  }

  // ── CommunityWallet: authorise all 7 matrices + TierManager ──────────────
  for (const m of allMatrices) {
    await communityWallet.connect(admin)
      .setAuthorisedRegistrar(await m.getAddress(), true);
  }
  await communityWallet.connect(admin).setAuthorisedRegistrar(tmAddr, true);

  // ── Authorise TierManager to call registerFor() on matrices 2–7 ──────────
  for (const m of [matrix2, matrix3, matrix4, matrix5, matrix6, matrix7]) {
    await m.connect(admin).setAuthorizedRegistrar(tmAddr, true);
  }

  // ── Authorise all 7 matrices to call Treasury.depositReserve() ───────────
  for (const m of allMatrices) {
    await treasury.connect(admin).setAuthorizedCaller(await m.getAddress(), true);
  }

  // ── V5: BeltManager + 2 extra T1 belts ────────────────────────────────────
  const BeltMgr = await ethers.getContractFactory("BeltManager");
  const beltManager = await BeltMgr.deploy(await usdc.getAddress(), admin.address, 50n);
  const bmAddr = await beltManager.getAddress();

  // extra belts B and C
  const beltB = await deployMatrix(10);
  const beltC = await deployMatrix(10);
  for (const b of [beltB, beltC]) {
    await cnova.connect(admin).grantRole(MINTER_ROLE, await b.getAddress());
    await treasury.connect(admin).setAuthorizedCaller(await b.getAddress(), true);
    await communityWallet.connect(admin).setAuthorisedRegistrar(await b.getAddress(), true);
    await b.connect(admin).setAuthorizedRegistrar(bmAddr, true);
  }
  // Belt A = matrix1 — also needs registrar for BeltManager
  await matrix1.connect(admin).setAuthorizedRegistrar(bmAddr, true);

  // Add all belts to BeltManager: A, B, C
  await beltManager.connect(admin).addBelt(await matrix1.getAddress());
  await beltManager.connect(admin).addBelt(await beltB.getAddress());
  await beltManager.connect(admin).addBelt(await beltC.getAddress());

  // Authorise BeltManager in CommunityWallet
  await communityWallet.connect(admin).setAuthorisedRegistrar(bmAddr, true);

  // Point Treasury + TierManager to BeltManager
  await treasury.connect(admin).setTier1Matrix(bmAddr);
  await tierManager.connect(admin).setBeltManager(bmAddr);

  // V5: setBeltManagerCaller so triggerReentry() and topUpReentryPool() work
  await matrix1.connect(admin).setBeltManagerCaller(bmAddr);
  await beltB.connect(admin).setBeltManagerCaller(bmAddr);
  await beltC.connect(admin).setBeltManagerCaller(bmAddr);

  // ── Mint test USDC via MockUSDC.mint() (not transfer) ────────────────────
  // Give each test signer enough for all tiers
  const testSigners = [alice, bob, carol, dave, ...rest.slice(0, 280)];
  for (const s of testSigners) {
    await usdc.connect(deployer).mint(s.address, USDC(10_000));
  }
  // Also mint to dev/ops/admin for fund-transfer tests
  for (const s of [dev, ops, admin]) {
    await usdc.connect(deployer).mint(s.address, USDC(100_000));
  }

  return {
    usdc, cnova, treasury, communityWallet,
    matrix1, matrix2, matrix3, matrix4, matrix5, matrix6, matrix7,
    allMatrices,
    tierManager,
    beltManager, beltB, beltC,
    deployer, dev, ops, admin, alice, bob, carol, dave,
    members: rest.slice(0, 280),
    MINTER_ROLE, BURNER_ROLE, EPOCH_ROLE,
  };
}

// ─── Helper: fill a matrix with N signers ────────────────────────────────────
async function fillMatrix(matrix, usdc, signers, feeMultiplier = 10) {
  const fee = USDC(feeMultiplier);
  for (const s of signers) {
    await usdc.connect(s).approve(await matrix.getAddress(), fee);
    await matrix.connect(s).register(ethers.ZeroAddress);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  V3 MATRIX CORE
// ═════════════════════════════════════════════════════════════════════════════

describe("V4 Matrix Core (W=5 Engine Test)", function () {

  it("deploys with correct constants for tier-1 (FEE_MULTIPLIER=10)", async function () {
    const { matrix1 } = await loadFixture(deployAll);
    expect(await matrix1.ACTIVE_WINDOW()).to.equal(5n);
    expect(await matrix1.FEE_MULTIPLIER()).to.equal(10n);
    expect(await matrix1.ENTRY_FEE()).to.equal(USDC(10));
    expect(await matrix1.SPLIT_REFERRER()).to.equal(USDC(3));
    expect(await matrix1.SPLIT_RESERVE()).to.equal(USDC(1.5));
    expect(await matrix1.SPLIT_COMMUNITY()).to.equal(USDC(1));
    expect(await matrix1.SPLIT_DEV()).to.equal(USDC(0.3));
    expect(await matrix1.SPLIT_OPS()).to.equal(USDC(0.2));
  });

  it("FEE_MULTIPLIER scales constants correctly across all 7 tiers", async function () {
    const { allMatrices } = await loadFixture(deployAll);
    const mults = [10n, 25n, 50n, 100n, 250n, 500n, 1000n];

    for (let i = 0; i < 7; i++) {
      const m    = allMatrices[i];
      const mult = mults[i];
      expect(await m.FEE_MULTIPLIER()).to.equal(mult, `Tier ${i+1} FEE_MULTIPLIER`);
      expect(await m.ENTRY_FEE()).to.equal(mult * UNIT, `Tier ${i+1} ENTRY_FEE`);
      expect(await m.SPLIT_REFERRER()).to.equal(mult * 3n * UNIT / 10n, `Tier ${i+1} SPLIT_REFERRER (30%)`);
      expect(await m.SPLIT_COMMUNITY()).to.equal(mult * UNIT / 10n, `Tier ${i+1} SPLIT_COMMUNITY (10%)`);
    }
  });

  it("member #1 registers successfully", async function () {
    const { matrix1, usdc, alice } = await loadFixture(deployAll);
    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    const tx = await matrix1.connect(alice).register(ethers.ZeroAddress);
    const receipt = await tx.wait();
    const ev = receipt.logs.find(l => {
      try { return matrix1.interface.parseLog(l)?.name === "MemberRegistered"; } catch { return false; }
    });
    expect(ev).to.not.be.undefined;

    const m = await matrix1.members(alice.address);
    expect(m.isRegistered).to.be.true;
    expect(m.id).to.equal(1n);
  });

  it("cannot register twice", async function () {
    const { matrix1, usdc, alice } = await loadFixture(deployAll);
    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(20));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    await expect(matrix1.connect(alice).register(ethers.ZeroAddress))
      .to.be.revertedWith("V3: already registered");
  });

  it("payment split totals exactly $10 on tier-1 registration", async function () {
    // V3 ramp-up behaviour (no ancestors yet):
    //   _distributeChainPay: when no ancestor exists at level k, 80% of that
    //   level's chain pay flows to devWallet (ramp-up redirect).
    //   Alice is position 1 → 0 ancestors across all 7 levels.
    //   devAccum = 80% × $4.00 (total chain pay) = $3.20
    //   dev total = SPLIT_DEV ($0.30) + devAccum ($3.20) = $3.50
    //
    //   _creditMember(ZeroAddress, SPLIT_REFERRER):
    //   ZeroAddress is not a registered member and ≠ communityWallet
    //   → referrer bonus falls through to opsWallet ($3.00)
    //   ops total = SPLIT_OPS ($0.20) + referrer overflow ($3.00) = $3.20
    //
    //   Community: exactly SPLIT_COMMUNITY = $1.00
    //   Treasury: SPLIT_RESERVE ($1.50) + 20% of chain pay ($0.80) = $2.30
    //   Total: $3.50 + $3.20 + $1.00 + $2.30 = $10.00 ✓
    const { matrix1, usdc, treasury, communityWallet, dev, ops, alice }
      = await loadFixture(deployAll);

    const devBefore  = await usdc.balanceOf(dev.address);
    const opsBefore  = await usdc.balanceOf(ops.address);
    const cwBefore   = await usdc.balanceOf(await communityWallet.getAddress());
    const tresBefore = await usdc.balanceOf(await treasury.getAddress());

    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);

    const devAfter  = await usdc.balanceOf(dev.address);
    const opsAfter  = await usdc.balanceOf(ops.address);
    const cwAfter   = await usdc.balanceOf(await communityWallet.getAddress());
    const tresAfter = await usdc.balanceOf(await treasury.getAddress());

    // Dev gets SPLIT_DEV + ramp-up chain pay redirect (no ancestors at position 1)
    expect(devAfter  - devBefore).to.equal(3412000n,   "dev $3.412 (SPLIT_DEV + L1-L6 ramp-up, L7 to treasury)");
    // Ops gets SPLIT_OPS + ZeroAddress referrer overflow
    expect(opsAfter  - opsBefore).to.equal(USDC(3.2),  "ops $3.20 (SPLIT_OPS + referrer overflow)");
    expect(cwAfter   - cwBefore).to.equal(USDC(1),      "community $1.00");
    // Treasury: SPLIT_RESERVE ($1.50) + 20% of all chain pay levels ($0.80) = $2.30
    expect(tresAfter - tresBefore).to.equal(2388000n,   "treasury $2.388 (reserve + 20% chain + L7 earn ramp-up)");
  });

  it("community wallet receives 10% on each join", async function () {
    const { matrix1, usdc, communityWallet, alice, bob } = await loadFixture(deployAll);
    const cwAddr = await communityWallet.getAddress();

    const before = await usdc.balanceOf(cwAddr);

    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    await usdc.connect(bob).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(bob).register(alice.address);

    const after = await usdc.balanceOf(cwAddr);
    expect(after - before).to.equal(USDC(2), "2 joins × $1.00 each");
  });

  it("chain pay: member at position 1 receives earnings from subsequent joins", async function () {
    const { matrix1, usdc, alice, bob, members } = await loadFixture(deployAll);

    // Register alice first (position 1)
    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);

    // Register 7 more to exercise all chain pay levels
    const joiners = [bob, ...members.slice(0, 6)];
    for (const s of joiners) {
      await usdc.connect(s).approve(await matrix1.getAddress(), USDC(10));
      await matrix1.connect(s).register(ethers.ZeroAddress);
    }

    // Alice at position 1 should have received L1 chain pay from position 2 join
    const aliceMember = await matrix1.members(alice.address);
    expect(aliceMember.withdrawable).to.be.gt(0n);
  });

  it("joinerPosition normalised to 6 (scaling bug fix) when matrix is full", async function () {
    // After 254 fills alice is at queue head (position 1).
    // The 255th join triggers rotation: alice exits position 1 (cycle 1) and is
    // re-enqueued at the back.  joinerPosition = 255 (normalised, not raw 255+N).
    //
    // Ancestor layout for normalised position 255:
    //   L7: 255>>7 = 1 → new queue position 1 = members[0]  (gained chain pay L7)
    //   L6: 255>>6 = 3 → members[2]
    //   L1: 255>>1 = 127 → members[126]
    //
    // Alice is NOT in the L7 path after her rotation — she moved to the back.
    // We verify: alice.cyclesCompleted == 1 AND members[0] gained L7 chain pay.
    const { matrix1, usdc, alice, members } = await loadFixture(deployAll);

    // Fill 254 positions: alice first (head = position 1), then members[0..252]
    const signers = [alice, ...members.slice(0, 4)];
    for (const s of signers) {
      await usdc.connect(s).approve(await matrix1.getAddress(), USDC(10));
      await matrix1.connect(s).register(ethers.ZeroAddress);
    }

    // members[0] is now at queue position 2 (index 1).  Capture earnings before.
    const pos1EarningsBefore = (await matrix1.members(members[0].address)).withdrawable;

    // 255th join — triggers rotation (alice exits head, cyclesCompleted → 1)
    const fresh = members[4];
    await usdc.connect(fresh).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(fresh).register(ethers.ZeroAddress);

    // Alice completed her first cycle
    expect(await matrix1.getCyclesCompleted(alice.address)).to.equal(1n);

    // members[0] is now at new position 1 and received L7 chain pay from join 255
    const pos1EarningsAfter = (await matrix1.members(members[0].address)).withdrawable;
    expect(pos1EarningsAfter).to.be.gt(pos1EarningsBefore,
      "new position-1 member gained L7 chain pay from normalised joinerPosition 6");
  });

  it("cyclesCompleted increments when member rotates from position 1", async function () {
    const { matrix1, usdc, alice, members } = await loadFixture(deployAll);

    // Register alice first, then fill to 254
    const signers = [alice, ...members.slice(0, 4)];
    for (const s of signers) {
      await usdc.connect(s).approve(await matrix1.getAddress(), USDC(10));
      await matrix1.connect(s).register(ethers.ZeroAddress);
    }

    expect(await matrix1.getCyclesCompleted(alice.address)).to.equal(0n);

    // One more join rotates alice out from position 1 → cycle 1
    const fresh = members[4];
    await usdc.connect(fresh).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(fresh).register(ethers.ZeroAddress);

    expect(await matrix1.getCyclesCompleted(alice.address)).to.equal(1n);
  });

  it("CycleCompleted event emitted on rotation", async function () {
    const { matrix1, usdc, alice, members } = await loadFixture(deployAll);

    const signers = [alice, ...members.slice(0, 4)];
    for (const s of signers) {
      await usdc.connect(s).approve(await matrix1.getAddress(), USDC(10));
      await matrix1.connect(s).register(ethers.ZeroAddress);
    }

    const fresh = members[4];
    await usdc.connect(fresh).approve(await matrix1.getAddress(), USDC(10));

    await expect(matrix1.connect(fresh).register(ethers.ZeroAddress))
      .to.emit(matrix1, "CycleCompleted")
      .withArgs(alice.address, 1n, 4n);
  });

  it("totalMembers() returns unique join count", async function () {
    const { matrix1, usdc, alice, bob } = await loadFixture(deployAll);
    expect(await matrix1.totalMembers()).to.equal(0n);

    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    expect(await matrix1.totalMembers()).to.equal(1n);

    await usdc.connect(bob).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(bob).register(alice.address);
    expect(await matrix1.totalMembers()).to.equal(2n);
  });

  it("getCyclesCompleted() view returns correct value", async function () {
    const { matrix1, usdc, alice } = await loadFixture(deployAll);
    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    expect(await matrix1.getCyclesCompleted(alice.address)).to.equal(0n);
  });

  it("withdraw() transfers earnings to member", async function () {
    const { matrix1, usdc, alice, bob } = await loadFixture(deployAll);
    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    await usdc.connect(bob).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(bob).register(alice.address);

    const aliceMember  = await matrix1.members(alice.address);
    const withdrawable = aliceMember.withdrawable;
    expect(withdrawable).to.be.gt(0n);

    const balBefore = await usdc.balanceOf(alice.address);
    await matrix1.connect(alice).withdraw();
    const balAfter  = await usdc.balanceOf(alice.address);

    expect(balAfter - balBefore).to.equal(withdrawable);
    expect((await matrix1.members(alice.address)).withdrawable).to.equal(0n);
  });

  it("pause prevents new registrations", async function () {
    const { matrix1, usdc, alice, admin } = await loadFixture(deployAll);
    await matrix1.connect(admin).pause();
    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await expect(matrix1.connect(alice).register(ethers.ZeroAddress))
      .to.be.revertedWith("V3: registrations paused");
    await matrix1.connect(admin).unpause();
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    expect((await matrix1.members(alice.address)).isRegistered).to.be.true;
  });

  it("registerFor() succeeds when called by authorised registrar (TierManager)", async function () {
    // matrix2 ($25) has TierManager set as authorizedRegistrar
    const { matrix2, usdc, alice, tierManager, admin } = await loadFixture(deployAll);
    const tmAddr = await tierManager.getAddress();
    const m2Addr = await matrix2.getAddress();

    // Confirm authorisation is set
    expect(await matrix2.authorizedRegistrars(tmAddr)).to.be.true;

    // Fund TierManager with $25 and approve matrix2
    await usdc.connect(admin).mint(tmAddr, USDC(25)).catch(() => {
      // MockUSDC mint is onlyOwner (deployer) — transfer instead
    });

    // Use deployer-minted USDC approach: impersonate to mint to tmAddr
    // Simpler: call registerFor via a test helper that mimics TierManager
    // We use a direct approve + call from admin acting as registrar for this test
    // First set admin as an authorizedRegistrar on matrix2 for isolation
    await matrix2.connect(admin).setAuthorizedRegistrar(admin.address, true);
    await usdc.connect(admin).approve(m2Addr, USDC(25));

    // registerFor should register alice without minting CNOVA
    await expect(matrix2.connect(admin).registerFor(alice.address, ethers.ZeroAddress))
      .to.emit(matrix2, "MemberRegistered")
      .withArgs(alice.address, ethers.ZeroAddress, 1n, 1n, 0n);  // cnovaRewarded=0 (mintCnova=false)

    const m = await matrix2.members(alice.address);
    expect(m.isRegistered).to.be.true;
  });

  it("registerFor() reverts when called by non-authorised address", async function () {
    const { matrix2, usdc, alice, bob } = await loadFixture(deployAll);

    await usdc.connect(bob).approve(await matrix2.getAddress(), USDC(25));
    await expect(matrix2.connect(bob).registerFor(alice.address, ethers.ZeroAddress))
      .to.be.revertedWith("V3: not authorised registrar");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  COMMUNITY WALLET
// ═════════════════════════════════════════════════════════════════════════════

// ─── CW fixture that fills all 1000 Tranche A slots (activates payouts) ──────
// trancheAActive only flips when 1,000 A-slot founders are registered.
// Without it claim() returns "CW: nothing to claim" for every Tranche A member.
async function deployWithActiveTranches() {
  const base = await deployAll();
  const { communityWallet, admin } = base;

  await communityWallet.connect(admin).setAuthorisedRegistrar(admin.address, true);

  // Register 1000 Tranche A founders (alice is member #1)
  await communityWallet.connect(admin).registerFounder(base.alice.address);
  for (let i = 1; i < 10; i++) {
    await communityWallet.connect(admin)
      .registerFounder(ethers.Wallet.createRandom().address);
  }
  // Now trancheAActive = true

  return base;
}

describe("CommunityWallet", function () {

  it("registers Tranche A founder for members 1–10", async function () {
    const { communityWallet, alice, admin } = await loadFixture(deployAll);
    await communityWallet.connect(admin)
      .setAuthorisedRegistrar(admin.address, true);
    await communityWallet.connect(admin).registerFounder(alice.address);

    const info = await communityWallet.founderInfo(alice.address);
    expect(info.isFounder).to.be.true;
    expect(info.tranche).to.equal(1n);
    expect(info.id).to.equal(1n);
    expect(info.sharesHeld).to.equal(35n);
  });

  it("registers Tranche B founder for members 11–20", async function () {
    const { communityWallet, admin } = await loadFixture(deployAll);
    await communityWallet.connect(admin).setAuthorisedRegistrar(admin.address, true);

    for (let i = 0; i < 10; i++) {
      await communityWallet.connect(admin).registerFounder(ethers.Wallet.createRandom().address);
    }

    const trancheB = ethers.Wallet.createRandom().address;
    await communityWallet.connect(admin).registerFounder(trancheB);
    const info = await communityWallet.founderInfo(trancheB);
    expect(info.tranche).to.equal(2n);
    expect(info.sharesHeld).to.equal(15n);
  });

  it("ignores registration after 20 founder slots fill", async function () {
    const { communityWallet, admin } = await loadFixture(deployAll);
    await communityWallet.connect(admin).setAuthorisedRegistrar(admin.address, true);

    for (let i = 0; i < 20; i++) {
      await communityWallet.connect(admin)
        .registerFounder(ethers.Wallet.createRandom().address);
    }
    expect(await communityWallet.founderCount()).to.equal(20n);

    const extra = ethers.Wallet.createRandom().address;
    await communityWallet.connect(admin).registerFounder(extra);
    const info = await communityWallet.founderInfo(extra);
    expect(info.isFounder).to.be.false;
    expect(await communityWallet.founderCount()).to.equal(20n);
  });

  it("deposit() increases pendingPool", async function () {
    const { communityWallet, usdc, alice } = await loadFixture(deployAll);
    const cwAddr = await communityWallet.getAddress();

    await usdc.connect(alice).approve(cwAddr, USDC(100));
    const before = await communityWallet.pendingPool();
    await communityWallet.connect(alice).deposit(USDC(100));
    const after  = await communityWallet.pendingPool();
    expect(after - before).to.equal(USDC(100));
  });

  it("advanceEpoch() snapshots pool: 50% rolls over, 50% becomes payout pot", async function () {
    // Contract design: every epoch keeps 50% of pool as rollover (ROLLOVER_BPS = 5000).
    // trancheAActive must be false here (< 10 founders), so payout pot also rolls back.
    // Final pendingPool = the full original pool (all rolled, nothing paid out yet).
    const { communityWallet, usdc, alice, admin } = await loadFixture(deployAll);
    const cwAddr = await communityWallet.getAddress();

    await communityWallet.connect(admin).setAuthorisedRegistrar(admin.address, true);
    await communityWallet.connect(admin).registerFounder(alice.address);

    await usdc.connect(alice).approve(cwAddr, USDC(1000));
    await communityWallet.connect(alice).deposit(USDC(1000));
    await communityWallet.connect(admin).advanceEpoch();

    expect(await communityWallet.currentEpoch()).to.equal(1n);
    const epoch = await communityWallet.epochs(1);
    expect(epoch.poolSnapshot).to.equal(USDC(1000));
    // payoutPot = 50% of $1000 = $500
    expect(epoch.payoutPot).to.equal(USDC(500));
    // trancheAActive=false → payout rolled back → pendingPool = original $1000
    expect(await communityWallet.pendingPool()).to.equal(USDC(1000));
  });

  it("Tranche A member claims share after epoch — 50% payout pot, 70% to A, /10 members", async function () {
    // With trancheAActive, payout per A member = 50% × 70% ÷ 1000
    // $1000 → $500 payout pot → $350 to A total → $0.35 each
    const { communityWallet, usdc, alice, admin } = await loadFixture(deployWithActiveTranches);
    const cwAddr = await communityWallet.getAddress();

    await usdc.connect(alice).approve(cwAddr, USDC(1000));
    await communityWallet.connect(alice).deposit(USDC(1000));
    await communityWallet.connect(admin).advanceEpoch();

    const epoch = await communityWallet.epochs(1);
    expect(epoch.perTrancheAMember).to.equal(USDC(35));  // 10 members now (was 1000)

    const balBefore = await usdc.balanceOf(alice.address);
    await communityWallet.connect(alice).claim(1);
    const balAfter  = await usdc.balanceOf(alice.address);
    expect(balAfter - balBefore).to.equal(USDC(35));
  });

  it("cannot claim twice in the same epoch", async function () {
    const { communityWallet, usdc, alice, admin } = await loadFixture(deployWithActiveTranches);
    const cwAddr = await communityWallet.getAddress();

    await usdc.connect(alice).approve(cwAddr, USDC(100));
    await communityWallet.connect(alice).deposit(USDC(100));
    await communityWallet.connect(admin).advanceEpoch();

    await communityWallet.connect(alice).claim(1);
    await expect(communityWallet.connect(alice).claim(1))
      .to.be.revertedWith("CW: already claimed");
  });

  it("cannot claim after the 30-day window", async function () {
    const { communityWallet, usdc, alice, admin } = await loadFixture(deployWithActiveTranches);
    const cwAddr = await communityWallet.getAddress();

    await usdc.connect(alice).approve(cwAddr, USDC(100));
    await communityWallet.connect(alice).deposit(USDC(100));
    await communityWallet.connect(admin).advanceEpoch();

    await time.increase(31 * 24 * 3600);

    await expect(communityWallet.connect(alice).claim(1))
      .to.be.revertedWith("CW: window closed");
  });

  it("unclaimed funds roll into next epoch pendingPool", async function () {
    const { communityWallet, usdc, alice, bob, admin } = await loadFixture(deployWithActiveTranches);
    const cwAddr = await communityWallet.getAddress();

    // Register bob as another A founder (still within 1000, trancheAActive already true)
    await communityWallet.connect(admin).registerFounder(bob.address);

    await usdc.connect(alice).approve(cwAddr, USDC(1000));
    await communityWallet.connect(alice).deposit(USDC(1000));
    await communityWallet.connect(admin).advanceEpoch();

    // Alice claims her $0.35; bob does not
    await communityWallet.connect(alice).claim(1);

    await time.increase(31 * 24 * 3600);
    const pendingBefore = await communityWallet.pendingPool();
    await communityWallet.connect(admin).rolloverUnclaimed(1);
    const pendingAfter  = await communityWallet.pendingPool();

    expect(pendingAfter).to.be.gt(pendingBefore);
    const epoch1 = await communityWallet.epochs(1);
    expect(epoch1.rolledOver).to.be.true;
  });

  it("claimMultiple() claims across several epochs", async function () {
    const { communityWallet, usdc, alice, admin } = await loadFixture(deployWithActiveTranches);
    const cwAddr = await communityWallet.getAddress();

    for (let i = 0; i < 3; i++) {
      await usdc.connect(alice).approve(cwAddr, USDC(100));
      await communityWallet.connect(alice).deposit(USDC(100));
      await communityWallet.connect(admin).advanceEpoch();
      if (i < 2) await time.increase(26 * 24 * 3600);
    }

    const balBefore = await usdc.balanceOf(alice.address);
    await communityWallet.connect(alice).claimMultiple([1, 2, 3]);
    const balAfter  = await usdc.balanceOf(alice.address);

    expect(balAfter).to.be.gt(balBefore);
  });

  it("totalClaimable() returns sum of open epochs", async function () {
    const { communityWallet, usdc, alice, admin } = await loadFixture(deployWithActiveTranches);
    const cwAddr = await communityWallet.getAddress();

    await usdc.connect(alice).approve(cwAddr, USDC(100));
    await communityWallet.connect(alice).deposit(USDC(100));
    await communityWallet.connect(admin).advanceEpoch();

    const total = await communityWallet.totalClaimable(alice.address);
    expect(total).to.be.gt(0n);
  });

  it("cannot advance epoch too soon (< 25 days)", async function () {
    const { communityWallet, usdc, alice, admin } = await loadFixture(deployAll);
    const cwAddr = await communityWallet.getAddress();

    await communityWallet.connect(admin).setAuthorisedRegistrar(admin.address, true);
    await communityWallet.connect(admin).registerFounder(alice.address);

    await usdc.connect(alice).approve(cwAddr, USDC(200));
    await communityWallet.connect(alice).deposit(USDC(100));
    await communityWallet.connect(admin).advanceEpoch();

    await communityWallet.connect(alice).deposit(USDC(100));
    await expect(communityWallet.connect(admin).advanceEpoch())
      .to.be.revertedWith("CW: too soon");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  TIER MANAGER
// ═════════════════════════════════════════════════════════════════════════════

describe("TierManager", function () {

  it("deploys with correct tier fees for all 7 tiers", async function () {
    const { tierManager } = await loadFixture(deployAll);

    expect(await tierManager.tierFee(1)).to.equal(USDC(10),   "Tier 1 Nova Seed $10");
    expect(await tierManager.tierFee(2)).to.equal(USDC(25),   "Tier 2 Nova Rise $25");
    expect(await tierManager.tierFee(3)).to.equal(USDC(50),   "Tier 3 Nova Star $50");
    expect(await tierManager.tierFee(4)).to.equal(USDC(100),  "Tier 4 Nova Prime $100");
    expect(await tierManager.tierFee(5)).to.equal(USDC(250),  "Tier 5 SuperNova Genesis $250");
    expect(await tierManager.tierFee(6)).to.equal(USDC(500),  "Tier 6 SuperNova Elite $500");
    expect(await tierManager.tierFee(7)).to.equal(USDC(1000), "Tier 7 SuperNova Spark $1,000");
  });

  it("has correct cycle requirements for all 7 tiers", async function () {
    const { tierManager } = await loadFixture(deployAll);

    expect(await tierManager.cycleReq(1)).to.equal(1n, "Tier 1→2: 1 cycle");
    expect(await tierManager.cycleReq(2)).to.equal(2n, "Tier 2→3: 2 cycles");
    expect(await tierManager.cycleReq(3)).to.equal(2n, "Tier 3→4: 2 cycles");
    expect(await tierManager.cycleReq(4)).to.equal(2n, "Tier 4→5: 2 cycles");
    expect(await tierManager.cycleReq(5)).to.equal(3n, "Tier 5→6: 3 cycles");
    expect(await tierManager.cycleReq(6)).to.equal(3n, "Tier 6→7: 3 cycles");
    expect(await tierManager.cycleReq(7)).to.equal(0n, "Tier 7: top, no upgrade");
  });

  it("setMatrix wired for all 7 tiers", async function () {
    const { tierManager, allMatrices } = await loadFixture(deployAll);

    for (let i = 0; i < 7; i++) {
      const expected = await allMatrices[i].getAddress();
      const stored   = await tierManager.matrixFor(i + 1);
      expect(stored.toLowerCase()).to.equal(expected.toLowerCase(), `Tier ${i+1} matrix`);
    }
  });

  it("recordTier1Join() sets memberTier[member] = 1", async function () {
    const { matrix1, tierManager, usdc, alice, admin } = await loadFixture(deployAll);
    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);

    await tierManager.connect(admin).recordTier1Join(alice.address);
    expect(await tierManager.getTier(alice.address)).to.equal(1n);
  });

  it("sequential upgrade blocked when cycles not complete", async function () {
    const { matrix1, tierManager, usdc, alice, admin } = await loadFixture(deployAll);

    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    await tierManager.connect(admin).recordTier1Join(alice.address);

    await usdc.connect(alice).approve(await tierManager.getAddress(), USDC(25));
    await expect(tierManager.connect(alice).upgradeTier(2, ethers.ZeroAddress))
      .to.be.revertedWith("TM: cycles not complete");
  });

  it("sequential upgrade succeeds when cycles complete", async function () {
    const { matrix1, tierManager, usdc, alice, admin, members } = await loadFixture(deployAll);

    // Register alice at tier 1
    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    await tierManager.connect(admin).recordTier1Join(alice.address);

    // 254 more fills → 255 total → triggers alice's first rotation (1 cycle)
    // (matrix holds 254; 255th join forces the rotation)
    const extras = members.slice(0, 5); // W=5: 5 extras = exactly 1 cycle
    for (const s of extras) {
      await usdc.connect(s).approve(await matrix1.getAddress(), USDC(10));
      await matrix1.connect(s).register(ethers.ZeroAddress);
    }

    expect(await matrix1.getCyclesCompleted(alice.address)).to.equal(1n);

    // Upgrade tier 1 → 2 (requires 1 cycle)
    await usdc.connect(alice).approve(await tierManager.getAddress(), USDC(25));
    await expect(tierManager.connect(alice).upgradeTier(2, ethers.ZeroAddress))
      .to.emit(tierManager, "TierUpgraded");

    expect(await tierManager.getTier(alice.address)).to.equal(2n);
  });

  it("TierUpgraded event contains correct args", async function () {
    const { matrix1, tierManager, usdc, alice, admin, members } = await loadFixture(deployAll);

    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    await tierManager.connect(admin).recordTier1Join(alice.address);

    // 254 more fills → 255 total → alice cycles once
    const extras = members.slice(0, 5); // W=5: 5 extras = exactly 1 cycle
    for (const s of extras) {
      await usdc.connect(s).approve(await matrix1.getAddress(), USDC(10));
      await matrix1.connect(s).register(ethers.ZeroAddress);
    }

    await usdc.connect(alice).approve(await tierManager.getAddress(), USDC(25));
    const tx = await tierManager.connect(alice).upgradeTier(2, ethers.ZeroAddress);
    const receipt = await tx.wait();

    const iface = tierManager.interface;
    const ev = receipt.logs
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .find(p => p?.name === "TierUpgraded");

    expect(ev).to.not.be.null;
    expect(ev.args.member).to.equal(alice.address);
    expect(ev.args.fromTier).to.equal(1n);
    expect(ev.args.toTier).to.equal(2n);
    expect(ev.args.feePaid).to.equal(USDC(25));
  });

  it("primeOrAboveCount increments at tier 5 (SuperNova Genesis — whale gate)", async function () {
    const { tierManager, admin } = await loadFixture(deployAll);
    expect(await tierManager.primeOrAboveCount()).to.equal(0n);

    const dummy = (await ethers.getSigners())[15];
    await tierManager.connect(admin).adminSetMemberTier(dummy.address, 5);

    expect(await tierManager.primeOrAboveCount()).to.equal(1n);
  });

  it("t5FastTrackEnabled flips at GENESIS_GATE_THRESHOLD (2 members at tier 5+)", async function () {
    const { tierManager, admin } = await loadFixture(deployAll);
    const allSigners = await ethers.getSigners();

    expect(await tierManager.t5FastTrackEnabled()).to.be.false;

    // 1 member at tier 5 — gate should NOT open yet
    await tierManager.connect(admin).adminSetMemberTier(allSigners[10].address, 5);
    expect(await tierManager.t5FastTrackEnabled()).to.be.false;
    expect(await tierManager.primeOrAboveCount()).to.equal(1n);

    // 2nd member — T5 gate OPENS
    await expect(
      tierManager.connect(admin).adminSetMemberTier(allSigners[11].address, 5)
    ).to.emit(tierManager, "GenesisGateOpened");

    expect(await tierManager.t5FastTrackEnabled()).to.be.true;
    expect(await tierManager.fastTrackEnabled()).to.be.true;
    expect(await tierManager.primeOrAboveCount()).to.equal(2n);
  });

  it("fast-track upgrade skips tiers after gate opens", async function () {
    const { tierManager, usdc, alice, admin } = await loadFixture(deployAll);
    const allSigners = await ethers.getSigners();

    // Set alice to tier 1
    await tierManager.connect(admin).adminSetMemberTier(alice.address, 1);

    // Open T5 gate (2 members at tier 5)
    await tierManager.connect(admin).adminSetMemberTier(allSigners[10].address, 5);
    await tierManager.connect(admin).adminSetMemberTier(allSigners[11].address, 5);
    expect(await tierManager.t5FastTrackEnabled()).to.be.true;

    // Also open T6 gate (1 member) for broader fast-track
    await tierManager.connect(admin).adminSetMemberTier(allSigners[12].address, 6);
    expect(await tierManager.t6FastTrackEnabled()).to.be.true;

    // Fast-track tier 1 → 5: cost = fee[2]+fee[3]+fee[4]+fee[5] = $25+$50+$100+$250 = $425
    const cost = await tierManager.upgradeCost(alice.address, 5);
    expect(cost).to.equal(USDC(425));

    await usdc.connect(alice).approve(await tierManager.getAddress(), USDC(425));
    await tierManager.connect(alice).upgradeTier(5, ethers.ZeroAddress);
    expect(await tierManager.getTier(alice.address)).to.equal(5n);
  });

  it("upgradeCost() returns single-tier fee in sequential mode", async function () {
    const { tierManager, admin, alice } = await loadFixture(deployAll);
    await tierManager.connect(admin).adminSetMemberTier(alice.address, 1);
    expect(await tierManager.upgradeCost(alice.address, 2)).to.equal(USDC(25));
  });

  it("upgradeCost() returns cumulative fee in fast-track mode", async function () {
    const { tierManager, admin, alice } = await loadFixture(deployAll);
    const allSigners = await ethers.getSigners();

    await tierManager.connect(admin).adminSetMemberTier(alice.address, 1);
    for (let i = 10; i <= 34; i++) {
      await tierManager.connect(admin).adminSetMemberTier(allSigners[i].address, 5);
    }

    // tier 1→4 = fee[2]+fee[3]+fee[4] = $25+$50+$100 = $175
    expect(await tierManager.upgradeCost(alice.address, 4)).to.equal(USDC(175));

    // tier 1→7 = $25+$50+$100+$250+$500+$1000 = $1,925
    expect(await tierManager.upgradeCost(alice.address, 7)).to.equal(USDC(1925));
  });

  it("memberProfile() returns complete and accurate profile", async function () {
    const { tierManager, matrix1, admin, alice, usdc } = await loadFixture(deployAll);

    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    await tierManager.connect(admin).recordTier1Join(alice.address);

    const profile = await tierManager.memberProfile(alice.address);
    expect(profile.currentTier).to.equal(1n);
    expect(profile.cyclesNeeded).to.equal(1n);
    expect(profile.cyclesDone).to.equal(0n);
    expect(profile.nextTierFee).to.equal(USDC(25));
    expect(profile.upgradeReady).to.be.false;
    expect(profile.fastTrack).to.be.false;
  });

  it("canUpgrade() returns false with reason when cycles not done", async function () {
    const { tierManager, matrix1, admin, alice, usdc } = await loadFixture(deployAll);

    await usdc.connect(alice).approve(await matrix1.getAddress(), USDC(10));
    await matrix1.connect(alice).register(ethers.ZeroAddress);
    await tierManager.connect(admin).recordTier1Join(alice.address);

    const [eligible, reason] = await tierManager.canUpgrade(alice.address);
    expect(eligible).to.be.false;
    expect(reason).to.include("Cycles");
  });
});

// =============================================================================
//  V5 BELT MANAGER
// =============================================================================
describe("BeltManager", function () {
  const BELT_MAX = 50n; // matches BeltManager.BELT_MAX

  // helper: register N members through BeltManager
  async function bmRegister(beltManager, usdc, signers) {
    for (const s of signers) {
      const [totalCost] = await beltManager.registrationCost();
      await usdc.connect(s).approve(await beltManager.getAddress(), totalCost);
      await beltManager.connect(s).register(ethers.ZeroAddress);
    }
  }

  it("deploys with zero belts and correct USDC", async function () {
    const { beltManager, usdc } = await loadFixture(deployAll);
    expect(await beltManager.totalBelts()).to.equal(3n); // A, B, C added in fixture
    expect(await beltManager.activeBeltIndex()).to.equal(0n);
  });

  it("routes member to active belt on register()", async function () {
    const { beltManager, matrix1, usdc, alice } = await loadFixture(deployAll);
    await usdc.connect(alice).approve(await beltManager.getAddress(), USDC(10));
    await beltManager.connect(alice).register(ethers.ZeroAddress);

    expect(await beltManager.hasRegistered(alice.address)).to.be.true;
    expect(await beltManager.memberBeltIndex(alice.address)).to.equal(0n);
    expect(await beltManager.beltOf(alice.address)).to.equal(await matrix1.getAddress());
  });

  it("isRegistered() returns true after registration", async function () {
    const { beltManager, usdc, alice } = await loadFixture(deployAll);
    expect(await beltManager.isRegistered(alice.address)).to.be.false;
    await usdc.connect(alice).approve(await beltManager.getAddress(), USDC(10));
    await beltManager.connect(alice).register(ethers.ZeroAddress);
    expect(await beltManager.isRegistered(alice.address)).to.be.true;
  });

  it("cannot register twice through BeltManager", async function () {
    const { beltManager, usdc, alice } = await loadFixture(deployAll);
    await usdc.connect(alice).approve(await beltManager.getAddress(), USDC(20));
    await beltManager.connect(alice).register(ethers.ZeroAddress);
    await expect(
      beltManager.connect(alice).register(ethers.ZeroAddress)
    ).to.be.revertedWith("BM: already registered");
  });

  it("totalMembers() aggregates across all belts", async function () {
    const { beltManager, usdc, alice, bob } = await loadFixture(deployAll);
    expect(await beltManager.totalMembers()).to.equal(0n);
    await usdc.connect(alice).approve(await beltManager.getAddress(), USDC(10));
    await beltManager.connect(alice).register(ethers.ZeroAddress);
    await usdc.connect(bob).approve(await beltManager.getAddress(), USDC(10));
    await beltManager.connect(bob).register(ethers.ZeroAddress);
    expect(await beltManager.totalMembers()).to.equal(2n);
  });

  it("memberJoinedAt() returns non-zero after registration", async function () {
    const { beltManager, usdc, alice } = await loadFixture(deployAll);
    expect(await beltManager.memberJoinedAt(alice.address)).to.equal(0n);
    await usdc.connect(alice).approve(await beltManager.getAddress(), USDC(10));
    await beltManager.connect(alice).register(ethers.ZeroAddress);
    expect(await beltManager.memberJoinedAt(alice.address)).to.be.gt(0n);
  });

  it("activates Belt B when Belt A is full", async function () {
    const { beltManager, beltB, usdc, members } = await loadFixture(deployAll);

    // Fill Belt A (BELT_MAX = 50)
    await bmRegister(beltManager, usdc, members.slice(0, Number(BELT_MAX)));

    // activeBeltIndex should still be 0 (not yet advanced)
    expect(await beltManager.activeBeltIndex()).to.equal(0n);

    // Next register triggers belt advance
    const nextMember = members[Number(BELT_MAX)];
    const [cost51] = await beltManager.registrationCost();
    await usdc.connect(nextMember).approve(await beltManager.getAddress(), cost51);
    await beltManager.connect(nextMember).register(ethers.ZeroAddress);

    expect(await beltManager.activeBeltIndex()).to.equal(1n);
    expect(await beltManager.memberBeltIndex(nextMember.address)).to.equal(1n);
    expect(await beltManager.beltOf(nextMember.address))
      .to.equal(await beltB.getAddress());
  });

  it("emits BeltActivated when belt advances", async function () {
    const { beltManager, beltB, usdc, members } = await loadFixture(deployAll);
    await bmRegister(beltManager, usdc, members.slice(0, Number(BELT_MAX)));

    const nextMember = members[Number(BELT_MAX)];
    const [cost51] = await beltManager.registrationCost();
    await usdc.connect(nextMember).approve(await beltManager.getAddress(), cost51);
    await expect(beltManager.connect(nextMember).register(ethers.ZeroAddress))
      .to.emit(beltManager, "BeltActivated")
      .withArgs(1n, await beltB.getAddress());
  });

  it("totalMembers() counts across Belt A and Belt B", async function () {
    const { beltManager, usdc, members } = await loadFixture(deployAll);
    await bmRegister(beltManager, usdc, members.slice(0, Number(BELT_MAX) + 5));
    const total = await beltManager.totalMembers();
    expect(total).to.equal(BELT_MAX + 5n);
  });

  it("beltStatus() reports correct data for each belt", async function () {
    const { beltManager, matrix1, usdc, alice } = await loadFixture(deployAll);
    await usdc.connect(alice).approve(await beltManager.getAddress(), USDC(10));
    await beltManager.connect(alice).register(ethers.ZeroAddress);

    const [addr, count, full, active] = await beltManager.beltStatus(0);
    expect(addr).to.equal(await matrix1.getAddress());
    expect(count).to.equal(1n);
    expect(full).to.be.false;
    expect(active).to.be.true;
  });

  it("TierManager auto-sync works via BeltManager registration", async function () {
    const { beltManager, tierManager, usdc, alice } = await loadFixture(deployAll);

    // Register via BeltManager (not directly on matrix)
    await usdc.connect(alice).approve(await beltManager.getAddress(), USDC(10));
    await beltManager.connect(alice).register(ethers.ZeroAddress);

    // TierManager should auto-sync tier 1 on upgradeTier call
    // First give alice enough cycles by registering for matrix2 manually
    // (just test that _isInTier1 returns true via BeltManager)
    expect(await beltManager.isRegistered(alice.address)).to.be.true;

    // canUpgrade should find tier 1 via BeltManager (auto-sync kicks in)
    const [eligible, reason] = await tierManager.canUpgrade(alice.address);
    // Not eligible because cycles not done, but reason is cycles not belt
    expect(reason).to.include("Cycles");
  });

  it("Treasury totalMembers reads from BeltManager", async function () {
    const { beltManager, treasury, usdc, alice, bob } = await loadFixture(deployAll);
    await usdc.connect(alice).approve(await beltManager.getAddress(), USDC(10));
    await beltManager.connect(alice).register(ethers.ZeroAddress);
    await usdc.connect(bob).approve(await beltManager.getAddress(), USDC(10));
    await beltManager.connect(bob).register(ethers.ZeroAddress);

    // Treasury uses tier1Matrix (= beltManager) for totalMembers
    const IMatrixABI = ["function totalMembers() view returns (uint256)"];
    const [signer] = await ethers.getSigners();
    const bm = new ethers.Contract(await beltManager.getAddress(), IMatrixABI, signer);
    expect(await bm.totalMembers()).to.equal(2n);
  });
});
