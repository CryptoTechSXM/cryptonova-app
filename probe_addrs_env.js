// probe_addrs_env.js - READ ONLY. Touches no chain, writes no file.
//
// WHY THIS EXISTS (2026-08-16):
// The V8.49 private measurement deploy depends entirely on ADDRESSES_FILE being
// overridable from the shell, so a test run drives the test deployment and not
// the live one members are registered on. .env pins ADDRESSES_FILE, and
// hardhat.config.js:2 calls dotenv.config() with NO override flag -- which means
// a shell variable SHOULD win. That is a reading of the loader, and a reading is
// not a measurement. This script is the measurement.
//
// Usage (PowerShell, repo root):
//   $env:ADDRESSES_FILE="deployed_addresses_v8_49.json"
//   npx hardhat run probe_addrs_env.js --network baseSepolia
//
// PASS: it prints the value you just set.
// FAIL: it prints .env's value instead -- meaning dotenv IS overriding, every
//       -AddressesFile you pass is decorative, and NOTHING may be run against a
//       test deployment until that is fixed.
//
// Deliberately prints no filename default of its own: a literal here would be a
// fourth copy of a fact that already lives in .env, deploy_v8.js and
// bigfill_v8.js, and this project has been bitten twice by exactly that.

const v = process.env.ADDRESSES_FILE;

console.log("");
console.log("  ADDRESSES_FILE as hardhat sees it : " + (v ? v : "(unset)"));
console.log("");
console.log("  Compare against the value you exported in this shell.");
console.log("  Same  -> shell override wins. Safe to run a cohort against a test deploy.");
console.log("  Differs -> dotenv is overriding. STOP; -AddressesFile is doing nothing.");
console.log("");
