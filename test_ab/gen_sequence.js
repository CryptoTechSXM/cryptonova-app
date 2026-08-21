"use strict";
/**
 * test_ab/gen_sequence.js — writes the action script BOTH arms replay.
 *
 * ⛔ WHY THE SEQUENCE IS GENERATED ONCE AND SAVED, RATHER THAN GENERATED PER ARM.
 *   "The same script run twice" is not a control. The V8.49 run learned that the
 *   expensive way: "T6 UNANSWERED — the run had NO VALID CONTROL", because the control's
 *   process diverged from the subject's and nobody noticed until the numbers came back
 *   wrong. If each arm generated its own arrivals, any difference in the results would be
 *   part treatment and part sampling, in unknown proportion.
 *
 *   So the arrivals are a FILE. One file, two replays, byte-identical input. A difference
 *   in the outputs can then only come from the contracts.
 *
 * ⚠ NO Math.random ANYWHERE. A seeded LCG, so a seed reproduces a run exactly — which is
 *   what makes "run it three times" (rule 5: one sample is not a measurement) mean three
 *   INDEPENDENT populations rather than three coin flips. Vary the seed across replicates;
 *   never vary it between arms of the same replicate.
 *
 * Run:  node test_ab/gen_sequence.js [seed] [members] [size] [tail]
 *   e.g. node test_ab/gen_sequence.js 1 25 7
 *        node test_ab/gen_sequence.js 1 288 127
 *        node test_ab/gen_sequence.js 1 288 127 200     -> ab_sequence_s1_tail200.json
 *
 * ⛔ `tail` DEFAULTS TO 12 AND WRITES THE CANONICAL FILENAME. Any other value writes
 *    `ab_sequence_s<seed>_tail<n>.json` instead, so the three files sessions 18 and 19
 *    measured on — and that `diag_referral_threshold.js` section 4C reads to build the
 *    fixture's referral tree — CANNOT be overwritten by a tail experiment. 18.1's lesson
 *    ("the three seeds were not three samples of one thing") applies to a regenerated
 *    file just as much as to a different seed.
 *
 * ⚠ AND THE TAIL ADDS KEEPER TICKS ONLY, NEVER ARRIVALS — so no amount of tail changes
 *    the referral tree, the member count, or anything 19.1/19.2 rests on. That is what
 *    makes it a safe dial. It also means the tail cannot introduce NEW money into the
 *    pair, which is exactly why "lengthen it until the queue drains" is a hypothesis to
 *    be measured rather than a step to be followed. See handoff 21.
 */
const fs = require("fs");
const path = require("path");

// Numerical Recipes LCG. Chosen for being boring and reproducible in one line, not for
// statistical quality — the population shape matters here, not cryptographic randomness.
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296;
}

function main() {
  const seed = Number(process.argv[2] || 1);
  const members = Number(process.argv[3] || 25);
  const size = Number(process.argv[4] || 7);
  const TAIL_DEFAULT = 12;
  const tail = Number(process.argv[5] || TAIL_DEFAULT);
  const rnd = lcg(seed);

  const actions = [];
  let t = 0;

  // W1 (signer index 1) is the root: the first registration takes no referrer, exactly as
  // the live chain's accountOne did. Every later member picks a referrer from those ALREADY
  // REGISTERED, so the referral graph is a real tree rather than a star — the live chain's
  // shape, and it costs nothing to reproduce.
  actions.push({ t, op: "register", m: -1, ref: -2 });   // m:-1 = W1, ref:-2 = address(0)

  const joined = [-1];
  for (let i = 0; i < members; i++) {
    const ref = joined[Math.floor(rnd() * joined.length)];
    actions.push({ t, op: "register", m: i, ref });
    joined.push(i);

    // A keeper tick every few registrations, with time moving between them. Both the
    // cadence and the jitter come from the seeded stream, so both arms see the identical
    // interleaving of arrivals and keeper work — which is the whole point.
    if ((i + 1) % 5 === 0) {
      t += 1;
      actions.push({ t, op: "advance", secs: 3600 + Math.floor(rnd() * 3600) });
      actions.push({ t, op: "keeper" });
    }
  }

  // A long tail of keeper ticks with no new arrivals. The fund's trajectory is a claim
  // about what happens to a queue over TIME, and a run that stops the moment registration
  // stops never lets the queue drain or fail to drain.
  // ⚠ The LCG is consumed only by the arrival loop above, so the arrivals and their
  // interleaving are byte-identical for every `tail`. A tail sweep therefore varies one
  // thing and one thing only — which is the same discipline the arms themselves follow.
  for (let k = 0; k < tail; k++) {
    t += 1;
    actions.push({ t, op: "advance", secs: 86_400 });
    actions.push({ t, op: "keeper" });
  }

  const seq = {
    version: 1,
    seed, members, size, tail,
    generated: "deterministic — no wall-clock, no Math.random",
    note: "Replay this file on BOTH arms. Never regenerate it between arms of one replicate.",
    actions,
  };
  const suffix = tail === TAIL_DEFAULT ? "" : `_tail${tail}`;
  const out = path.join(__dirname, "..", `ab_sequence_s${seed}${suffix}.json`);
  fs.writeFileSync(out, JSON.stringify(seq, null, 1) + "\n");
  console.log(`wrote ${path.basename(out)}: seed ${seed}, ${members} members, MATRIX_SIZE ${size}, ` +
    `tail ${tail}, ${actions.length} actions, ` +
    `${actions.filter((a) => a.op === "keeper").length} keeper ticks`);
}

main();
