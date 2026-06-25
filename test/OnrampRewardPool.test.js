"use strict";
/**
 * OnrampRewardPool.test.js
 *
 * Coverage:
 *  - Deposit: $10 min, multiples of $10, non-multiple revert, non-zero revert
 *  - Reward distribution: accRewardPerShare math, pro-rata split between LPs
 *  - pendingReward: correct at every lifecycle stage
 *  - harvest(): claims reward without touching principal
 *  - withdraw(): partial + full; auto-harvests; multiple-of-$10 guard
 *  - emergencyWithdraw(): full principal, forfeits rewards, no auth required
 *  - Distributor auth: owner + distributor can distribute; stranger reverts
 *  - setDistributor: owner-only
 *  - distributeReward: reverts when totalStaked == 0
 *  - lpInfo(): share % and pending amounts
 *  - Multiple LPs: pro-rata reward split
 */

const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ── Helpers ──────────────────────────────────────────────────────────────────

const UNIT = 10_000_000n;  // $10 in USDC (6 decimals)
function usdc(n) { return BigInt(n) * UNIT / 10n; } // usdc(10) = $10, usdc(100) = $100

// More readable alias
const D10  = UNIT;          // $10
const D20  = UNIT * 2n;     // $20
const D50  = UNIT * 5n;     // $50
const D100 = UNIT * 10n;    // $100
const D200 = UNIT * 20n;    // $200

// ── Fixture ───────────────────────────────────────────────────────────────────

async function deployFixture() {
    const [owner, lpA, lpB, lpC, stranger, distributorWallet] =
        await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const token = await MockUSDC.deploy(owner.address);

    // Deploy pool
    const Pool = await ethers.getContractFactory("OnrampRewardPool");
    const pool = await Pool.deploy(await token.getAddress(), owner.address);

    // Mint ample USDC to all test actors
    const mintAmt = D100 * 100n;
    for (const signer of [lpA, lpB, lpC, stranger, distributorWallet, owner]) {
        await token.mint(signer.address, mintAmt);
        await token.connect(signer).approve(await pool.getAddress(), mintAmt);
    }

    return { pool, token, owner, lpA, lpB, lpC, stranger, distributorWallet };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OnrampRewardPool", function () {

    // ── Deposit validation ───────────────────────────────────────────────────

    describe("deposit()", function () {
        it("accepts exactly $10", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await expect(pool.connect(lpA).deposit(D10)).to.not.be.reverted;
            expect(await pool.staked(lpA.address)).to.equal(D10);
        });

        it("accepts $20, $50, $100, $200", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            for (const amt of [D20, D50, D100, D200]) {
                await pool.connect(lpA).deposit(amt);
            }
            expect(await pool.staked(lpA.address))
                .to.equal(D20 + D50 + D100 + D200);
        });

        it("reverts on amount < $10", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await expect(pool.connect(lpA).deposit(5_000_000n))
                .to.be.revertedWith("ORP: minimum $10");
        });

        it("reverts on non-multiple (e.g. $15)", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await expect(pool.connect(lpA).deposit(15_000_000n))
                .to.be.revertedWith("ORP: must be a multiple of $10");
        });

        it("reverts on $12", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await expect(pool.connect(lpA).deposit(12_000_000n))
                .to.be.revertedWith("ORP: must be a multiple of $10");
        });

        it("accumulates multiple deposits correctly", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D10);
            await pool.connect(lpA).deposit(D20);
            expect(await pool.staked(lpA.address)).to.equal(D10 + D20);
            expect(await pool.totalStaked()).to.equal(D10 + D20);
        });

        it("emits Deposited event", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await expect(pool.connect(lpA).deposit(D10))
                .to.emit(pool, "Deposited")
                .withArgs(lpA.address, D10, D10);
        });
    });

    // ── Reward distribution ──────────────────────────────────────────────────

    describe("distributeReward()", function () {
        it("reverts when totalStaked == 0", async function () {
            const { pool, owner } = await loadFixture(deployFixture);
            await expect(pool.connect(owner).distributeReward(D10))
                .to.be.revertedWith("ORP: no stakers");
        });

        it("reverts on zero amount", async function () {
            const { pool, owner, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D10);
            await expect(pool.connect(owner).distributeReward(0n))
                .to.be.revertedWith("ORP: zero reward");
        });

        it("owner can distribute", async function () {
            const { pool, owner, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D10);
            await expect(pool.connect(owner).distributeReward(D10)).to.not.be.reverted;
        });

        it("designated distributor can distribute", async function () {
            const { pool, owner, lpA, distributorWallet } =
                await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D10);
            await pool.connect(owner).setDistributor(distributorWallet.address);
            await expect(pool.connect(distributorWallet).distributeReward(D10))
                .to.not.be.reverted;
        });

        it("stranger cannot distribute", async function () {
            const { pool, lpA, stranger } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D10);
            await expect(pool.connect(stranger).distributeReward(D10))
                .to.be.revertedWith("ORP: not authorized");
        });

        it("updates totalRewardDistributed", async function () {
            const { pool, owner, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(owner).distributeReward(D10);
            await pool.connect(owner).distributeReward(D20);
            expect(await pool.totalRewardDistributed()).to.equal(D10 + D20);
        });

        it("emits RewardDistributed", async function () {
            const { pool, owner, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await expect(pool.connect(owner).distributeReward(D10))
                .to.emit(pool, "RewardDistributed");
        });
    });

    // ── pendingReward ────────────────────────────────────────────────────────

    describe("pendingReward()", function () {
        it("is 0 before any distribution", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            expect(await pool.pendingReward(lpA.address)).to.equal(0n);
        });

        it("equals full reward when only one LP", async function () {
            const { pool, owner, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(owner).distributeReward(D10);
            // Solo LP gets 100 %
            expect(await pool.pendingReward(lpA.address)).to.equal(D10);
        });

        it("splits pro-rata between two equal LPs", async function () {
            const { pool, owner, lpA, lpB } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(lpB).deposit(D100);
            await pool.connect(owner).distributeReward(D20); // $20 split evenly
            expect(await pool.pendingReward(lpA.address)).to.equal(D10);
            expect(await pool.pendingReward(lpB.address)).to.equal(D10);
        });

        it("splits 2:1 when stakes are 2:1", async function () {
            const { pool, owner, lpA, lpB } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D200);   // $200
            await pool.connect(lpB).deposit(D100);   // $100  → 2:1 ratio
            await pool.connect(owner).distributeReward(D100 + D200); // $300
            // lpA → $200, lpB → $100
            expect(await pool.pendingReward(lpA.address)).to.equal(D200);
            expect(await pool.pendingReward(lpB.address)).to.equal(D100);
        });

        it("late depositor earns only from future events", async function () {
            const { pool, owner, lpA, lpB } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(owner).distributeReward(D100); // lpA earns $100

            // lpB joins AFTER the distribution
            await pool.connect(lpB).deposit(D100);
            expect(await pool.pendingReward(lpB.address)).to.equal(0n);

            // Second distribution is split 50/50
            await pool.connect(owner).distributeReward(D20);
            expect(await pool.pendingReward(lpA.address))
                .to.equal(D100 + D10);  // $100 from first + $10 from second
            expect(await pool.pendingReward(lpB.address)).to.equal(D10);
        });
    });

    // ── harvest ──────────────────────────────────────────────────────────────

    describe("harvest()", function () {
        it("transfers pending reward and zeroes it", async function () {
            const { pool, owner, token, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(owner).distributeReward(D10);

            const before = await token.balanceOf(lpA.address);
            await pool.connect(lpA).harvest();
            const after = await token.balanceOf(lpA.address);

            expect(after - before).to.equal(D10);
            expect(await pool.pendingReward(lpA.address)).to.equal(0n);
        });

        it("reverts when nothing to harvest", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await expect(pool.connect(lpA).harvest())
                .to.be.revertedWith("ORP: nothing to harvest");
        });

        it("leaves principal untouched", async function () {
            const { pool, owner, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(owner).distributeReward(D10);
            await pool.connect(lpA).harvest();
            expect(await pool.staked(lpA.address)).to.equal(D100);
        });

        it("emits Harvested", async function () {
            const { pool, owner, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(owner).distributeReward(D10);
            await expect(pool.connect(lpA).harvest())
                .to.emit(pool, "Harvested")
                .withArgs(lpA.address, D10);
        });
    });

    // ── withdraw ─────────────────────────────────────────────────────────────

    describe("withdraw()", function () {
        it("returns principal + auto-harvests rewards", async function () {
            const { pool, owner, token, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(owner).distributeReward(D10);

            const before = await token.balanceOf(lpA.address);
            await pool.connect(lpA).withdraw(D100);
            const after = await token.balanceOf(lpA.address);

            // Gets back $100 principal + $10 reward
            expect(after - before).to.equal(D100 + D10);
            expect(await pool.staked(lpA.address)).to.equal(0n);
            expect(await pool.totalStaked()).to.equal(0n);
        });

        it("supports partial withdrawal (multiple of $10)", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(lpA).withdraw(D50);
            expect(await pool.staked(lpA.address)).to.equal(D50);
        });

        it("reverts on non-multiple withdrawal (e.g. $15)", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await expect(pool.connect(lpA).withdraw(15_000_000n))
                .to.be.revertedWith("ORP: must be a multiple of $10");
        });

        it("reverts when withdrawing more than staked", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await expect(pool.connect(lpA).withdraw(D200))
                .to.be.revertedWith("ORP: insufficient stake");
        });

        it("reverts on zero amount", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await expect(pool.connect(lpA).withdraw(0n))
                .to.be.revertedWith("ORP: zero amount");
        });

        it("emits Withdrawn", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await expect(pool.connect(lpA).withdraw(D100))
                .to.emit(pool, "Withdrawn")
                .withArgs(lpA.address, D100, 0n);
        });
    });

    // ── emergencyWithdraw ────────────────────────────────────────────────────

    describe("emergencyWithdraw()", function () {
        it("returns principal and forfeits unclaimed rewards", async function () {
            const { pool, owner, token, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(owner).distributeReward(D10); // earns $10

            const before = await token.balanceOf(lpA.address);
            await pool.connect(lpA).emergencyWithdraw();
            const after = await token.balanceOf(lpA.address);

            // Gets only the $100 principal back, NOT the $10 reward
            expect(after - before).to.equal(D100);
            expect(await pool.staked(lpA.address)).to.equal(0n);
            expect(await pool.pendingReward(lpA.address)).to.equal(0n);
        });

        it("reverts when nothing staked", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await expect(pool.connect(lpA).emergencyWithdraw())
                .to.be.revertedWith("ORP: nothing staked");
        });

        it("emits EmergencyWithdrawn", async function () {
            const { pool, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await expect(pool.connect(lpA).emergencyWithdraw())
                .to.emit(pool, "EmergencyWithdrawn")
                .withArgs(lpA.address, D100);
        });
    });

    // ── setDistributor ───────────────────────────────────────────────────────

    describe("setDistributor()", function () {
        it("owner can set distributor", async function () {
            const { pool, owner, distributorWallet } = await loadFixture(deployFixture);
            await expect(pool.connect(owner).setDistributor(distributorWallet.address))
                .to.emit(pool, "DistributorSet")
                .withArgs(ethers.ZeroAddress, distributorWallet.address);
            expect(await pool.distributor()).to.equal(distributorWallet.address);
        });

        it("stranger cannot set distributor", async function () {
            const { pool, stranger, distributorWallet } = await loadFixture(deployFixture);
            await expect(
                pool.connect(stranger).setDistributor(distributorWallet.address)
            ).to.be.reverted; // OwnableUnauthorizedAccount
        });
    });

    // ── lpInfo ───────────────────────────────────────────────────────────────

    describe("lpInfo()", function () {
        it("returns correct share % and pending for solo LP", async function () {
            const { pool, owner, lpA } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(owner).distributeReward(D10);

            const info = await pool.lpInfo(lpA.address);
            expect(info.stakedAmount).to.equal(D100);
            expect(info.pendingAmount).to.equal(D10);
            expect(info.sharePercent).to.equal(1_000_000n); // 100.0000 %
        });

        it("returns 50% share for two equal LPs", async function () {
            const { pool, owner, lpA, lpB } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            await pool.connect(lpB).deposit(D100);
            await pool.connect(owner).distributeReward(D20);

            const infoA = await pool.lpInfo(lpA.address);
            const infoB = await pool.lpInfo(lpB.address);

            expect(infoA.sharePercent).to.equal(500_000n); // 50.0000 %
            expect(infoB.sharePercent).to.equal(500_000n);
            expect(infoA.pendingAmount).to.equal(D10);
            expect(infoB.pendingAmount).to.equal(D10);
        });

        it("returns 0 share for non-LP", async function () {
            const { pool, lpA, stranger } = await loadFixture(deployFixture);
            await pool.connect(lpA).deposit(D100);
            const info = await pool.lpInfo(stranger.address);
            expect(info.sharePercent).to.equal(0n);
            expect(info.pendingAmount).to.equal(0n);
        });
    });

    // ── Multi-LP compound scenario ───────────────────────────────────────────

    describe("multi-LP compound scenario", function () {
        it("three LPs, two reward tranches, correct final balances", async function () {
            const { pool, owner, token, lpA, lpB, lpC } =
                await loadFixture(deployFixture);

            // lpA: $200, lpB: $100, lpC: $100  → total $400
            await pool.connect(lpA).deposit(D200);
            await pool.connect(lpB).deposit(D100);
            await pool.connect(lpC).deposit(D100);

            // Tranche 1: $100 reward → lpA $50, lpB $25, lpC $25
            await pool.connect(owner).distributeReward(D100);

            // lpB harvests
            await pool.connect(lpB).harvest();

            // Tranche 2: $100 reward → same 2:1:1 split again
            await pool.connect(owner).distributeReward(D100);

            // Final pending:
            //   lpA: $50 + $50 = $100
            //   lpB: $0 + $25  = $25  (already claimed $25 in tranche 1)
            //   lpC: $25 + $25 = $50
            expect(await pool.pendingReward(lpA.address)).to.equal(D100);
            expect(await pool.pendingReward(lpB.address)).to.equal(D50 / 2n); // $25
            expect(await pool.pendingReward(lpC.address)).to.equal(D50);

            // lpA withdraws all — should get $200 principal + $100 reward
            const before = await token.balanceOf(lpA.address);
            await pool.connect(lpA).withdraw(D200);
            const after = await token.balanceOf(lpA.address);
            expect(after - before).to.equal(D200 + D100);
        });
    });
});
