"use strict";
const { ethers } = require("hardhat");

const BELT_A = "0x048D380e118680438fA11eb26Dd7AcD79F230104";
const MEMBER = process.env.MEMBER || "0x19a59fbD6d2c1289668795D41453e1505B7B8102";

async function main() {
  const mx = await ethers.getContractAt("CryptoNovaMatrixV3", BELT_A);
  const total  = await mx.totalMembers();
  const aw     = await mx.ACTIVE_WINDOW();
  const pos    = await mx.positionOf(MEMBER).catch(() => 0n);
  const cycles = await mx.getCyclesCompleted(MEMBER);

  console.log("\n  Belt A Queue Status");
  console.log("  Total members :", total.toString());
  console.log("  Active Window :", aw.toString());
  console.log("  Your position :", pos.toString());
  console.log("  Your cycles   :", cycles.toString());
  console.log("  Joiners needed to reach pos 1:", pos > 1n ? (pos - 1n).toString() : "0 — you ARE at pos 1");
  console.log("  Auto-upgrade fires when:", pos > 1n
    ? `${(pos-1n).toString()} more rotation(s) push you to pos 1, then 1 more joiner triggers it`
    : "next joiner fires it NOW");
  console.log();
}
main().catch(e => { console.error(e); process.exit(1); });
