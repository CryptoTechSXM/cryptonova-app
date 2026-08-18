"use strict";
/**
 * test_ab/world.js — ONE deployment routine, used by BOTH arms of the V8.49b vs V8.50 A/B.
 *
 * ⛔ WHY THIS IS A SHARED MODULE AND NOT TWO SCRIPTS.
 *   The whole value of an A/B is that the two arms differ in EXACTLY ONE THING: the
 *   contracts. If each arm had its own deploy script they would drift — a different grace
 *   period here, a different fee there — and every measured difference would be
 *   uninterpretable. The V8.49 run's own worst failure was of this family: "T6 UNANSWERED
 *   — the run had NO VALID CONTROL", because the control's bigfill exited and it silently
 *   became a second subject rather than a control.
 *
 *   So there is one file. Hardhat resolves artifacts from whichever CONFIG is active, so
 *   the same source deploys v849b under hardhat.v849b.config.js and v8.50 under the
 *   default config. The arm is derived from config.paths.sources — it is never passed in
 *   and never guessed, so an output file cannot be mislabelled.
 *
 * ⚠ TOLERANT WIRING, LOUD REPORTING. The two builds are 8 contracts and +1033/-136 apart,
 *   so a setter present in one may be absent in the other. Optional calls are attempted
 *   and RECORDED, never silently skipped: `absent` in the fingerprint is data about how
 *   the arms differ, and a difference we did not expect is a finding, not a nuisance.
 */
const SPLITS = {
  l1Bps: 950, chainBps: 950, poolBps: 1568,
  treasuryBps: 713, stabilityBps: 238,
  devBps: 143, opsBps: 95, communityBps: 48, buybackBps: 45,
  liquidityBps: 0,
};
const CP_BPS = [380, 238, 119, 95, 71, 47];
const FEE = 10_000_000n;

/** Which arm is this? Derived from the active config, never passed in. */
function armOf(hre) {
  const src = String(hre.config.paths.sources).replace(/\\/g, "/");
  if (src.endsWith("contracts_v849b")) return "v849b";
  if (src.endsWith("contracts")) return "v850";
  throw new Error(`cannot identify the arm from paths.sources=${src} — refusing to write ` +
    `an unlabelled result, because a mislabelled arm is worse than no result`);
}

/** Attempt an optional call; record whether it existed rather than swallowing it. */
async function optional(record, name, fn) {
  try { await fn(); record.applied.push(name); }
  catch (e) {
    const msg = e.shortMessage || e.message || "";
    // A missing function and a reverting one are different facts. Keep them apart.
    record.absent.push(`${name}: ${/is not a function/.test(msg) ? "NOT PRESENT" : msg.slice(0, 80)}`);
  }
}

async function deployWorld(hre, size) {
  const { ethers } = hre;
  const wiring = { applied: [], absent: [] };
  const sigs = await ethers.getSigners();
  const [owner, W1, devOps] = sigs;

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address);
  const cnova = await (await ethers.getContractFactory("CNOVAToken")).deploy(owner.address);
  const [usdcAddr, cnovaAddr] = [await usdc.getAddress(), await cnova.getAddress()];
  const treasury = await (await ethers.getContractFactory("CNOVATreasury"))
    .deploy(cnovaAddr, usdcAddr, owner.address);
  const sf = await (await ethers.getContractFactory("StabilityFund")).deploy(usdcAddr, owner.address);
  const tr = await (await ethers.getContractFactory("TierRouter", {
    libraries: { TierRouterLib: (await (await ethers.getContractFactory("TierRouterLib")).deploy()).target },
  })).deploy(usdcAddr, owner.address);
  const pm = await (await ethers.getContractFactory("PairManagerV8")).deploy(usdcAddr, FEE, owner.address);
  const [tresAddr, sfAddr, trAddr, pmAddr] = [
    await treasury.getAddress(), await sf.getAddress(),
    await tr.getAddress(), await pm.getAddress(),
  ];

  const keeperLib = await (await ethers.getContractFactory("MatrixKeeperLib")).deploy();
  const keeper = await (await ethers.getContractFactory("MatrixKeeper", {
    libraries: { MatrixKeeperLib: await keeperLib.getAddress() },
  })).deploy(trAddr, sfAddr);
  const keeperAddr = await keeper.getAddress();

  const dp = {
    usdc: usdcAddr, cnova: cnovaAddr, treasury: tresAddr,
    devWallet: devOps.address, opsWallet: devOps.address,
    accountOne: W1.address, admin: owner.address,
  };
  const matrixLib = await (await ethers.getContractFactory("MatrixLogicLib")).deploy();
  const MX = await ethers.getContractFactory("FigureEightMatrixV8", {
    libraries: { MatrixLogicLib: await matrixLib.getAddress() },
  });
  const matA = await MX.deploy(dp, FEE, size, true, 0, SPLITS, CP_BPS);
  const matB = await MX.deploy(dp, FEE, size, false, 0, SPLITS, CP_BPS);
  const [matAAddr, matBAddr] = [await matA.getAddress(), await matB.getAddress()];

  await matA.setPartner(matBAddr);
  await matB.setPartner(matAAddr);
  for (const m of [matA, matB]) {
    await m.setPairManager(pmAddr);
    await m.setTierRouter(trAddr);
    await m.setStabilityFund(sfAddr);
    await m.setMatrixKeeper(keeperAddr);
    await treasury.setAuthorizedCaller(await m.getAddress(), true);
    await sf.setMatrixAuthorized(await m.getAddress(), true);
  }
  await pm.addPair(matAAddr, matBAddr);
  await pm.setTierRouter(trAddr);
  await tr.registerTier(0, pmAddr, FEE);
  await tr.setTierMatrices(0, matAAddr, matBAddr);
  await tr.registerMatrix(matAAddr, 0);
  await tr.registerMatrix(matBAddr, 0);
  await tr.setMatrixKeeper(keeperAddr);
  await sf.setMatrixKeeper(keeperAddr);
  await sf.setTierFee(0, FEE);
  await sf.setTierRouter(trAddr);
  await keeper.setPairManager(0, pmAddr);

  // Grace periods to zero so BOTH arms discover work on the same schedule. If they were
  // left at defaults and the defaults differ between builds, every timing difference would
  // masquerade as an economic one.
  await optional(wiring, "setParkedGracePeriod", () => keeper.setParkedGracePeriod(0));
  await optional(wiring, "setSelfFundedGracePeriod", () => keeper.setSelfFundedGracePeriod(0));
  await optional(wiring, "setEvictionGracePeriod", () => keeper.setEvictionGracePeriod(0));

  return { owner, W1, devOps, sigs, usdc, cnova, treasury, sf, tr, pm, keeper, matA, matB,
           matAAddr, matBAddr, pmAddr, sfAddr, trAddr, keeperAddr, size, wiring };
}

/**
 * A structural fingerprint of the deployed world. This is the thing to diff BEFORE
 * running any sequence: if the two arms do not agree on matrix size, entry fee and the
 * keeper's dials, then any economic difference measured later is partly a configuration
 * difference and the experiment is void.
 */
async function fingerprint(hre, w) {
  const num = async (fn, label) => {
    try { return String(await fn()); } catch (e) { return `ABSENT (${label})`; }
  };
  return {
    arm: armOf(hre),
    sources: hre.config.paths.sources,
    matrixSize: await num(() => w.matA.MATRIX_SIZE(), "MATRIX_SIZE"),
    entryFee: await num(() => w.matA.ENTRY_FEE(), "ENTRY_FEE"),
    keeper: {
      maxItemsPerUpkeep: await num(() => w.keeper.maxItemsPerUpkeep(), "maxItemsPerUpkeep"),
      minGasPerItem: await num(() => w.keeper.minGasPerItem(), "minGasPerItem"),
      parkedGracePeriod: await num(() => w.keeper.parkedGracePeriod(), "parkedGracePeriod"),
      idleSlotTimeout: await num(() => w.keeper.idleSlotTimeout(), "idleSlotTimeout"),
    },
    wiring: w.wiring,
  };
}

module.exports = { deployWorld, fingerprint, armOf, SPLITS, CP_BPS, FEE };
