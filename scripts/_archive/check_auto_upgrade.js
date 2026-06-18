/**
 * check_auto_upgrade.js — V5 Lightning diagnostics
 * Run: npx hardhat run scripts/check_auto_upgrade.js --network baseSepolia
 */
"use strict";
const { ethers } = require("hardhat");

// Lightning contracts — LATEST DEPLOY
const TIER_MANAGER   = "0x9a85c508379Ac5766FFd0EA563Ec2c3b92b45170";
const BELT_MANAGER   = "0x5b12E5adEA89F8FA09573B91eBbca43AD7C0fC27";
const MATRIX_T1      = "0x02D03794922F9918a7cc09d2c93cE4220D23Ad31";  // Belt A
const MATRIX_T2      = "0xb301BEEC45b7d05b15951ae3c993a48aD77a67C1";

const MEMBER = process.env.MEMBER || "0x19a59fbD6d2c1289668795D41453e1505B7B8102";

const fmt  = v => "$" + (Number(v) / 1e6).toFixed(4);
const fmtC = v => ethers.formatEther(v) + " CNOVA";

async function main() {
  const tm  = await ethers.getContractAt("CryptoNovaTierManager", TIER_MANAGER);
  const bm  = await ethers.getContractAt("BeltManager", BELT_MANAGER);
  const mx1 = await ethers.getContractAt("CryptoNovaMatrixV3", MATRIX_T1);
  const mx2 = await ethers.getContractAt("CryptoNovaMatrixV3", MATRIX_T2);

  console.log("\n====================================================");
  console.log("  Auto-Upgrade Diagnostic — Lightning Contracts");
  console.log("  Member:", MEMBER);
  console.log("====================================================\n");

  const isReg    = await bm.hasRegistered(MEMBER);
  const beltIdx  = isReg ? await bm.memberBeltIndex(MEMBER) : "—";
  const mx1Mem   = await mx1.getMember(MEMBER).catch(() => null);
  const cycles   = mx1Mem ? await mx1.getCyclesCompleted(MEMBER) : 0n;
  const curTier  = await tm.memberTier(MEMBER);
  const autoOn   = await tm.autoUpgradeEnabled(MEMBER);
  const caller   = await tm.autoUpgradeCaller(MATRIX_T1);
  const tmAddr   = await mx1.tierManagerAddr();
  const pos      = await mx1.positionOf(MEMBER).catch(() => 0n);
  // Extra: triggerReentry diagnostics
  const reentryPool  = await mx1.reentryPool().catch(() => 0n);
  const bmCaller     = await mx1.beltManagerCaller().catch(() => "N/A");
  const rotationCnt  = await mx1.rotationCount().catch(() => 0n);
  const occupancy    = await mx1.occupancy().catch(() => 0n);
  const activeBelt   = await bm.activeBelt();
  const activeBeltIdx= await bm.activeBeltIndex();

  const tier2Fee = await tm.tierFee(2);
  const cycleReq = await tm.cycleReq(1);

  console.log("--- Registration ---");
  console.log("BeltManager registered :", isReg ? `YES — Belt ${String.fromCharCode(65+Number(beltIdx))}` : "NO");
  console.log("In Belt A matrix       :", mx1Mem?.isRegistered ? "YES" : "NO");
  console.log("Queue position         :", pos.toString());
  console.log("Cycles completed       :", cycles.toString(), "(need", cycleReq.toString() + ")");

  console.log("\n--- triggerReentry diagnostics ---");
  console.log("Belt A reentryPool     :", fmt(reentryPool), reentryPool > 0n ? "✅ funded" : "❌ EMPTY — triggers skip silently");
  console.log("beltManagerCaller      :", bmCaller === BELT_MANAGER ? "CORRECT ✅" : "WRONG ❌ got: "+bmCaller);
  console.log("rotationCount (Belt A) :", rotationCnt.toString(), "(should increase with each trigger)");
  console.log("occupancy (Belt A)     :", occupancy.toString(), "(must be >= AW=2 for triggers to work)");
  console.log("Active belt index      :", activeBeltIdx.toString(), "→", activeBelt);

  console.log("\n--- TierManager state ---");
  console.log("Current tier           :", curTier.toString());
  console.log("Auto-upgrade enabled   :", autoOn ? "YES ✅" : "NO ❌ — call setAutoUpgrade(true)");
  console.log("Matrix T1 authorised   :", caller ? "YES ✅" : "NO ❌");
  console.log("tierManagerAddr on mx1 :", tmAddr === TIER_MANAGER ? "CORRECT ✅" : "WRONG ❌ — " + tmAddr);

  console.log("\n--- Upgrade check (Tier 1 → 2) ---");
  const withdrawable = mx1Mem?.withdrawable ?? 0n;
  console.log("Withdrawable balance   :", fmt(withdrawable));
  console.log("Tier 2 upgrade fee     :", fmt(tier2Fee));
  console.log("Balance sufficient     :", withdrawable >= tier2Fee ? "YES ✅" : "NO ❌ — need " + fmt(tier2Fee - withdrawable) + " more");
  console.log("Cycles sufficient      :", cycles >= cycleReq ? "YES ✅" : "NO ❌");

  // Check if already in Tier 2
  const mx2Mem = await mx2.getMember(MEMBER).catch(() => null);
  console.log("Already in Tier 2      :", mx2Mem?.isRegistered ? "YES ✅ — UPGRADE FIRED!" : "NO");

  const [eligible, reason] = await tm.canUpgrade(MEMBER).catch(() => [false, "error"]);
  console.log("canUpgrade()           :", eligible ? "ELIGIBLE ✅" : `NO — "${reason}"`);

  console.log("\n--- Summary ---");
  if (mx2Mem?.isRegistered) {
    console.log("✅ AUTO-UPGRADE ALREADY FIRED — member is in Tier 2");
  } else if (!autoOn) {
    console.log("❌ Auto-upgrade is OFF — member must enable it on the dashboard");
  } else if (!caller) {
    console.log("❌ Matrix T1 not authorised as auto-upgrade caller");
  } else if (tmAddr !== TIER_MANAGER) {
    console.log("❌ tierManagerAddr not set correctly on matrix");
  } else if (cycles < cycleReq) {
    console.log("⏳ Waiting for cycles — need " + cycleReq + ", have " + cycles);
    console.log("   Next rotation needed: position is " + pos);
  } else if (withdrawable < tier2Fee) {
    console.log("⏳ Waiting for balance — need " + fmt(tier2Fee) + ", have " + fmt(withdrawable));
    console.log("   Still needs: " + fmt(tier2Fee - withdrawable) + " more in withdrawable");
  } else {
    console.log("✅ ALL CONDITIONS MET — fires on next rotation (position " + pos + ")");
  }
  console.log("====================================================\n");
}

main().catch(e => { console.error(e); process.exit(1); });
