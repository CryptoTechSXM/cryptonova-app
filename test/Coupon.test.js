/**
 * Coupon.test.js — Full coverage for CouponRegistry + FigureEightMatrixV8.registerWithCoupon
 *
 * What we test:
 *  1. Leader issues coupon → $10 USDC locked in registry
 *  2. Member registers with valid code → enters matrix at reduced/zero cost, coupon marked used
 *  3. Double-spend rejected
 *  4. Wrong / nonexistent code rejected
 *  5. Expired code: registration fails, reclaim succeeds
 *  6. Reclaim before expiry → fails
 *  7. Reclaim after use → fails
 *  8. Owner disables registry (set address(0)) → coupon path reverts
 *  9. Owner re-enables → works again
 * 10. setCouponAmount updates future coupons but not existing ones
 * 11. Unauthorized matrix cannot call redeemCoupon
 * 12. selfRescue — parked member pays own shortfall, no debt
 * 13. cancelCoupon — issuer cancels before expiry (USDC back + event); non-issuer blocked;
 *     already-used or already-cancelled coupons blocked; cancelled coupon cannot be redeemed
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ── Helpers ────────────────────────────────────────────────────────────────────

function toUSDC(dollars) {
    return ethers.parseUnits(String(dollars), 6);
}

function hashCode(plainText) {
    return ethers.keccak256(ethers.toUtf8Bytes(plainText));
}

// Fast-forward time by `seconds`
async function increaseTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine");
}

// ── Fixture ────────────────────────────────────────────────────────────────────

async function deployFixture() {
    const [owner, devWallet, opsWallet, accountOne, issuer, member1, member2, rando, router] =
        await ethers.getSigners();

    // -- MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy(owner.address);

    // Mint USDC to participants
    for (const addr of [issuer, member1, member2, rando]) {
        await usdc.mint(addr.address, toUSDC(10_000));
    }

    // -- CNOVAToken
    const CNOVAToken = await ethers.getContractFactory("CNOVAToken");
    const cnova = await CNOVAToken.deploy(owner.address);

    // -- CNOVATreasury (constructor: cnova, usdc, admin)
    const CNOVATreasury = await ethers.getContractFactory("CNOVATreasury");
    const treasury = await CNOVATreasury.deploy(
        await cnova.getAddress(),
        await usdc.getAddress(),
        owner.address
    );

    // -- CouponRegistry
    const COUPON_AMOUNT = toUSDC(10); // $10
    const CouponRegistry = await ethers.getContractFactory("CouponRegistry");
    const registry = await CouponRegistry.deploy(await usdc.getAddress(), COUPON_AMOUNT);

    // -- MatrixLogicLib (deploy once, link into FigureEightMatrixV8)
    const MatrixLib = await ethers.getContractFactory("MatrixLogicLib");
    const matrixLib = await MatrixLib.deploy();
    await matrixLib.waitForDeployment();

    // -- FigureEightMatrixV8 (T1 MatA + MatB)
    const ENTRY_FEE   = toUSDC(10);
    const MATRIX_SIZE = 7; // small for tests

    // V8.32: splits sum to 4750 BPS (50% crossing reserve + 2.5% direct earn pre-allocated)
    const splitConfig = {
        l1Bps:        950,
        chainBps:     950,
        poolBps:     1568,
        treasuryBps:  713,
        stabilityBps: 238,
        devBps:       143,
        opsBps:        95,
        communityBps:  48,
        buybackBps:    45,
        liquidityBps:   0,
    };  // sum = 4750
    const chainPayBps = [475, 190, 143, 71, 36, 35];  // sum = 950 = chainBps

    const deployParams = {
        usdc:       await usdc.getAddress(),
        cnova:      await cnova.getAddress(),
        treasury:   await treasury.getAddress(),
        devWallet:  devWallet.address,
        opsWallet:  opsWallet.address,
        accountOne: accountOne.address,
        admin:      owner.address,
    };

    const FigureEightMatrixV8 = await ethers.getContractFactory("FigureEightMatrixV8", {
        libraries: { MatrixLogicLib: await matrixLib.getAddress() }
    });

    // Deploy MatA and MatB (partners)
    const matA = await FigureEightMatrixV8.deploy(
        deployParams, ENTRY_FEE, MATRIX_SIZE, true, 0, splitConfig, chainPayBps
    );
    const matB = await FigureEightMatrixV8.deploy(
        deployParams, ENTRY_FEE, MATRIX_SIZE, false, 0, splitConfig, chainPayBps
    );

    // Wire partners
    await matA.setPartner(await matB.getAddress());
    await matB.setPartner(await matA.getAddress());

    // V8.46 item 2b: coupon entry is router-guarded now (registerWithCoupon removed).
    // Authorize `router` (signer #8) to call enterWithCouponFrom in tests.
    await matA.setTierRouter(router.address);
    await matB.setTierRouter(router.address);

    // Wire coupon registry to MatA
    await matA.setCouponRegistry(await registry.getAddress());

    // Authorize MatA in the registry
    await registry.setAuthorizedMatrix(await matA.getAddress(), true);

    // Approve registry to pull USDC from issuer
    await usdc.connect(issuer).approve(await registry.getAddress(), ethers.MaxUint256);

    // Approve matA to pull USDC from members (for partial-pay cases)
    await usdc.connect(member1).approve(await matA.getAddress(), ethers.MaxUint256);
    await usdc.connect(member2).approve(await matA.getAddress(), ethers.MaxUint256);

    // Authorize matrices to call treasury.depositReserve
    await treasury.setAuthorizedCaller(await matA.getAddress(), true);
    await treasury.setAuthorizedCaller(await matB.getAddress(), true);

    return {
        owner, devWallet, opsWallet, accountOne, issuer, member1, member2, rando,
        usdc, cnova, treasury, registry, matA, matB,
        COUPON_AMOUNT, ENTRY_FEE, MATRIX_SIZE
    };
}

// ── Tests ──────────────────────────────────────────────────────────────────────


// V8.46 item 2b: the matrix's public registerWithCoupon() was removed (unguarded bypass).
// Route coupon entries through the guarded enterWithCouponFrom, called by the fixture's
// authorized `router` signer (index 8). Self-contained so no test needs `router` in scope.
async function couponEnter(mat, member, referrer, codeHash) {
  const router = (await ethers.getSigners())[8];
  return mat.connect(router).enterWithCouponFrom(member.address, referrer, codeHash);
}

describe("CouponRegistry", function () {

    // ── 1. issueCoupon ─────────────────────────────────────────────────────────

    describe("issueCoupon", function () {

        it("locks USDC in the registry and emits CouponIssued", async function () {
            const { registry, usdc, issuer, COUPON_AMOUNT } = await deployFixture();

            const code     = "LEADER-ABC-001";
            const codeHash = hashCode(code);

            const balBefore = await usdc.balanceOf(await registry.getAddress());
            const tx = await registry.connect(issuer).issueCoupon(codeHash);
            const balAfter  = await usdc.balanceOf(await registry.getAddress());

            expect(balAfter - balBefore).to.equal(COUPON_AMOUNT);

            const c = await registry.coupons(codeHash);
            await expect(tx)
                .to.emit(registry, "CouponIssued")
                .withArgs(codeHash, issuer.address, COUPON_AMOUNT, c.expiry);
        });

        it("records issuer, amount, expiry in the coupon struct", async function () {
            const { registry, issuer, COUPON_AMOUNT } = await deployFixture();
            const codeHash = hashCode("CODE-X");
            await registry.connect(issuer).issueCoupon(codeHash);

            const c = await registry.coupons(codeHash);
            expect(c.issuer).to.equal(issuer.address);
            expect(c.amount).to.equal(COUPON_AMOUNT);
            expect(c.used).to.be.false;
        });

        it("rejects duplicate code hash", async function () {
            const { registry, issuer } = await deployFixture();
            const codeHash = hashCode("DUPE");
            await registry.connect(issuer).issueCoupon(codeHash);
            await expect(registry.connect(issuer).issueCoupon(codeHash))
                .to.be.revertedWith("CR: code already taken");
        });

        it("rejects empty (zero) hash", async function () {
            const { registry, issuer } = await deployFixture();
            await expect(registry.connect(issuer).issueCoupon(ethers.ZeroHash))
                .to.be.revertedWith("CR: empty hash");
        });
    });

    // ── 2. redeemCoupon (via registerWithCoupon) ───────────────────────────────

    describe("redeemCoupon / registerWithCoupon", function () {

        it("coupon fully covers fee: member pays $0 from wallet, enters matrix", async function () {
            const { registry, usdc, matA, issuer, member1, COUPON_AMOUNT } =
                await deployFixture();

            // Coupon amount == entry fee ($10)
            const code     = "FULL-COVER";
            const codeHash = hashCode(code);
            await registry.connect(issuer).issueCoupon(codeHash);

            const walletBefore = await usdc.balanceOf(member1.address);

            await couponEnter(matA, member1, ethers.ZeroAddress, codeHash);

            const walletAfter = await usdc.balanceOf(member1.address);
            // Member should not have spent anything
            expect(walletBefore - walletAfter).to.equal(0n);

            // Member is now in the matrix
            expect(await matA.isInMatrix(member1.address)).to.be.true;

            // Coupon is marked used
            const c = await registry.coupons(codeHash);
            expect(c.used).to.be.true;
        });

        it("emits CouponApplied with correct amounts", async function () {
            const { registry, matA, issuer, member1 } = await deployFixture();

            const codeHash = hashCode("EMIT-TEST");
            await registry.connect(issuer).issueCoupon(codeHash);

            await expect(
                couponEnter(matA, member1, ethers.ZeroAddress, codeHash)
            ).to.emit(matA, "CouponApplied")
             .withArgs(member1.address, codeHash, toUSDC(10), 0n);
        });

        it("coupon partially covers fee when couponAmount < entryFee", async function () {
            const { registry, usdc, issuer, member1, matA } = await deployFixture();

            // Reduce coupon amount to $5
            await registry.setCouponAmount(toUSDC(5));

            const codeHash = hashCode("PARTIAL");
            await registry.connect(issuer).issueCoupon(codeHash);

            const walletBefore = await usdc.balanceOf(member1.address);
            await couponEnter(matA, member1, ethers.ZeroAddress, codeHash);
            const walletAfter = await usdc.balanceOf(member1.address);

            // Member should have paid the $5 shortfall
            expect(walletBefore - walletAfter).to.equal(toUSDC(5));
            expect(await matA.isInMatrix(member1.address)).to.be.true;
        });

        it("rejects already-used coupon (double-spend)", async function () {
            const { registry, matA, issuer, member1, member2 } = await deployFixture();

            const codeHash = hashCode("DOUBLE-SPEND");
            await registry.connect(issuer).issueCoupon(codeHash);

            // First use succeeds
            await couponEnter(matA, member1, ethers.ZeroAddress, codeHash);

            // Second use reverts
            await expect(
                couponEnter(matA, member2, ethers.ZeroAddress, codeHash)
            ).to.be.revertedWith("CR: already used");
        });

        it("rejects nonexistent / wrong code hash", async function () {
            const { matA, member1 } = await deployFixture();

            const fakeHash = hashCode("NOT-ISSUED");
            await expect(
                couponEnter(matA, member1, ethers.ZeroAddress, fakeHash)
            ).to.be.revertedWith("CR: coupon not found");
        });

        it("rejects empty (zero) coupon hash at the matrix level", async function () {
            const { matA, member1 } = await deployFixture();
            await expect(
                couponEnter(matA, member1, ethers.ZeroAddress, ethers.ZeroHash)
            ).to.be.revertedWith("F8V8: empty coupon hash");
        });

        it("rejects already-registered member", async function () {
            const { registry, matA, issuer, member1 } = await deployFixture();

            const h1 = hashCode("FIRST");
            await registry.connect(issuer).issueCoupon(h1);
            await couponEnter(matA, member1, ethers.ZeroAddress, h1);

            // Try to use another coupon while still in matrix
            const h2 = hashCode("SECOND");
            await registry.connect(issuer).issueCoupon(h2);
            await expect(
                couponEnter(matA, member1, ethers.ZeroAddress, h2)
            ).to.be.revertedWith("F8V8: already in matrix");
        });

        it("rejects coupon registration on MatB", async function () {
            const { registry, matB, issuer, member1, usdc } = await deployFixture();

            // Authorize matB in registry and wire it for this test
            await registry.setAuthorizedMatrix(await matB.getAddress(), true);
            await matB.setCouponRegistry(await registry.getAddress());

            const codeHash = hashCode("MATB-ATTEMPT");
            await registry.connect(issuer).issueCoupon(codeHash);

            await usdc.connect(member1).approve(await matB.getAddress(), ethers.MaxUint256);
            await expect(
                couponEnter(matB, member1, ethers.ZeroAddress, codeHash)
            ).to.be.revertedWith("F8V8: coupon registration must use MatA");
        });
    });

    // ── 3. Expiry ──────────────────────────────────────────────────────────────

    describe("expiry", function () {

        it("registration fails after 30-day expiry", async function () {
            const { registry, matA, issuer, member1 } = await deployFixture();

            const codeHash = hashCode("EXPIRE-REG");
            await registry.connect(issuer).issueCoupon(codeHash);

            // Jump past 30 days
            await increaseTime(30 * 24 * 3600 + 1);

            await expect(
                couponEnter(matA, member1, ethers.ZeroAddress, codeHash)
            ).to.be.revertedWith("CR: expired");
        });

        it("reclaimCoupon succeeds after expiry if unused", async function () {
            const { registry, usdc, issuer, COUPON_AMOUNT } = await deployFixture();

            const codeHash = hashCode("RECLAIM-OK");
            await registry.connect(issuer).issueCoupon(codeHash);

            const balBefore = await usdc.balanceOf(issuer.address);
            await increaseTime(30 * 24 * 3600 + 1);

            await expect(registry.connect(issuer).reclaimCoupon(codeHash))
                .to.emit(registry, "CouponReclaimed")
                .withArgs(codeHash, issuer.address, COUPON_AMOUNT);

            const balAfter = await usdc.balanceOf(issuer.address);
            expect(balAfter - balBefore).to.equal(COUPON_AMOUNT);
        });

        it("reclaimCoupon fails before expiry", async function () {
            const { registry, issuer } = await deployFixture();

            const codeHash = hashCode("EARLY-RECLAIM");
            await registry.connect(issuer).issueCoupon(codeHash);

            await expect(registry.connect(issuer).reclaimCoupon(codeHash))
                .to.be.revertedWith("CR: not expired yet");
        });

        it("reclaimCoupon fails after the coupon was used", async function () {
            const { registry, matA, issuer, member1 } = await deployFixture();

            const codeHash = hashCode("USED-THEN-RECLAIM");
            await registry.connect(issuer).issueCoupon(codeHash);
            await couponEnter(matA, member1, ethers.ZeroAddress, codeHash);

            await increaseTime(30 * 24 * 3600 + 1);
            await expect(registry.connect(issuer).reclaimCoupon(codeHash))
                .to.be.revertedWith("CR: already used");
        });

        it("reclaimCoupon fails if caller is not the issuer", async function () {
            const { registry, issuer, rando } = await deployFixture();

            const codeHash = hashCode("NOT-ISSUER");
            await registry.connect(issuer).issueCoupon(codeHash);

            await increaseTime(30 * 24 * 3600 + 1);
            await expect(registry.connect(rando).reclaimCoupon(codeHash))
                .to.be.revertedWith("CR: not issuer");
        });
    });

    // ── 3b. cancelCoupon ───────────────────────────────────────────────────────

    describe("cancelCoupon", function () {

        it("issuer cancels unused coupon: USDC returned and CouponCancelled emitted", async function () {
            const { registry, usdc, issuer, COUPON_AMOUNT } = await deployFixture();

            const codeHash = hashCode("CANCEL-ME");
            await registry.connect(issuer).issueCoupon(codeHash);

            const balBefore = await usdc.balanceOf(issuer.address);
            const tx        = await registry.connect(issuer).cancelCoupon(codeHash);
            const balAfter  = await usdc.balanceOf(issuer.address);

            // USDC refunded to issuer
            expect(balAfter - balBefore).to.equal(COUPON_AMOUNT);

            // Contract marks it used so it cannot be redeemed or reclaimed
            const c = await registry.coupons(codeHash);
            expect(c.used).to.be.true;

            // Event
            await expect(tx)
                .to.emit(registry, "CouponCancelled")
                .withArgs(codeHash, issuer.address, COUPON_AMOUNT);
        });

        it("non-issuer cannot cancel (CR: not issuer)", async function () {
            const { registry, issuer, rando } = await deployFixture();

            const codeHash = hashCode("CANCEL-NONISSUER");
            await registry.connect(issuer).issueCoupon(codeHash);

            await expect(registry.connect(rando).cancelCoupon(codeHash))
                .to.be.revertedWith("CR: not issuer");
        });

        it("cannot cancel an already-used coupon (CR: already used)", async function () {
            const { registry, matA, issuer, member1 } = await deployFixture();

            const codeHash = hashCode("CANCEL-AFTER-USE");
            await registry.connect(issuer).issueCoupon(codeHash);
            // Member redeems it first
            await couponEnter(matA, member1, ethers.ZeroAddress, codeHash);

            await expect(registry.connect(issuer).cancelCoupon(codeHash))
                .to.be.revertedWith("CR: already used");
        });

        it("cancelled coupon cannot be redeemed (CR: already used)", async function () {
            const { registry, matA, issuer, member1 } = await deployFixture();

            const codeHash = hashCode("CANCEL-THEN-REDEEM");
            await registry.connect(issuer).issueCoupon(codeHash);
            await registry.connect(issuer).cancelCoupon(codeHash);

            await expect(
                couponEnter(matA, member1, ethers.ZeroAddress, codeHash)
            ).to.be.revertedWith("CR: already used");
        });

        it("already-redeemed coupon cannot be cancelled (CR: already used)", async function () {
            const { registry, matA, issuer, member1 } = await deployFixture();

            const codeHash = hashCode("REDEEM-THEN-CANCEL");
            await registry.connect(issuer).issueCoupon(codeHash);
            await couponEnter(matA, member1, ethers.ZeroAddress, codeHash);

            await expect(registry.connect(issuer).cancelCoupon(codeHash))
                .to.be.revertedWith("CR: already used");
        });
    });

    // ── 4. Owner controls ──────────────────────────────────────────────────────

    describe("owner controls", function () {

        it("disabling registry on matrix reverts coupon registration", async function () {
            const { matA, registry, issuer, member1 } = await deployFixture();

            // Owner disables registry on the matrix
            await matA.setCouponRegistry(ethers.ZeroAddress);

            const codeHash = hashCode("DISABLED");
            await registry.connect(issuer).issueCoupon(codeHash);

            await expect(
                couponEnter(matA, member1, ethers.ZeroAddress, codeHash)
            ).to.be.revertedWith("F8V8: coupon registry not set");
        });

        it("re-enabling registry allows coupon registration again", async function () {
            const { matA, registry, issuer, member1 } = await deployFixture();

            // Disable then re-enable
            await matA.setCouponRegistry(ethers.ZeroAddress);
            await matA.setCouponRegistry(await registry.getAddress());

            const codeHash = hashCode("RE-ENABLED");
            await registry.connect(issuer).issueCoupon(codeHash);

            await couponEnter(matA, member1, ethers.ZeroAddress, codeHash);
            expect(await matA.isInMatrix(member1.address)).to.be.true;
        });

        it("setCouponAmount updates future coupons but not existing ones", async function () {
            const { registry, issuer, COUPON_AMOUNT } = await deployFixture();

            // Issue coupon at original amount ($10)
            const h1 = hashCode("OLD-AMOUNT");
            await registry.connect(issuer).issueCoupon(h1);
            expect((await registry.coupons(h1)).amount).to.equal(COUPON_AMOUNT);

            // Owner changes amount to $5
            await registry.setCouponAmount(toUSDC(5));

            // New coupon gets $5
            const h2 = hashCode("NEW-AMOUNT");
            await registry.connect(issuer).issueCoupon(h2);
            expect((await registry.coupons(h2)).amount).to.equal(toUSDC(5));

            // Old coupon still $10
            expect((await registry.coupons(h1)).amount).to.equal(COUPON_AMOUNT);
        });

        it("setCouponAmount rejects zero", async function () {
            const { registry } = await deployFixture();
            await expect(registry.setCouponAmount(0))
                .to.be.revertedWith("CR: zero amount");
        });

        it("non-owner cannot call setCouponAmount", async function () {
            const { registry, rando } = await deployFixture();
            await expect(registry.connect(rando).setCouponAmount(toUSDC(5)))
                .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
        });

        it("non-owner cannot call setAuthorizedMatrix", async function () {
            const { registry, matA, rando } = await deployFixture();
            await expect(
                registry.connect(rando).setAuthorizedMatrix(await matA.getAddress(), false)
            ).to.be.revertedWith("CR: not owner/factory");
        });
    });

    // ── 5. Unauthorized matrix guard ──────────────────────────────────────────

    describe("unauthorized matrix", function () {

        it("rejects redeemCoupon from a non-authorized address", async function () {
            const { registry, issuer, rando } = await deployFixture();

            const codeHash = hashCode("UNAUTH");
            await registry.connect(issuer).issueCoupon(codeHash);

            // rando is not an authorized matrix
            await expect(
                registry.connect(rando).redeemCoupon(codeHash, rando.address)
            ).to.be.revertedWith("CR: caller not authorized matrix");
        });
    });

    // ── 6. isValid view ────────────────────────────────────────────────────────

    describe("isValid", function () {

        it("returns true for a fresh unused coupon", async function () {
            const { registry, issuer } = await deployFixture();
            const codeHash = hashCode("VALID");
            await registry.connect(issuer).issueCoupon(codeHash);
            expect(await registry.isValid(codeHash)).to.be.true;
        });

        it("returns false for unknown hash", async function () {
            const { registry } = await deployFixture();
            expect(await registry.isValid(hashCode("UNKNOWN"))).to.be.false;
        });

        it("returns false after coupon is used", async function () {
            const { registry, matA, issuer, member1 } = await deployFixture();
            const codeHash = hashCode("AFTER-USE");
            await registry.connect(issuer).issueCoupon(codeHash);
            await couponEnter(matA, member1, ethers.ZeroAddress, codeHash);
            expect(await registry.isValid(codeHash)).to.be.false;
        });

        it("returns false after expiry", async function () {
            const { registry, issuer } = await deployFixture();
            const codeHash = hashCode("AFTER-EXPIRY");
            await registry.connect(issuer).issueCoupon(codeHash);
            await increaseTime(30 * 24 * 3600 + 1);
            expect(await registry.isValid(codeHash)).to.be.false;
        });
    });

    // ── 7. selfRescue ──────────────────────────────────────────────────────────

    describe("selfRescue (parked member pays own shortfall)", function () {

        it("selfRescue reverts if caller has never joined", async function () {
            const { matA, rando } = await deployFixture();
            await expect(matA.connect(rando).selfRescue())
                .to.be.revertedWith("F8V8: not a member");
        });

        it("selfRescue reverts if caller is still in matrix", async function () {
            const { matA, registry, issuer, member1 } = await deployFixture();

            const codeHash = hashCode("STILL-IN");
            await registry.connect(issuer).issueCoupon(codeHash);
            await couponEnter(matA, member1, ethers.ZeroAddress, codeHash);

            // member1 is still in matrix
            await expect(matA.connect(member1).selfRescue())
                .to.be.revertedWith("F8V8: still in matrix");
        });
    });
});

// ── Internal helper ────────────────────────────────────────────────────────────

async function _expiryOf(registry, codeHash) {
    const c = await registry.coupons(codeHash);
    return c.expiry;
}
