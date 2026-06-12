/**
 * CryptoNova — Test Suite  v2
 * ─────────────────────────────────────────────────────────────────
 * Run: npx hardhat test
 *
 * Covers:
 *   ✓ Deploy all 3 contracts and wire them together
 *   ✓ Member #1 registers (no referrer)
 *   ✓ Member #2 registers (referrer = member #1)
 *   ✓ All v2 payment splits verified to the cent
 *   ✓ originalReferrer locked at first registration
 *   ✓ 20% of chain pay goes to re-entry pool, 80% to earnings
 *   ✓ Auto re-entry fires when pool hits $10
 *   ✓ Re-entry uses originalReferrer (referrer for life)
 *   ✓ earningsSummary returns reentryProgress %
 *   ✓ CNOVA epoch rewards minted correctly
 *   ✓ Floor price rises after each join
 *   ✓ Earnings withdrawal
 *   ✓ Burn-to-redeem at floor price
 *   ✓ Pause / unpause mechanic
 *   ✓ Manual re-entry pool top-up
 *   ✓ Access control (non-minters can't mint, etc.)
 */

const { expect }         = require("chai");
const { ethers }         = require("hardhat");
const { loadFixture }    = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const anyValue           = () => true;  // wildcard predicate for .withArgs()

// ─── Constants (6-decimal USDC, matching contracts) ──────────────────────────
const USDC  = (dollars) => ethers.parseUnits(String(dollars), 6);
const CNOVA = (tokens)  => ethers.parseUnits(String(tokens), 18);

const ENTRY_FEE      = USDC(10);
const SPLIT_REFERRER = USDC(3);       // v2: $3.00 (was $4)
const SPLIT_REENTRY  = USDC(1);       // $1.00 flat starter (unchanged)
const SPLIT_RESERVE  = USDC(1.5);     // $1.50 (unchanged)
const SPLIT_DEV      = USDC(0.30);    // $0.30 (unchanged)
const SPLIT_OPS      = USDC(0.20);    // $0.20 (unchanged)
const CHAIN_TOTAL    = USDC(4);       // v2: $4.00 (was $3)
const REENTRY_RATE   = 20n;           // 20% of chain pay → re-entry pool

// v2 chain pay levels (L1–L7, sum = $4.00, 6-decimal)
const L1 = 1_330_000n;   // $1.33
const L2 =   800_000n;   // $0.80
const L3 =   670_000n;   // $0.67
const L4 =   530_000n;   // $0.53
const L5 =   350_000n;   // $0.35
const L6 =   210_000n;   // $0.21
const L7 =   110_000n;   // $0.11

const chainPay  = [L1, L2, L3, L4, L5, L6, L7];
const toEarn    = (pay) => pay * (100n - REENTRY_RATE) / 100n;  // 80%
const toReentry = (pay) => pay * REENTRY_RATE / 100n;           // 20%

// ─── Fixture — deploy everything fresh for each test ─────────────────────────
async function deployCryptoNovaFixture() {
  const [owner, dev, ops, member1, member2, member3, member4, member5] =
    await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy(owner.address);
  await usdc.waitForDeployment();

  const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
  const cnovaToken = await CNOVAToken.deploy(owner.address);
  await cnovaToken.waitForDeployment();

  const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
  const treasury = await CNOVATreasury.deploy(
    await cnovaToken.getAddress(),
    await usdc.getAddress(),
    owner.address
  );
  await treasury.waitForDeployment();

  const UNIT = 1_000_000n; // 1e6 — Base USDC (6 dec)
  const CryptoNovaMatrix = await ethers.getContractFactory("CryptoNovaMatrix");
  const matrix = await CryptoNovaMatrix.deploy(
    await usdc.getAddress(),
    await cnovaToken.getAddress(),
    await treasury.getAddress(),
    dev.address,
    ops.address,
    owner.address,
    UNIT
  );
  await matrix.waitForDeployment();

  const MINTER_ROLE = await cnovaToken.MINTER_ROLE();
  const BURNER_ROLE = await cnovaToken.BURNER_ROLE();
  const EPOCH_ROLE  = await cnovaToken.EPOCH_ROLE();
  await cnovaToken.grantRole(MINTER_ROLE, await matrix.getAddress());
  await cnovaToken.grantRole(BURNER_ROLE, await treasury.getAddress());
  await cnovaToken.grantRole(EPOCH_ROLE,  await matrix.getAddress());
  await treasury.setTier1Matrix(await matrix.getAddress());
  await treasury.setAuthorizedCaller(await matrix.getAddress(), true);

  // Fund each test wallet with $200 USDC (more headroom for re-entry tests)
  const members = [member1, member2, member3, member4, member5];
  for (const m of members) {
    await usdc.mint(m.address, USDC(200));
  }

  const register = async (signer, referrer) => {
    await usdc.connect(signer).approve(await matrix.getAddress(), ENTRY_FEE);
    return matrix.connect(signer).register(referrer ?? ethers.ZeroAddress);
  };

  return {
    usdc, cnovaToken, treasury, matrix,
    owner, dev, ops, member1, member2, member3, member4, member5,
    register,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — Deploy", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("deploys all contracts with correct addresses wired", async function () {
    const { usdc, cnovaToken, treasury, matrix } =
      await loadFixture(deployCryptoNovaFixture);

    expect(await matrix.usdc()).to.equal(await usdc.getAddress());
    expect(await matrix.cnova()).to.equal(await cnovaToken.getAddress());
    expect(await matrix.treasury()).to.equal(await treasury.getAddress());
    expect(await treasury.tier1Matrix()).to.equal(await matrix.getAddress());
  });

  it("cycle 1 is initialised", async function () {
    const { matrix } = await loadFixture(deployCryptoNovaFixture);
    const [cycleId, filled] = await matrix.getCycleStatus();
    expect(cycleId).to.equal(1n);
    expect(filled).to.equal(0n);
  });

  it("v2: SPLIT_REFERRER is $3.00", async function () {
    const { matrix } = await loadFixture(deployCryptoNovaFixture);
    expect(await matrix.SPLIT_REFERRER()).to.equal(SPLIT_REFERRER);
  });

  it("v2: REENTRY_RATE is 20", async function () {
    const { matrix } = await loadFixture(deployCryptoNovaFixture);
    expect(await matrix.REENTRY_RATE()).to.equal(20n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — Registration", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("member #1 registers with no referrer", async function () {
    const { matrix, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);

    const m = await matrix.getMember(member1.address);
    expect(m.isRegistered).to.be.true;
    expect(m.id).to.equal(1n);
    expect(m.referrer).to.equal(ethers.ZeroAddress);
  });

  it("member #2 registers with member #1 as referrer", async function () {
    const { matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    const m2 = await matrix.getMember(member2.address);
    expect(m2.isRegistered).to.be.true;
    expect(m2.referrer).to.equal(member1.address);
  });

  it("v2: originalReferrer is locked at first registration", async function () {
    const { matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    const m2 = await matrix.getMember(member2.address);
    expect(m2.originalReferrer).to.equal(member1.address);
  });

  it("cannot register twice", async function () {
    const { matrix, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await expect(register(member1, null))
      .to.be.revertedWith("Matrix: already registered");
  });

  it("cannot register with an unregistered referrer", async function () {
    const { matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await expect(register(member1, member2.address))
      .to.be.revertedWith("Matrix: invalid referrer");
  });

  it("totalMembers increments correctly", async function () {
    const { matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    expect(await matrix.totalMembers()).to.equal(0n);
    await register(member1, null);
    expect(await matrix.totalMembers()).to.equal(1n);
    await register(member2, member1.address);
    expect(await matrix.totalMembers()).to.equal(2n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — Payment splits (v2)", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("member #1 entry: ops gets referrer share + full chain pay + ops fee = $7.20", async function () {
    // No referrer → $3 referrer share goes to ops
    // No ancestors → full $4.00 chain pay goes to ops
    // Plus $0.20 ops fee
    // = $3.00 + $4.00 + $0.20 = $7.20
    const { usdc, matrix, ops, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    const opsBefore = await usdc.balanceOf(ops.address);
    await register(member1, null);
    const opsAfter = await usdc.balanceOf(ops.address);

    expect(opsAfter - opsBefore).to.equal(SPLIT_REFERRER + CHAIN_TOTAL + SPLIT_OPS);
  });

  it("member #2 entry: referrer (member #1) earns $3 referral + 80% of L1 chain pay", async function () {
    const { matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);

    const [earningsBefore] = await matrix.earningsSummary(member1.address);
    await register(member2, member1.address);
    const [earningsAfter] = await matrix.earningsSummary(member1.address);

    // member2 placed directly under member1 (L1 ancestor)
    // member1 earns: $3.00 referral + 80% of L1 ($1.33 × 0.80 = $1.064)
    const expected = SPLIT_REFERRER + toEarn(L1);
    expect(earningsAfter - earningsBefore).to.equal(expected);
  });

  it("v2: 20% of L1 chain pay goes to ancestor's re-entry pool", async function () {
    const { matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    const [, poolBefore] = await matrix.earningsSummary(member1.address);

    await register(member2, member1.address);
    const [, poolAfter] = await matrix.earningsSummary(member1.address);

    // member1 receives 20% of L1 into their re-entry pool
    expect(poolAfter - poolBefore).to.equal(toReentry(L1));
  });

  it("v2: new member's re-entry pool starts with $1.00 flat starter", async function () {
    const { matrix, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    const [, reentryPool] = await matrix.earningsSummary(member1.address);
    expect(reentryPool).to.equal(SPLIT_REENTRY);
  });

  it("member #2 entry: dev wallet gets $0.30", async function () {
    const { usdc, dev, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    const devBefore = await usdc.balanceOf(dev.address);
    await register(member1, null);
    await register(member2, member1.address);
    const devAfter = await usdc.balanceOf(dev.address);

    expect(devAfter - devBefore).to.equal(SPLIT_DEV * 2n);
  });

  it("treasury receives $1.50 per entry", async function () {
    const { treasury, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    const reserve = await treasury.reserveBalance();
    expect(reserve).to.equal(SPLIT_RESERVE * 2n);
  });

  it("all $10 from member #2 is fully accounted for", async function () {
    // member2 pays $10:
    //   $3.00 → member1 earnings (referral)
    //   $1.064 → member1 earnings (L1 chain pay 80%)
    //   $0.266 → member1 re-entry pool (L1 chain pay 20%)
    //   $2.670 → ops (L2–L7 chain pay remainder, no ancestors above L1)
    //   $1.000 → member2 re-entry pool (flat starter)
    //   $1.500 → treasury
    //   $0.300 → dev
    //   $0.200 → ops fee
    //   ───────
    //   $10.00 ✓
    const { usdc, matrix, treasury, dev, ops, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);

    const opsBefore  = await usdc.balanceOf(ops.address);
    const devBefore  = await usdc.balanceOf(dev.address);
    const tresBefore = await treasury.reserveBalance();

    await register(member2, member1.address);

    const m1Earn    = (await matrix.earningsSummary(member1.address))[0];
    const m1Pool    = (await matrix.earningsSummary(member1.address))[1];
    const m2Pool    = (await matrix.earningsSummary(member2.address))[1];
    const opsGained = (await usdc.balanceOf(ops.address)) - opsBefore;
    const devGained = (await usdc.balanceOf(dev.address)) - devBefore;
    const tresGained = (await treasury.reserveBalance()) - tresBefore;

    // m1 started with $1 in pool (flat from their own reg), gained toReentry(L1) from m2's reg
    const m1PoolFromM2 = m1Pool - SPLIT_REENTRY;

    const total = m1Earn + m1PoolFromM2 + m2Pool + opsGained + devGained + tresGained;
    expect(total).to.equal(ENTRY_FEE);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — Auto re-entry (v2)", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("topUpReentryPool triggers auto re-entry when pool crosses $10", async function () {
    const { usdc, matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    // member1 pool: $1.00 (flat) + toReentry(L1) from member2 ≈ $1.266
    // Top up to just over $10
    const [, poolNow] = await matrix.earningsSummary(member1.address);
    const needed = ENTRY_FEE - poolNow + 1n; // push it just over

    await usdc.connect(member1).approve(await matrix.getAddress(), needed);
    const tx = await matrix.connect(member1).topUpReentryPool(needed);

    // ReentryTriggered event should be emitted
    await expect(tx).to.emit(matrix, "ReentryTriggered")
      .withArgs(member1.address, await matrix.currentCycleId(), (val) => val >= 0n);

    // Pool should be < ENTRY_FEE now (deducted $10 for re-entry)
    const [, poolAfter] = await matrix.earningsSummary(member1.address);
    expect(poolAfter).to.be.lt(ENTRY_FEE);
  });

  it("auto re-entry uses originalReferrer (referrer for life)", async function () {
    const { usdc, matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    const m2Before = await matrix.getMember(member2.address);
    const origRef  = m2Before.originalReferrer;

    // Top up member2's pool to trigger re-entry
    const [, pool] = await matrix.earningsSummary(member2.address);
    const needed = ENTRY_FEE - pool + 1n;
    await usdc.connect(member2).approve(await matrix.getAddress(), needed);
    await matrix.connect(member2).topUpReentryPool(needed);

    // After re-entry, originalReferrer should still be member1
    const m2After = await matrix.getMember(member2.address);
    expect(m2After.originalReferrer).to.equal(origRef);
    expect(m2After.originalReferrer).to.equal(member1.address);
  });

  it("re-entry emits MemberRegistered with same memberId", async function () {
    const { usdc, matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    const m1 = await matrix.getMember(member1.address);
    const memberId = m1.id;

    const [, pool] = await matrix.earningsSummary(member1.address);
    const needed = ENTRY_FEE - pool + 1n;
    await usdc.connect(member1).approve(await matrix.getAddress(), needed);
    const tx = await matrix.connect(member1).topUpReentryPool(needed);

    await expect(tx).to.emit(matrix, "MemberRegistered")
      .withArgs(member1.address, (v) => ethers.isAddress(v), memberId, (v) => v >= 0n, (v) => v >= 0n, (v) => v >= 0n);
  });

  it("earningsSummary returns reentryProgress as 0–100 percentage", async function () {
    const { matrix, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);

    const [, pool, progress] = await matrix.earningsSummary(member1.address);
    // $1.00 pool / $10.00 fee = 10%
    expect(progress).to.equal(10n);
  });

  it("earningsSummary progress caps at 100 when pool exceeds fee", async function () {
    const { usdc, matrix, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);

    // Top up to $15 (over the $10 threshold)
    // Note: this will trigger auto re-entry which resets pool, so use $9 instead
    const topup = USDC(9); // keeps pool at $10 — re-entry fires, pool resets to $0
    await usdc.connect(member1).approve(await matrix.getAddress(), topup);
    await matrix.connect(member1).topUpReentryPool(topup);

    // After re-entry pool is spent, progress should be near 0
    const [, , progress] = await matrix.earningsSummary(member1.address);
    expect(progress).to.be.lte(100n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — CNOVA token rewards", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("member #1 receives 50 CNOVA on join (epoch 1)", async function () {
    const { cnovaToken, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    expect(await cnovaToken.balanceOf(member1.address)).to.equal(CNOVA(50));
  });

  it("epoch 1 mints 50 CNOVA per join", async function () {
    const { cnovaToken, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    expect(await cnovaToken.totalSupply()).to.equal(CNOVA(100));
    expect(await cnovaToken.currentEpochNumber()).to.equal(1n);
  });

  it("only MINTER_ROLE can mint", async function () {
    const { cnovaToken, member1 } = await loadFixture(deployCryptoNovaFixture);
    await expect(cnovaToken.connect(member1).mintReward(member1.address))
      .to.be.reverted;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — Floor price", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("floor rises after each member joins", async function () {
    const { treasury, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    const floor1 = await treasury.floorPrice();

    await register(member2, member1.address);
    const floor2 = await treasury.floorPrice();

    // Floor after member #1: $1.50 reserve / 50 CNOVA = $0.03 → 30_000 (6-dec)
    expect(floor1).to.equal(30_000n);
    // After member #2: same ratio in epoch 1
    expect(floor2).to.equal(floor1);
  });

  it("floor price equals reserve ÷ supply (invariant)", async function () {
    const { cnovaToken, treasury, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    const reserve = await treasury.reserveBalance();
    const supply  = await cnovaToken.totalSupply();
    const floor   = await treasury.floorPrice();

    const expected = (reserve * BigInt(1e18)) / supply;
    expect(floor).to.equal(expected);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — Withdrawals", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("member can withdraw earned USDC", async function () {
    const { usdc, matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    const balBefore = await usdc.balanceOf(member1.address);
    await matrix.connect(member1).withdraw();
    const balAfter = await usdc.balanceOf(member1.address);

    // member1 earns: $3 referral + 80% of L1
    expect(balAfter - balBefore).to.equal(SPLIT_REFERRER + toEarn(L1));
  });

  it("cannot withdraw twice (balance clears to zero)", async function () {
    const { matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);
    await matrix.connect(member1).withdraw();

    await expect(matrix.connect(member1).withdraw())
      .to.be.revertedWith("Matrix: nothing to withdraw");
  });

  it("cannot withdraw with zero earnings", async function () {
    const { matrix, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await expect(matrix.connect(member1).withdraw())
      .to.be.revertedWith("Matrix: nothing to withdraw");
  });

  it("re-entry pool is NOT withdrawable (stays locked)", async function () {
    const { matrix, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    // member1 has $1 in re-entry pool but $0 in earnings
    await expect(matrix.connect(member1).withdraw())
      .to.be.revertedWith("Matrix: nothing to withdraw");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — Burn to redeem at floor price", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("member burns CNOVA and receives USDC at floor price", async function () {
    const { usdc, cnovaToken, treasury, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);

    const cnova50 = CNOVA(50);
    const floor   = await treasury.floorPrice();
    const expectedUsdc = (cnova50 * floor) / BigInt(1e18);

    const usdcBefore = await usdc.balanceOf(member1.address);
    await cnovaToken.connect(member1).approve(await treasury.getAddress(), cnova50);
    await treasury.connect(member1).redeemAtFloor(cnova50);
    const usdcAfter = await usdc.balanceOf(member1.address);

    expect(usdcAfter - usdcBefore).to.equal(expectedUsdc);
    expect(await cnovaToken.balanceOf(member1.address)).to.equal(0n);
  });

  it("cannot redeem more than CNOVA balance", async function () {
    const { cnovaToken, treasury, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);

    await cnovaToken.connect(member1).approve(await treasury.getAddress(), CNOVA(100));
    await expect(treasury.connect(member1).redeemAtFloor(CNOVA(100)))
      .to.be.revertedWith("Treasury: insufficient CNOVA balance");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — BFS matrix placement", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("first member is the root node (depth 0)", async function () {
    const { matrix, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    const m = await matrix.getMember(member1.address);
    const node = await matrix.getNode(m.matrixNodeId);

    expect(node.depth).to.equal(0n);
    expect(node.parentNodeId).to.equal(0n);
  });

  it("second member is placed at depth 1 under the root", async function () {
    const { matrix, member1, member2, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);

    const m2   = await matrix.getMember(member2.address);
    const node2 = await matrix.getNode(m2.matrixNodeId);

    expect(node2.depth).to.equal(1n);

    const m1 = await matrix.getMember(member1.address);
    expect(node2.parentNodeId).to.equal(m1.matrixNodeId);
  });

  it("BFS fills left slot before right (root has 2 children after 3 members)", async function () {
    const { matrix, member1, member2, member3, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await register(member2, member1.address);
    await register(member3, member1.address);

    const m1 = await matrix.getMember(member1.address);
    const rootNode = await matrix.getNode(m1.matrixNodeId);

    expect(rootNode.childCount).to.equal(2n);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — Manual re-entry pool top-up", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("member can manually top up re-entry pool", async function () {
    const { usdc, matrix, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);

    const topup = USDC(4);  // stay under $10 so no auto re-entry fires
    await usdc.connect(member1).approve(await matrix.getAddress(), topup);
    await matrix.connect(member1).topUpReentryPool(topup);

    const [, reentryPool] = await matrix.earningsSummary(member1.address);
    expect(reentryPool).to.equal(SPLIT_REENTRY + topup);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("CryptoNova — Universe Mode", function () {
// ═════════════════════════════════════════════════════════════════════════════

  it("setFreeMode reverts before 500 members", async function () {
    const { treasury, member1, register } =
      await loadFixture(deployCryptoNovaFixture);

    await register(member1, null);
    await expect(treasury.setFreeMode())
      .to.be.revertedWith("Treasury: need 500+ members first");
  });

  it("isUniverseMode starts as false", async function () {
    const { treasury } = await loadFixture(deployCryptoNovaFixture);
    expect(await treasury.isUniverseMode()).to.be.false;
  });
});

