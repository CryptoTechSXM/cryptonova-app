"use strict";
/**
 * test_ab/00_smoke.js — STEP 0 OF THE A/B: can both arms even be deployed the same way?
 *
 * ⛔ WHY THIS RUNS BEFORE ANY SEQUENCE MACHINERY IS WRITTEN.
 *   v849b and v8.50 are 8 contracts and +1033/-136 apart. If their constructors or wiring
 *   differ, one shared deploy routine cannot serve both, and the entire A/B design has to
 *   change. That is worth ten seconds now rather than after a replay harness is built on
 *   top of an assumption.
 *
 *   This deploys ONE world per arm, prints a structural fingerprint, and writes it to
 *   ab_fingerprint_<arm>.json. Diff the two files. If matrixSize, entryFee or the keeper's
 *   dials disagree, the arms are not comparable and NOTHING measured later would mean what
 *   it appears to mean.
 *
 * Run BOTH:
 *   npx hardhat run test_ab/00_smoke.js --config hardhat.v849b.config.js
 *   npx hardhat run test_ab/00_smoke.js
 *
 * The arm labels itself from the active config, so the two commands cannot overwrite each
 * other's output even if run in the wrong order.
 *
 * Size defaults to 7 because this step is about STRUCTURE, not gas — a 127 world takes
 * minutes and proves nothing extra here. Override with AB_SIZE if needed.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployWorld, fingerprint, armOf } = require("./world");

async function main() {
  const size = Number(process.env.AB_SIZE || 7);
  const arm = armOf(hre);

  console.log(`\n  A/B SMOKE — arm ${arm}, MATRIX_SIZE ${size}`);
  console.log(`  sources: ${hre.config.paths.sources}`);
  console.log(`  artifacts: ${hre.config.paths.artifacts}\n`);

  const w = await deployWorld(hre, size);
  const fp = await fingerprint(hre, w);

  console.log(JSON.stringify(fp, null, 2));

  if (fp.wiring.absent.length) {
    console.log(`\n  ⚠ ${fp.wiring.absent.length} optional setter(s) NOT applied on this arm:`);
    for (const a of fp.wiring.absent) console.log(`      ${a}`);
    console.log(`  That is a REAL DIFFERENCE between the builds, not a nuisance. If the other`);
    console.log(`  arm applied them, the two worlds discover work on different schedules and`);
    console.log(`  every timing difference measured later would look like an economic one.`);
  }

  const out = path.join(hre.config.paths.root, `ab_fingerprint_${arm}.json`);
  fs.writeFileSync(out, JSON.stringify(fp, null, 2) + "\n");
  console.log(`\n  written: ${path.basename(out)}`);
  console.log(`  Run the other arm, then diff the two files before building anything else.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
