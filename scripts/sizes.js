// sizes.js — deployed bytecode size and EIP-170 headroom for the contracts that
// are actually tight. Run after every V8.46 edit.
//
// WHY: TierRouter has been within ~150 bytes of the 24,576 limit since V8.44, and
// MatrixPairFactory embeds FigureEightMatrixV8's CREATION code — so a change to
// the matrix silently inflates the factory. On 2026-07-28 a single extra revert
// string in FigureEightMatrixV8 put the factory 75 bytes over, and the only
// warning was a compiler note that scrolls past.
//
// Libraries (MatrixLogicLib) are LINKED, not embedded, so code placed there costs
// the factory nothing — which is why the V8.46 pair guard lives in the library.
//
// Run:  npx hardhat run scripts/sizes.js

const fs   = require("fs");
const path = require("path");

const LIMIT = 24576;
const WATCH = [
  "FigureEightMatrixV8", "TierRouter", "PairManagerV8", "MatrixPairFactory",
  "MatrixKeeper", "MatrixLogicLib", "StabilityFund", "CNOVAToken",
];

function findArtifact(name) {
  const root = path.join(__dirname, "..", "artifacts", "contracts");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === `${name}.json`) return full;
    }
  }
  return null;
}

let worst = 0;
console.log(`contract                 deployed    headroom   limit ${LIMIT}`);
console.log(`------------------------------------------------------------`);
for (const name of WATCH) {
  const f = findArtifact(name);
  if (!f) { console.log(`${name.padEnd(24)} (no artifact — not compiled?)`); continue; }
  let art;
  try { art = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { console.log(`${name.padEnd(24)} (unreadable: ${e.message.slice(0, 40)})`); continue; }
  const code = art.deployedBytecode && (art.deployedBytecode.object || art.deployedBytecode);
  if (typeof code !== "string") { console.log(`${name.padEnd(24)} (no deployedBytecode)`); continue; }
  const bytes = Math.max(0, (code.replace(/^0x/, "").length) / 2);
  const head  = LIMIT - bytes;
  const flag  = head < 0 ? "  *** OVER ***" : head < 300 ? "  <- tight" : "";
  console.log(`${name.padEnd(24)} ${String(Math.round(bytes)).padStart(8)}  ${String(Math.round(head)).padStart(9)}${flag}`);
  if (head < 0) worst = Math.min(worst, head);
}
console.log(`------------------------------------------------------------`);
console.log(worst < 0 ? `AT LEAST ONE CONTRACT IS OVER THE LIMIT — it will not deploy.`
                      : `All watched contracts fit.`);
console.log(`Note: a library's code is linked, not embedded — moving logic into`);
console.log(`MatrixLogicLib relieves both FigureEightMatrixV8 and MatrixPairFactory.`);
