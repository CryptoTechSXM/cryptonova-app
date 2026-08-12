"use strict";
/**
 * CNOVADirectSale.test.js
 * Tests the CNOVA bonding-curve direct-sale contract (V8.19).
 *
 * Coverage:
 *  - Constructor zero-address guards
 *  - Tier-1 purchase: cnovaOut / toTreasury / premium math (mirrored in JS via BigInt)
 *  - Bonding curve tier transitions (1.25x -> 1.50x -> 1.75x -> 2.00x)
 *  - SF/LQ deficit-weighted premium split, and 50/50 once both targets are met
 *  - Whale caps: per-tx (maxTxBps) and per-wallet cumulative (maxWalletBps)
 *  - setCaps: owner-only, bounds-checked
 *  - remainingAllowance view matches expected headroom
 *  - pause/unpause gate buyCNOVA
 *  - setCurve validation (empty, length mismatch, last-ceiling-must-be-max, min multiplier)
 *  - rescueUSDC owner-only sweep
 */

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const USDC_DEC  = 1_000_000n;                 // 6 decimals
const CNOVA_DEC = 1_000_000_000_000_000_000n; // 18 decimals
const BPS_BASE  = 10_000n;

function usdc(n) { return BigInt(n) * USDC_DEC; }
function cnova(n) { return BigInt(n) * CNOVA_DEC; }

// Mirrors CNOVADirectSale._computePurchase exactly, in BigInt, so tests assert
// against the same math the contract runs rather than hand-picked numbers.
function computePurchase({ usdcAmount, supply, treasuryBal, multBps, sfBal, lqBal, sfTarget, lqTarget }) {
  const floorE6 = supply === 0n ? 0n : (treasuryBal * CNOVA_DEC) / supply;
  if (floorE6 === 0n) throw new Error("floor price is zero");
  const tierPriceE6 = (floorE6 * multBps) / BPS_BASE;
  let cnovaOut = (usdcAmount * CNOVA_DEC) / tierPriceE6;
  let toTreasury = (cnovaOut * floorE6) / CNOVA_DEC;
  if (toTreasury > usdcAmount) toTreasury = usdcAmount;
  const premium = usdcAmount - toTreasury;

  const sfDeficit = sfBal < sfTarget ? sfTarget - sfBal : 0n;
  const lqDeficit = lqBal < lqTarget ? lqTarget - lqBal : 0n;
  const totalDeficit = sfDeficit + lqDeficit;

  let toSF, toLQ;
  if (totalDeficit === 0n) {
    toSF = premium / 2n;
    toLQ = premium - toSF;
  } else {
    toSF = (premium * sfDeficit) / totalDeficit;
    toLQ = premium - toSF;
  }
  return { cnovaOut, toTreasury, toSF, toLQ, premium, floorE6 };
}

async function deployFixture() {
  // V8.48 item 6: `treasury` used to be a bare SIGNER and the floor was faked by
  // minting USDC straight to its address — which is exactly the balanceOf-vs-
  // usdcReserve divergence item 6 closed. The fixture now deploys the REAL
  // CNOVATreasury, seeds the floor through depositReserve(), and returns
  // `treasury` as an address-only shim so the many `.address` reads below (and
  // the JS purchase mirror, which reads balanceOf) are untouched — with every
  // inflow going through depositReserve, balanceOf == usdcReserve here.
  const [deployer, admin, _unusedTreasurySigner, sf, lq, buyerA, buyerB, other] =
    await ethers.getSigners();

  const usdcToken = await (await ethers.getContractFactory("MockUSDC")).deploy(deployer.address);
  const cnovaToken = await (await ethers.getContractFactory("CNOVAToken")).deploy(admin.address);

  const usdcAddr  = await usdcToken.getAddress();
  const cnovaAddr = await cnovaToken.getAddress();

  const treasuryC = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, admin.address);
  const treasuryAddr = await treasuryC.getAddress();
  const treasury = { address: treasuryAddr };   // address-only shim (see note above)

  const SF_TARGET = usdc(500);
  const LQ_TARGET = usdc(1000);

  const sale = await (await ethers.getContractFactory("CNOVADirectSale")).deploy(
    usdcAddr,
    cnovaAddr,
    treasuryAddr,
    sf.address,
    lq.address,
    SF_TARGET,
    LQ_TARGET
  );
  const saleAddr = await sale.getAddress();

  // Bootstrap: matrix activity normally seeds supply + treasury before direct
  // sale is ever used. Replicate that here: mint 500,000 CNOVA (unvested,
  // admin tool) to `admin`, and fund the treasury with $25,000 USDC -> floor
  // = $0.05. Supply is sized so the default 1% per-tx whale cap (5,000 CNOVA)
  // comfortably clears ordinary $50-$100 test purchases (~800-1,600 CNOVA out
  // at tier 1) -- the whale-cap tests below set their own tighter caps to
  // actually exercise the limits, rather than relying on this base size.
  // mintDirectAdmin removed in V8.23 — use mintForSale with DIRECT_SALE_ROLE instead.
  const DIRECT_SALE_ROLE = await cnovaToken.DIRECT_SALE_ROLE();
  await cnovaToken.connect(admin).grantRole(DIRECT_SALE_ROLE, admin.address);
  await cnovaToken.connect(admin).mintForSale(admin.address, cnova(500_000));
  // Seed the $25,000 floor through the treasury's OWN accounting.
  await treasuryC.connect(admin).setAuthorizedCaller(deployer.address, true);
  await usdcToken.connect(deployer).mint(deployer.address, usdc(25_000));
  await usdcToken.connect(deployer).approve(treasuryAddr, usdc(25_000));
  await treasuryC.connect(deployer).depositReserve(usdc(25_000));
  // V8.48 item 6: each purchase deposits its floor-backing via depositReserve(),
  // so the sale must be an authorized treasury caller (deploy_v8.js does the same).
  await treasuryC.connect(admin).setAuthorizedCaller(saleAddr, true);

  // Direct sale needs DIRECT_SALE_ROLE to mint purchased CNOVA (V8.23: mintForSale).
  await cnovaToken.connect(admin).grantRole(DIRECT_SALE_ROLE, saleAddr);

  // Fund buyers with plenty of test USDC and pre-approve the sale contract.
  for (const buyer of [buyerA, buyerB]) {
    await usdcToken.connect(deployer).mint(buyer.address, usdc(1_000_000));
    await usdcToken.connect(buyer).approve(saleAddr, ethers.MaxUint256);
  }

  return {
    deployer, admin, treasury, sf, lq, buyerA, buyerB, other,
    usdcToken, cnovaToken, sale, saleAddr, usdcAddr, cnovaAddr,
    SF_TARGET, LQ_TARGET,
  };
}

describe("CNOVADirectSale", function () {
  describe("constructor", function () {
    it("reverts on any zero address", async function () {
      const { usdcAddr, cnovaAddr, treasury, sf, lq, SF_TARGET, LQ_TARGET } =
        await loadFixture(deployFixture);
      const Sale = await ethers.getContractFactory("CNOVADirectSale");
      const Z = ethers.ZeroAddress;

      await expect(Sale.deploy(Z, cnovaAddr, treasury.address, sf.address, lq.address, SF_TARGET, LQ_TARGET))
        .to.be.revertedWith("DS: zero usdc");
      await expect(Sale.deploy(usdcAddr, Z, treasury.address, sf.address, lq.address, SF_TARGET, LQ_TARGET))
        .to.be.revertedWith("DS: zero cnova");
      await expect(Sale.deploy(usdcAddr, cnovaAddr, Z, sf.address, lq.address, SF_TARGET, LQ_TARGET))
        .to.be.revertedWith("DS: zero treasury");
      await expect(Sale.deploy(usdcAddr, cnovaAddr, treasury.address, Z, lq.address, SF_TARGET, LQ_TARGET))
        .to.be.revertedWith("DS: zero sf");
      await expect(Sale.deploy(usdcAddr, cnovaAddr, treasury.address, sf.address, Z, SF_TARGET, LQ_TARGET))
        .to.be.revertedWith("DS: zero lq");
    });

    it("sets default whale caps (1% per-tx, 5% per-wallet)", async function () {
      const { sale } = await loadFixture(deployFixture);
      expect(await sale.maxTxBps()).to.equal(100n);
      expect(await sale.maxWalletBps()).to.equal(500n);
    });

    it("sets the default 4-tier bonding curve", async function () {
      const { sale } = await loadFixture(deployFixture);
      expect(await sale.tierCount()).to.equal(4n);
      expect(await sale.currentMultBps()).to.equal(12_500n); // tier 1, low supply
    });
  });

  describe("purchase math", function () {
    it("computes cnovaOut/toTreasury/toSF/toLQ exactly matching the JS mirror (tier 1)", async function () {
      const { sale, usdcToken, cnovaToken, treasury, sf, lq, buyerA, saleAddr, SF_TARGET, LQ_TARGET } =
        await loadFixture(deployFixture);

      const usdcIn = usdc(100);
      const supply = await cnovaToken.totalSupply();
      const treasuryBal = await usdcToken.balanceOf(treasury.address);

      const expected = computePurchase({
        usdcAmount: usdcIn, supply, treasuryBal, multBps: 12_500n,
        sfBal: 0n, lqBal: 0n, sfTarget: SF_TARGET, lqTarget: LQ_TARGET,
      });

      const preview = await sale.previewPurchase(usdcIn);
      expect(preview[0]).to.equal(expected.cnovaOut);
      expect(preview[1]).to.equal(expected.toTreasury);
      expect(preview[2]).to.equal(expected.toSF);
      expect(preview[3]).to.equal(expected.toLQ);

      await expect(sale.connect(buyerA).buyCNOVA(usdcIn))
        .to.emit(sale, "CNOVAPurchased")
        .withArgs(buyerA.address, usdcIn, expected.cnovaOut, expected.toTreasury, expected.toSF, expected.toLQ);

      expect(await cnovaToken.balanceOf(buyerA.address)).to.equal(expected.cnovaOut);
      expect(await usdcToken.balanceOf(treasury.address)).to.equal(treasuryBal + expected.toTreasury);
      expect(await usdcToken.balanceOf(sf.address)).to.equal(expected.toSF);
      expect(await usdcToken.balanceOf(lq.address)).to.equal(expected.toLQ);
      expect(await usdcToken.balanceOf(saleAddr)).to.equal(0n); // nothing left stuck
    });

    it("reverts before any CNOVA supply/treasury exists (floor price is zero)", async function () {
      const { usdcToken, cnovaToken, treasury, sf, lq, buyerA, deployer, SF_TARGET, LQ_TARGET } =
        await loadFixture(deployFixture);

      // Fresh sale against a fresh, unbootstrapped CNOVAToken/treasury.
      const freshCnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(deployer.address);
      const freshSale = await (await ethers.getContractFactory("CNOVADirectSale")).deploy(
        await usdcToken.getAddress(), await freshCnova.getAddress(),
        treasury.address, sf.address, lq.address, SF_TARGET, LQ_TARGET
      );
      await usdcToken.connect(buyerA).approve(await freshSale.getAddress(), ethers.MaxUint256);

      await expect(freshSale.connect(buyerA).buyCNOVA(usdc(10)))
        .to.be.revertedWith("DS: floor price is zero (no supply yet)");
    });

    it("rejects purchases below the $1 minimum", async function () {
      const { sale, buyerA } = await loadFixture(deployFixture);
      await expect(sale.connect(buyerA).buyCNOVA(usdc(1) - 1n))
        .to.be.revertedWith("DS: minimum $1 USDC");
    });
  });

  describe("bonding curve tiers", function () {
    it("moves from tier 1 (1.25x) to tier 2 (1.50x) once supply crosses 1,000,000 CNOVA", async function () {
      const { sale, cnovaToken, admin } = await loadFixture(deployFixture);

      expect(await sale.currentMultBps()).to.equal(12_500n);

      // Push supply up to just under the 1M ceiling — still tier 1.
      // Admin already has DIRECT_SALE_ROLE from the fixture.
      const current = await cnovaToken.totalSupply();
      const justUnder = cnova(1_000_000) - current - 1n;
      await cnovaToken.connect(admin).mintForSale(admin.address, justUnder);
      expect(await sale.currentTierIndex()).to.equal(0n);
      expect(await sale.currentMultBps()).to.equal(12_500n);

      // One more unit of supply crosses the ceiling -> tier 2.
      await cnovaToken.connect(admin).mintForSale(admin.address, 2n);
      expect(await sale.currentTierIndex()).to.equal(1n);
      expect(await sale.currentMultBps()).to.equal(15_000n);
    });
  });

  describe("SF / LQ premium split", function () {
    it("splits the premium 50/50 once both SF and LQ have met their targets", async function () {
      const { sale, usdcToken, treasury, sf, lq, buyerA, deployer, SF_TARGET, LQ_TARGET } =
        await loadFixture(deployFixture);

      await usdcToken.connect(deployer).mint(sf.address, SF_TARGET);
      await usdcToken.connect(deployer).mint(lq.address, LQ_TARGET);

      const usdcIn = usdc(100);
      const preview = await sale.previewPurchase(usdcIn);
      const toSF = preview[2];
      const toLQ = preview[3];

      expect(toSF + toLQ).to.equal(usdcIn - preview[1]); // toSF + toLQ == premium
      // 50/50 split, off by at most 1 wei from odd-premium rounding
      const diff = toSF > toLQ ? toSF - toLQ : toLQ - toSF;
      expect(diff <= 1n).to.equal(true);

      await sale.connect(buyerA).buyCNOVA(usdcIn);
      expect(await usdcToken.balanceOf(sf.address)).to.equal(SF_TARGET + toSF);
      expect(await usdcToken.balanceOf(lq.address)).to.equal(LQ_TARGET + toLQ);
    });

    it("weights the premium toward whichever fund has the bigger deficit", async function () {
      const { sale, usdcToken, sf, deployer, SF_TARGET } = await loadFixture(deployFixture);

      // SF is already 80% funded (small deficit); LQ has zero (full deficit).
      await usdcToken.connect(deployer).mint(sf.address, (SF_TARGET * 8n) / 10n);

      const usdcIn = usdc(100);
      const preview = await sale.previewPurchase(usdcIn);
      const toSF = preview[2];
      const toLQ = preview[3];

      // LQ's deficit is much larger than SF's remaining deficit, so LQ should
      // receive the larger share of the premium.
      expect(toLQ > toSF).to.equal(true);
    });
  });

  describe("whale caps", function () {
    it("blocks a single purchase that would mint more than maxTxBps of current supply", async function () {
      const { sale, cnovaToken, buyerA } = await loadFixture(deployFixture);

      const supply = await cnovaToken.totalSupply();   // 500,000 CNOVA
      const txCapCnova = (supply * 100n) / BPS_BASE;    // 1% = 5,000 CNOVA

      // $1,000 at ~$0.0625/CNOVA (tier 1) ~= 16,000 CNOVA out -- well over the cap.
      const big = usdc(1000);
      const previewBig = await sale.previewPurchase(big);
      expect(previewBig[0] > txCapCnova).to.equal(true);
      await expect(sale.connect(buyerA).buyCNOVA(big)).to.be.revertedWith("DS: exceeds per-tx cap");

      // $100 (~1,600 CNOVA out) stays comfortably under the 5,000-CNOVA cap and
      // clears the $1 minimum -- should succeed.
      const atCapUsdc = usdc(100);
      const previewAtCap = await sale.previewPurchase(atCapUsdc);
      expect(previewAtCap[0] <= txCapCnova).to.equal(true);
      await expect(sale.connect(buyerA).buyCNOVA(atCapUsdc)).to.not.be.reverted;
    });

    it("blocks cumulative purchases by one wallet from exceeding maxWalletBps, independently per wallet", async function () {
      const { sale, buyerA, buyerB } = await loadFixture(deployFixture);

      // Raise the per-tx cap out of the way (100%) and shrink the per-wallet cap
      // to 0.01% of the 500,000-CNOVA supply (= 50 CNOVA) so a handful of $1
      // purchases (~16 CNOVA each) trips it quickly inside the loop below.
      await sale.setCaps(10_000n, 1n);

      const oneUsdc = usdc(1);

      // Keep buying $1 at a time with buyerA until the per-wallet cap rejects.
      let reverted = false;
      for (let i = 0; i < 50 && !reverted; i++) {
        try {
          await sale.connect(buyerA).buyCNOVA(oneUsdc);
        } catch (e) {
          expect(String(e.message)).to.include("DS: exceeds per-wallet cap");
          reverted = true;
        }
      }
      expect(reverted).to.equal(true);

      // buyerB, who has bought nothing yet, can still buy -- the cap is per-wallet.
      await expect(sale.connect(buyerB).buyCNOVA(oneUsdc)).to.not.be.reverted;
    });
  });

  describe("setCaps", function () {
    it("is owner-only", async function () {
      const { sale, buyerA } = await loadFixture(deployFixture);
      await expect(sale.connect(buyerA).setCaps(50n, 200n)).to.be.reverted;
    });

    it("rejects values above 100%", async function () {
      const { sale } = await loadFixture(deployFixture);
      await expect(sale.setCaps(10_001n, 100n)).to.be.revertedWith("DS: maxTxBps > 100%");
      await expect(sale.setCaps(100n, 10_001n)).to.be.revertedWith("DS: maxWalletBps > 100%");
    });

    it("updates the caps and emits CapsUpdated", async function () {
      const { sale } = await loadFixture(deployFixture);
      await expect(sale.setCaps(250n, 1_000n))
        .to.emit(sale, "CapsUpdated").withArgs(250n, 1_000n);
      expect(await sale.maxTxBps()).to.equal(250n);
      expect(await sale.maxWalletBps()).to.equal(1_000n);
    });

    it("0 disables a cap", async function () {
      const { sale, buyerA } = await loadFixture(deployFixture);
      await sale.setCaps(0n, 0n);
      // A purchase that would have blown both caps now succeeds.
      await expect(sale.connect(buyerA).buyCNOVA(usdc(50))).to.not.be.reverted;
    });
  });

  describe("remainingAllowance", function () {
    it("matches min(per-tx headroom, per-wallet headroom) for a fresh wallet", async function () {
      const { sale, cnovaToken, buyerA } = await loadFixture(deployFixture);
      const supply = await cnovaToken.totalSupply();
      const txCap = (supply * 100n) / BPS_BASE;
      const walletCap = (supply * 500n) / BPS_BASE; // buyerA balance is 0
      const expectedAllowance = txCap < walletCap ? txCap : walletCap;
      expect(await sale.remainingAllowance(buyerA.address)).to.equal(expectedAllowance);
    });
  });

  describe("pause", function () {
    it("blocks buyCNOVA while paused, restores after unpause", async function () {
      const { sale, buyerA } = await loadFixture(deployFixture);
      await sale.pause();
      await expect(sale.connect(buyerA).buyCNOVA(usdc(1))).to.be.reverted;
      await sale.unpause();
      await expect(sale.connect(buyerA).buyCNOVA(usdc(1))).to.not.be.reverted;
    });
  });

  describe("setCurve", function () {
    it("rejects an empty curve", async function () {
      const { sale } = await loadFixture(deployFixture);
      await expect(sale.setCurve([], [])).to.be.revertedWith("DS: empty curve");
    });

    it("rejects mismatched array lengths", async function () {
      const { sale } = await loadFixture(deployFixture);
      await expect(sale.setCurve([cnova(1)], [12_500n, 15_000n]))
        .to.be.revertedWith("DS: length mismatch");
    });

    it("requires the last ceiling to be type(uint256).max", async function () {
      const { sale } = await loadFixture(deployFixture);
      await expect(sale.setCurve([cnova(1)], [12_500n]))
        .to.be.revertedWith("DS: last ceiling must be max");
    });

    it("requires every multiplier to be at least 1x", async function () {
      const { sale } = await loadFixture(deployFixture);
      await expect(sale.setCurve([ethers.MaxUint256], [9_999n]))
        .to.be.revertedWith("DS: mult must be >= 1x (10000 BPS)");
    });

    it("replaces the curve and previewPurchase reflects it immediately", async function () {
      const { sale } = await loadFixture(deployFixture);
      await expect(sale.setCurve([ethers.MaxUint256], [20_000n]))
        .to.emit(sale, "CurveUpdated").withArgs(1n);
      expect(await sale.tierCount()).to.equal(1n);
      expect(await sale.currentMultBps()).to.equal(20_000n);
    });
  });

  describe("rescueUSDC", function () {
    it("is owner-only and sweeps stray USDC out of the contract", async function () {
      const { sale, saleAddr, usdcToken, deployer, other, buyerA } = await loadFixture(deployFixture);

      await usdcToken.connect(deployer).mint(saleAddr, usdc(5)); // simulate stray funds

      await expect(sale.connect(buyerA).rescueUSDC(other.address, usdc(5))).to.be.reverted;

      await sale.rescueUSDC(other.address, usdc(5));
      expect(await usdcToken.balanceOf(other.address)).to.equal(usdc(5));
      expect(await usdcToken.balanceOf(saleAddr)).to.equal(0n);
    });
  });
});
