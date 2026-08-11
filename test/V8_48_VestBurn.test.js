"use strict";
/**
 * V8_48_VestBurn.test.js — V8.48 items 8 + 9: burning must not lock a wallet out.
 *
 * THE DEFECT
 *   CNOVAToken._update enforces vesting only when `from != 0 && to != 0`, so a BURN
 *   bypasses it. The vest batches record what was MINTED and nothing reduced them, so
 *   after burning, `lockedBalanceOf` could exceed `balanceOf`.
 *
 *   That is not cosmetic. The guard computes
 *       available = balanceOf > locked ? balanceOf - locked : 0
 *   so once locked outruns the balance, `available` pins to ZERO and the wallet can no
 *   longer transfer ANY tokens — including unlocked ones acquired afterwards — until
 *   the stale batches expire on their own.
 *
 * THE TWO FIXES, AND WHY BOTH
 *   item 8  lockedBalanceOf clamps to balanceOf. Stops the view being absurd.
 *           MEASURED NOTE: removing this clamp does NOT fail these tests, and that is
 *           by design rather than a gap. With item 9 in place the batches are already
 *           kept within the balance, and every burn reaches _update, so no ordinary
 *           path can drive locked above balanceOf for the clamp to catch. It earns its
 *           place as a guard against a FUTURE path that moves balances without
 *           touching batches — which is exactly how this bug arrived.
 *   item 9  a burn REDUCES the batches. Item 8 alone cannot fix the lock-out: the
 *           moment new tokens arrive, the clamp re-locks them against batches for
 *           tokens that no longer exist. The test below proves exactly that — it is
 *           the case that separates the two fixes.
 */
const { ethers } = require("hardhat");
const { expect } = require("chai");

const E18 = (n) => ethers.parseUnits(n.toString(), 18);

describe("V8.48 items 8 + 9 — burning locked CNOVA must not brick the wallet", function () {
  this.timeout(300_000);

  let cnova, owner, alice, bob;

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  });

  // mintDirect attaches a vest batch (MINTER_ROLE); mintForSale does not
  // (DIRECT_SALE_ROLE) — that is the pair this file needs to tell locked from
  // unlocked without faking anything.
  async function vestedMint(to, amount) {
    await cnova.grantRole(await cnova.MINTER_ROLE(), owner.address);
    await cnova.mintDirect(to, amount);
    return true;
  }
  async function freeMint(to, amount) {
    await cnova.grantRole(await cnova.DIRECT_SALE_ROLE(), owner.address);
    await cnova.mintForSale(to, amount);
  }

  it("locked can never exceed the balance, however much is burned", async function () {
    await vestedMint(alice.address, E18(1000));

    expect(await cnova.lockedBalanceOf(alice.address)).to.equal(E18(1000));
    await cnova.connect(alice).burn(E18(400));

    const bal = await cnova.balanceOf(alice.address);
    const locked = await cnova.lockedBalanceOf(alice.address);
    expect(bal).to.equal(E18(600));
    expect(locked, "a wallet cannot have more locked than it owns").to.be.lte(bal);
  });

  it("THE LOCK-OUT: tokens acquired after a burn stay transferable", async function () {
    // This is the case item 8's clamp alone does NOT fix, and the reason item 9 exists.
    await vestedMint(alice.address, E18(1000));

    await cnova.connect(alice).burn(E18(1000));          // burn the whole locked position
    expect(await cnova.balanceOf(alice.address)).to.equal(0n);
    expect(await cnova.lockedBalanceOf(alice.address),
      "batches for burned tokens must not survive").to.equal(0n);

    // Now receive UNLOCKED tokens from somebody else.
    await freeMint(bob.address, E18(200));
    await cnova.connect(bob).transfer(alice.address, E18(200));

    expect(await cnova.balanceOf(alice.address)).to.equal(E18(200));
    expect(await cnova.lockedBalanceOf(alice.address),
      "nothing is vesting any more — the batches were burned away").to.equal(0n);

    // The whole point: she can move them.
    await expect(cnova.connect(alice).transfer(bob.address, E18(200)),
      "a wallet that burned its vest position must not be frozen out of new tokens"
    ).to.not.be.reverted;
    expect(await cnova.balanceOf(alice.address)).to.equal(0n);
  });

  it("a PARTIAL burn leaves the remaining locks intact and still enforced", async function () {
    await vestedMint(alice.address, E18(1000));

    await cnova.connect(alice).burn(E18(300));
    const bal = await cnova.balanceOf(alice.address);
    expect(bal).to.equal(E18(700));
    // 700 remain and all of them are still vesting — nothing became transferable.
    expect(await cnova.lockedBalanceOf(alice.address)).to.equal(E18(700));
    await expect(cnova.connect(alice).transfer(bob.address, E18(1)))
      .to.be.revertedWith("CNOVA: tokens vesting -- wait for unlock");
  });

  it("vesting is still enforced on an untouched position — the fix does not unlock anything", async function () {
    await vestedMint(alice.address, E18(500));
    expect(await cnova.lockedBalanceOf(alice.address)).to.equal(E18(500));
    await expect(cnova.connect(alice).transfer(bob.address, E18(1)))
      .to.be.revertedWith("CNOVA: tokens vesting -- wait for unlock");
  });

  it("the pop reclaims cap slots — MAX_VEST_BATCHES is not leaked by burning", async function () {
    // Mutation-driven. Skipping the trailing `batches.pop()` changes no balance and no
    // lock, so every other test here passed without it — the ONLY observable difference
    // is that emptied slots keep occupying the 200-batch cap until they mature. Once
    // full, _mintVested reverts "vest batch limit reached" and the wallet can receive no
    // further vested rewards for the rest of the vest period.
    const cap = Number(await cnova.MAX_VEST_BATCHES());
    await cnova.grantRole(await cnova.MINTER_ROLE(), owner.address);
    for (let i = 0; i < cap; i++) await cnova.mintDirect(alice.address, E18(1));
    expect((await cnova.vestBatchesOf(alice.address)).length).to.equal(cap);

    // Burn the lot. Every batch is emptied; with the pop they are removed.
    await cnova.connect(alice).burn(E18(cap));
    expect(await cnova.balanceOf(alice.address)).to.equal(0n);
    expect((await cnova.vestBatchesOf(alice.address)).length,
      "emptied batches must be popped, not left occupying the cap").to.equal(0);

    // And the wallet can receive vested rewards again immediately.
    await expect(cnova.mintDirect(alice.address, E18(1)),
      "a wallet that burned its position must not be barred from future rewards"
    ).to.not.be.reverted;
  });

  it("burning UNLOCKED tokens is a no-op for the vest ledger and must not revert", async function () {
    // Mutation-driven: the `if (lockedSum <= bal) return;` guard is load-bearing.
    // Without it, `excess = lockedSum - bal` underflows and burning perfectly ordinary
    // unlocked tokens reverts. Nothing covered that until now.
    await freeMint(alice.address, E18(100));          // no vest batch at all
    await expect(cnova.connect(alice).burn(E18(40)), "burning unvested tokens must just work")
      .to.not.be.reverted;
    expect(await cnova.balanceOf(alice.address)).to.equal(E18(60));

    // And with a MATURED batch present, where locks are already within the balance.
    await vestedMint(bob.address, E18(100));
    const dur = await cnova.vestDuration();
    await ethers.provider.send("evm_increaseTime", [Number(dur) + 10]);
    await ethers.provider.send("evm_mine", []);
    await expect(cnova.connect(bob).burn(E18(50)), "burning against a matured batch must not revert")
      .to.not.be.reverted;
    expect(await cnova.balanceOf(bob.address)).to.equal(E18(50));
  });

  it("unlocked tokens remain transferable after the vest period, burn or no burn", async function () {
    await vestedMint(alice.address, E18(1000));
    const dur = await cnova.vestDuration();
    await ethers.provider.send("evm_increaseTime", [Number(dur) + 10]);
    await ethers.provider.send("evm_mine", []);
    expect(await cnova.lockedBalanceOf(alice.address), "the batch has matured").to.equal(0n);
    await expect(cnova.connect(alice).transfer(bob.address, E18(1000))).to.not.be.reverted;
  });
});
