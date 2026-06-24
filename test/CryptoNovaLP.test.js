const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ── Helpers ───────────────────────────────────────────────────────────────────
const U  = (n) => ethers.parseUnits(String(n), 6);   // USDC  (6 dec)
const C  = (n) => ethers.parseUnits(String(n), 18);  // CNOVA (18 dec)
const BPS = 10_000n;
const FEE  = 30n;   // 0.30%

function cpammOut(amtIn, resIn, resOut) {
  // x*y=k formula with 0.30% fee
  const amtInFee = amtIn * (BPS - FEE);
  return (amtInFee * resOut) / (resIn * BPS + amtInFee);
}

// ── Fixture ───────────────────────────────────────────────────────────────────
async function deploy() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

  // Deploy mock USDC (6 dec)
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy(owner.address);

  // Deploy mock CNOVA (18 dec) — reuse MockUSDC with 18 decimals override
  // We'll use a simple ERC20 with mintable for CNOVA
  const MockERC20 = await ethers.getContractFactory("MockUSDC"); // same interface, diff decimals handled below
  // Actually deploy CNOVAToken or a plain ERC20 mock
  const CNOVAFactory = await ethers.getContractFactory("CNOVAToken");
  const cnova = await CNOVAFactory.deploy(owner.address);

  // Deploy LP pool
  const LP = await ethers.getContractFactory("CryptoNovaLP");
  const lp = await LP.deploy(await usdc.getAddress(), await cnova.getAddress());

  // Mint tokens to test signers
  // USDC: mint function (MockUSDC has public mint)
  for (const s of [owner, alice, bob, carol]) {
    await usdc.mint(s.address, U(100_000));   // 100k USDC each
  }
  // CNOVA: CNOVAToken has no initial supply on deploy — use mintForSale (V8.23).
  // Grant DIRECT_SALE_ROLE to owner so the fixture can seed test balances.
  const DIRECT_SALE_ROLE = await cnova.DIRECT_SALE_ROLE();
  await cnova.grantRole(DIRECT_SALE_ROLE, owner.address);
  const MINT_EACH = C(500_000);  // 500k CNOVA each — enough for LP seeding tests
  for (const s of [owner, alice, bob, carol]) {
    await cnova.mintForSale(s.address, MINT_EACH);
  }

  return { lp, usdc, cnova, owner, alice, bob, carol };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("CryptoNovaLP", function () {

  // ── addLiquidity ─────────────────────────────────────────────────────────
  describe("addLiquidity", function () {

    it("initial seed: mints LP = sqrt(usdc * cnova) - 1000", async function () {
      const { lp, usdc, cnova, owner } = await deploy();
      const lpAddr = await lp.getAddress();

      const uAmt = U(1_000);    // 1 000 USDC
      const cAmt = C(100_000);  // 100 000 CNOVA  → $0.01 per CNOVA

      await usdc.connect(owner).approve(lpAddr, uAmt);
      await cnova.connect(owner).approve(lpAddr, cAmt);

      const tx = await lp.connect(owner).addLiquidity(uAmt, cAmt);
      await expect(tx).to.emit(lp, "LiquidityAdded");

      const supply = await lp.totalSupply();
      // sqrt(1000e6 * 100_000e18) - 1000
      const expected = sqrt(uAmt * cAmt) - 1000n;
      expect(supply - 1000n).to.be.closeTo(expected, 1n); // ±1 for rounding

      const [rU, rC] = await lp.getReserves();
      expect(rU).to.equal(uAmt);
      expect(rC).to.equal(cAmt);
    });

    it("subsequent deposit is proportional", async function () {
      const { lp, usdc, cnova, owner, alice } = await deploy();
      const lpAddr = await lp.getAddress();

      // Seed
      await usdc.connect(owner).approve(lpAddr, U(1_000));
      await cnova.connect(owner).approve(lpAddr, C(100_000));
      await lp.connect(owner).addLiquidity(U(1_000), C(100_000));

      const supplyBefore = await lp.totalSupply();

      // Alice deposits same ratio: 500 USDC / 50 000 CNOVA
      await usdc.connect(alice).approve(lpAddr, U(500));
      await cnova.connect(alice).approve(lpAddr, C(50_000));
      await lp.connect(alice).addLiquidity(U(500), C(50_000));

      const aliceLp = await lp.balanceOf(alice.address);
      // Should be ~50% of owner's initial LP (half the deposit)
      const ownerLp = await lp.balanceOf(owner.address);
      expect(aliceLp).to.be.closeTo(ownerLp / 2n, ownerLp / 100n); // within 1%
    });

    it("reverts on zero amounts", async function () {
      const { lp, usdc, cnova, owner } = await deploy();
      const lpAddr = await lp.getAddress();
      await usdc.connect(owner).approve(lpAddr, U(100));
      await cnova.connect(owner).approve(lpAddr, C(1_000));
      await expect(lp.connect(owner).addLiquidity(0, C(1_000))).to.be.revertedWith("LP: zero amounts");
      await expect(lp.connect(owner).addLiquidity(U(100), 0))  .to.be.revertedWith("LP: zero amounts");
    });
  });

  // ── removeLiquidity ──────────────────────────────────────────────────────
  describe("removeLiquidity", function () {

    it("returns proportional USDC and CNOVA", async function () {
      const { lp, usdc, cnova, owner } = await deploy();
      const lpAddr = await lp.getAddress();

      await usdc.connect(owner).approve(lpAddr, U(1_000));
      await cnova.connect(owner).approve(lpAddr, C(100_000));
      await lp.connect(owner).addLiquidity(U(1_000), C(100_000));

      const lpBal = await lp.balanceOf(owner.address);
      const uBefore = await usdc.balanceOf(owner.address);
      const cBefore = await cnova.balanceOf(owner.address);

      await lp.connect(owner).removeLiquidity(lpBal);

      const uAfter = await usdc.balanceOf(owner.address);
      const cAfter = await cnova.balanceOf(owner.address);

      // Should get back ~all deposited (minus MIN_LIQ dust)
      expect(uAfter - uBefore).to.be.closeTo(U(1_000), U(1));   // within $1
      expect(cAfter - cBefore).to.be.closeTo(C(100_000), C(100)); // within 100 CNOVA
    });

    it("reverts on zero LP input", async function () {
      const { lp } = await deploy();
      await expect(lp.removeLiquidity(0)).to.be.revertedWith("LP: zero LP");
    });
  });

  // ── swapUSDCForCNOVA ─────────────────────────────────────────────────────
  describe("swapUSDCForCNOVA", function () {

    async function seeded() {
      const f = await deploy();
      const lpAddr = await f.lp.getAddress();
      await f.usdc.connect(f.owner).approve(lpAddr, U(1_000));
      await f.cnova.connect(f.owner).approve(lpAddr, C(100_000));
      await f.lp.connect(f.owner).addLiquidity(U(1_000), C(100_000));
      return f;
    }

    it("returns correct CNOVA amount (x*y=k with 0.30% fee)", async function () {
      const { lp, usdc, cnova, alice } = await seeded();
      const lpAddr = await lp.getAddress();

      const usdcIn = U(10); // buy with 10 USDC
      await usdc.connect(alice).approve(lpAddr, usdcIn);

      const [rU, rC] = await lp.getReserves();
      const expected = cpammOut(usdcIn, rU, rC);

      const cBefore = await cnova.balanceOf(alice.address);
      await lp.connect(alice).swapUSDCForCNOVA(usdcIn, 0n);
      const cAfter = await cnova.balanceOf(alice.address);

      expect(cAfter - cBefore).to.equal(expected);
    });

    it("reserves update correctly after swap", async function () {
      const { lp, usdc, alice } = await seeded();
      const lpAddr = await lp.getAddress();

      const usdcIn = U(50);
      await usdc.connect(alice).approve(lpAddr, usdcIn);

      const [rUBefore, rCBefore] = await lp.getReserves();
      const cOut = cpammOut(usdcIn, rUBefore, rCBefore);

      await lp.connect(alice).swapUSDCForCNOVA(usdcIn, 0n);

      const [rUAfter, rCAfter] = await lp.getReserves();
      expect(rUAfter).to.equal(rUBefore + usdcIn);
      expect(rCAfter).to.equal(rCBefore - cOut);
    });

    it("slippage guard reverts when output below minOut", async function () {
      const { lp, usdc, alice } = await seeded();
      const lpAddr = await lp.getAddress();

      const usdcIn = U(10);
      await usdc.connect(alice).approve(lpAddr, usdcIn);

      const [rU, rC] = await lp.getReserves();
      const expected = cpammOut(usdcIn, rU, rC);

      await expect(
        lp.connect(alice).swapUSDCForCNOVA(usdcIn, expected + 1n)
      ).to.be.revertedWith("LP: slippage exceeded");
    });

    it("emits Swap event", async function () {
      const { lp, usdc, alice } = await seeded();
      const lpAddr = await lp.getAddress();
      const usdcIn = U(5);
      await usdc.connect(alice).approve(lpAddr, usdcIn);
      await expect(lp.connect(alice).swapUSDCForCNOVA(usdcIn, 0n))
        .to.emit(lp, "Swap")
        .withArgs(alice.address, true, usdcIn, anyValue, anyValue);
    });

    it("reverts with no liquidity", async function () {
      const { lp, usdc, alice } = await deploy();
      const lpAddr = await lp.getAddress();
      await usdc.connect(alice).approve(lpAddr, U(10));
      await expect(lp.connect(alice).swapUSDCForCNOVA(U(10), 0n))
        .to.be.revertedWith("LP: no liquidity");
    });
  });

  // ── swapCNOVAForUSDC ─────────────────────────────────────────────────────
  describe("swapCNOVAForUSDC", function () {

    async function seeded() {
      const f = await deploy();
      const lpAddr = await f.lp.getAddress();
      await f.usdc.connect(f.owner).approve(lpAddr, U(1_000));
      await f.cnova.connect(f.owner).approve(lpAddr, C(100_000));
      await f.lp.connect(f.owner).addLiquidity(U(1_000), C(100_000));
      return f;
    }

    it("returns correct USDC amount (x*y=k with 0.30% fee)", async function () {
      const { lp, usdc, cnova, alice } = await seeded();
      const lpAddr = await lp.getAddress();

      const cnovaIn = C(5_000); // sell 5000 CNOVA
      await cnova.connect(alice).approve(lpAddr, cnovaIn);

      const [rU, rC] = await lp.getReserves();
      const expected = cpammOut(cnovaIn, rC, rU);

      const uBefore = await usdc.balanceOf(alice.address);
      await lp.connect(alice).swapCNOVAForUSDC(cnovaIn, 0n);
      const uAfter = await usdc.balanceOf(alice.address);

      expect(uAfter - uBefore).to.equal(expected);
    });

    it("price moves correctly — buying then selling is not free", async function () {
      const { lp, usdc, cnova, alice } = await seeded();
      const lpAddr = await lp.getAddress();

      // Buy 10 USDC worth of CNOVA — record balance delta so we only sell what we got
      const usdcIn = U(10);
      const cBalBefore = await cnova.balanceOf(alice.address);
      await usdc.connect(alice).approve(lpAddr, usdcIn);
      await lp.connect(alice).swapUSDCForCNOVA(usdcIn, 0n);
      const cDelta = await cnova.balanceOf(alice.address) - cBalBefore;

      // Sell back only the CNOVA just acquired
      await cnova.connect(alice).approve(lpAddr, cDelta);
      const uBefore = await usdc.balanceOf(alice.address);
      await lp.connect(alice).swapCNOVAForUSDC(cDelta, 0n);
      const uAfter = await usdc.balanceOf(alice.address);

      // Should get back less than 10 USDC (fees lost both ways)
      expect(uAfter - uBefore).to.be.lt(usdcIn);
    });

    it("slippage guard reverts", async function () {
      const { lp, cnova, alice } = await seeded();
      const lpAddr = await lp.getAddress();
      const cnovaIn = C(1_000);
      await cnova.connect(alice).approve(lpAddr, cnovaIn);
      const [rU, rC] = await lp.getReserves();
      const expected = cpammOut(cnovaIn, rC, rU);
      await expect(
        lp.connect(alice).swapCNOVAForUSDC(cnovaIn, expected + 1n)
      ).to.be.revertedWith("LP: slippage exceeded");
    });
  });

  // ── Price & Quote views ───────────────────────────────────────────────────
  describe("price views", function () {

    it("getCNOVAPrice reflects pool ratio", async function () {
      const { lp, usdc, cnova, owner } = await deploy();
      const lpAddr = await lp.getAddress();

      // Seed: 1000 USDC / 100 000 CNOVA → $0.01 per CNOVA
      await usdc.connect(owner).approve(lpAddr, U(1_000));
      await cnova.connect(owner).approve(lpAddr, C(100_000));
      await lp.connect(owner).addLiquidity(U(1_000), C(100_000));

      const price = await lp.getCNOVAPrice();
      // price = (1000e6 * 1e18) / (100_000e18) = 1000e6 / 100_000 = 10_000
      // Human: 10_000 / 1e6 = 0.01 USDC per CNOVA ✓
      expect(price).to.equal(10_000n);
    });

    it("quoteUSDCForCNOVA matches actual swap output", async function () {
      const { lp, usdc, cnova, owner, alice } = await deploy();
      const lpAddr = await lp.getAddress();
      await usdc.connect(owner).approve(lpAddr, U(1_000));
      await cnova.connect(owner).approve(lpAddr, C(100_000));
      await lp.connect(owner).addLiquidity(U(1_000), C(100_000));

      const usdcIn = U(20);
      const [quotedOut] = await lp.quoteUSDCForCNOVA(usdcIn);

      await usdc.connect(alice).approve(lpAddr, usdcIn);
      const cBefore = await cnova.balanceOf(alice.address);
      await lp.connect(alice).swapUSDCForCNOVA(usdcIn, 0n);
      const actualOut = (await cnova.balanceOf(alice.address)) - cBefore;

      expect(actualOut).to.equal(quotedOut);
    });

    it("getOptimalCNOVAForUSDC returns correct ratio amount", async function () {
      const { lp, usdc, cnova, owner } = await deploy();
      const lpAddr = await lp.getAddress();
      await usdc.connect(owner).approve(lpAddr, U(1_000));
      await cnova.connect(owner).approve(lpAddr, C(100_000));
      await lp.connect(owner).addLiquidity(U(1_000), C(100_000));

      const optimal = await lp.getOptimalCNOVAForUSDC(U(100));
      // 100 USDC at 100:1 ratio = 10 000 CNOVA
      expect(optimal).to.equal(C(10_000));
    });
  });

  // ── Fee accumulation ─────────────────────────────────────────────────────
  describe("fee accumulation", function () {

    it("LP value grows after swaps", async function () {
      const { lp, usdc, cnova, owner, alice, bob } = await deploy();
      const lpAddr = await lp.getAddress();

      await usdc.connect(owner).approve(lpAddr, U(1_000));
      await cnova.connect(owner).approve(lpAddr, C(100_000));
      await lp.connect(owner).addLiquidity(U(1_000), C(100_000));

      const lpBal = await lp.balanceOf(owner.address);
      const [rUBefore] = await lp.getReserves();

      // Alice and Bob do several small swaps (~0.1% of pool each to keep price impact minimal)
      for (let i = 0; i < 5; i++) {
        const u = U(1);   // 1 USDC into 1000 USDC pool = 0.1% price impact
        await usdc.connect(alice).approve(lpAddr, u);
        await lp.connect(alice).swapUSDCForCNOVA(u, 0n);

        const [, rC] = await lp.getReserves();
        const cSell = rC / 1000n; // sell 0.1% of reserve
        await cnova.connect(bob).approve(lpAddr, cSell);
        await lp.connect(bob).swapCNOVAForUSDC(cSell, 0n);
      }

      // Owner's LP entitles them to more USDC than they deposited
      const [rUAfter] = await lp.getReserves();
      const supply = await lp.totalSupply();
      const ownerUSDCShare = (lpBal * rUAfter) / supply;

      // Fees accumulated → USDC reserve grew
      expect(rUAfter).to.be.gt(rUBefore);
      expect(ownerUSDCShare).to.be.gt(U(1_000) * 99n / 100n); // at least 99% back
    });
  });

  // ── getLPShare ────────────────────────────────────────────────────────────
  describe("getLPShare", function () {

    it("returns 10000 bps (100%) for sole LP provider", async function () {
      const { lp, usdc, cnova, owner } = await deploy();
      const lpAddr = await lp.getAddress();
      await usdc.connect(owner).approve(lpAddr, U(1_000));
      await cnova.connect(owner).approve(lpAddr, C(100_000));
      await lp.connect(owner).addLiquidity(U(1_000), C(100_000));
      // Owner has everything except MIN_LIQ burned to dead
      const share = await lp.getLPShare(owner.address);
      expect(share).to.be.closeTo(10_000n, 10n); // ≈100% (tiny dust to dead)
    });

    it("two providers split correctly", async function () {
      const { lp, usdc, cnova, owner, alice } = await deploy();
      const lpAddr = await lp.getAddress();

      await usdc.connect(owner).approve(lpAddr, U(1_000));
      await cnova.connect(owner).approve(lpAddr, C(100_000));
      await lp.connect(owner).addLiquidity(U(1_000), C(100_000));

      await usdc.connect(alice).approve(lpAddr, U(1_000));
      await cnova.connect(alice).approve(lpAddr, C(100_000));
      await lp.connect(alice).addLiquidity(U(1_000), C(100_000));

      const ownerShare = await lp.getLPShare(owner.address);
      const aliceShare = await lp.getLPShare(alice.address);

      // Each should be ~50% (5000 bps)
      expect(ownerShare).to.be.closeTo(5_000n, 50n);
      expect(aliceShare).to.be.closeTo(5_000n, 50n);
    });
  });
});

// ── Local sqrt helper (mirrors contract) ─────────────────────────────────────
function sqrt(y) {
  if (y > 3n) {
    let z = y;
    let x = y / 2n + 1n;
    while (x < z) { z = x; x = (y / x + x) / 2n; }
    return z;
  }
  return y !== 0n ? 1n : 0n;
}

// anyValue matcher helper — passed as predicate to .withArgs(), never called directly
const anyValue = () => true;
