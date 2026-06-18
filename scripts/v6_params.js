/**
 * V6 Test Parameters
 * ─────────────────────────────────────────────────────────────────────────
 * Price stays $10 across ALL tests. Everything else shrinks to go fast.
 *
 * LIGHTNING SELF-TEST (owner only, 2x pass required)
 * EXPEDITED COMMUNITY TEST (team, ~30 people)
 * FULL COMMUNITY TEST (wider community, mainnet params)
 */

"use strict";

const USDC_UNIT = 1_000_000n;  // 1e6 — $1 = 1,000,000

const PARAMS = {

  // ── Lightning self-test ──────────────────────────────────────────────────
  // Goal: see everything work in one sitting. Matrix fills in 7 members.
  // Belt fills in 10. Epochs change every 5 events. Full cycle in minutes.
  lightning: {
    label:              "⚡ LIGHTNING SELF-TEST",
    ENTRY_FEE_USDC:     10n * USDC_UNIT,         // $10 — same as mainnet
    MATRIX_SIZE:        7n,                        // 3-level tree, fills fast
    ACTIVE_WINDOW:      2n,                        // belt rotation every 2nd joiner
    BELT_MAX:           10n,                       // belt flips at 10 members
    EPOCH_MEMBER_LIMIT: 5n,                        // epoch changes every 5 events
    WHALE_GATE_T5:      1n,                        // 1 member opens T5 fast-track
    WHALE_GATE_T6:      1n,
    WHALE_GATE_T7:      1n,
    CW_TRANCHE_A_MAX:   5n,                        // first 5 = Nova Originals
    CW_MAX_FOUNDERS:    10n,                       // next 5 = Nova Pioneers
    CW_EPOCH_INTERVAL:  30 * 60,                   // 30 minutes (represents 30 days)
    CYCLE_REQ:          1n,                        // 1 cycle to upgrade all tiers
    NUM_BELTS:          5,                         // 5 belts pre-deployed
    note: "7-member matrix, W=2, BELT_MAX=10. Matrix fills in 7 joins, epoch changes every 5 events."
  },

  // ── Expedited community test ─────────────────────────────────────────────
  // Goal: team of ~30 people testing together. Matrix fills in 15 members.
  // Belt fills in 50. Full cycle visible in a session.
  expedited: {
    label:              "🚀 EXPEDITED COMMUNITY TEST",
    ENTRY_FEE_USDC:     10n * USDC_UNIT,           // $10 — same as mainnet
    MATRIX_SIZE:        15n,                        // 4-level tree
    ACTIVE_WINDOW:      5n,                         // belt rotation every 5th joiner
    BELT_MAX:           50n,                        // belt flips at 50 members
    EPOCH_MEMBER_LIMIT: 50n,                        // epoch changes every 50 events
    WHALE_GATE_T5:      2n,                         // 2 members open T5 fast-track
    WHALE_GATE_T6:      1n,
    WHALE_GATE_T7:      1n,
    CW_TRANCHE_A_MAX:   10n,                        // first 10 = Nova Originals
    CW_MAX_FOUNDERS:    20n,                        // next 10 = Nova Pioneers
    CW_EPOCH_INTERVAL:  30 * 60,                    // 30 minutes (represents 30 days)
    CYCLE_REQ:          1n,                         // 1 cycle to upgrade all tiers
    NUM_BELTS:          5,
    note: "15-member matrix, W=5, BELT_MAX=50. Visible cycling with 30-person team."
  },

  // ── Midscale self-test (full 127 matrix + quickfill) ────────────────────
  // Goal: test full BFS economics with quickfill script filling positions.
  // 127-member matrix = real earning positions, real chain pay distribution.
  // Use quickfill.js to auto-fill 20-25 positions per run.
  // 5-6 quickfill runs + 6 real wallets = full 127-member matrix.
  midscale: {
    label:              "🔥 MIDSCALE SELF-TEST (127 matrix + quickfill)",
    ENTRY_FEE_USDC:     10n * USDC_UNIT,            // $10 — same as mainnet
    MATRIX_SIZE:        127n,                        // 7-level tree, full BFS
    ACTIVE_WINDOW:      10n,
    BELT_MAX:           200n,                        // must be > MATRIX_SIZE (127) so matrix fills before belt flips
    EPOCH_MEMBER_LIMIT: 25n,                         // epoch every 25 events (fast for test)
    WHALE_GATE_T5:      1n,                          // open immediately
    WHALE_GATE_T6:      1n,
    WHALE_GATE_T7:      1n,
    CW_TRANCHE_A_MAX:   20n,                         // first 20 = Nova Originals
    CW_MAX_FOUNDERS:    40n,                         // next 20 = Nova Pioneers
    CW_EPOCH_INTERVAL:  30 * 60,                     // 30 minutes
    CYCLE_REQ:          1n,
    NUM_BELTS:          5,
    note: "Full 127-member BFS matrix. Use quickfill.js to fill positions. Real economics."
  },

  // ── Full community test (mainnet parameters) ────────────────────────────
  // Goal: test at real scale before going live. Everything at mainnet values.
  full: {
    label:              "🌐 FULL COMMUNITY TEST (MAINNET PARAMS)",
    ENTRY_FEE_USDC:     10n * USDC_UNIT,            // $10
    MATRIX_SIZE:        127n,                        // 7-level tree, production
    ACTIVE_WINDOW:      50n,                         // mainnet active window
    BELT_MAX:           500n,                        // mainnet belt max
    EPOCH_MEMBER_LIMIT: 10000n,                      // 10,000 events per epoch
    WHALE_GATE_T5:      25n,                         // 25 members open T5
    WHALE_GATE_T6:      15n,
    WHALE_GATE_T7:      5n,
    CW_TRANCHE_A_MAX:   1000n,                       // first 1,000 = Nova Originals
    CW_MAX_FOUNDERS:    2000n,                       // next 1,000 = Nova Pioneers
    CW_EPOCH_INTERVAL:  25 * 24 * 60 * 60,          // 25 days
    CYCLE_REQ:          1n,                          // 1 cycle to upgrade (confirmed)
    NUM_BELTS:          10,                          // 10 belts pre-deployed
    note: "Full mainnet parameters. 127-member matrix. This is the final test before going live."
  },
};

// Tier fee multipliers (same across all tests — price never changes)
const TIER_FEE_MULTIPLIERS = { 1:10, 2:25, 3:50, 4:100, 5:250, 6:500, 7:1000 };
const TIER_NAMES = {
  1:"Nova Seed", 2:"Nova Rise", 3:"Nova Star", 4:"Nova Prime",
  5:"SuperNova Genesis", 6:"SuperNova Elite", 7:"SuperNova Spark"
};

// Payment splits (Option B — fixed across all tests)
const SPLITS = {
  L1_BPS:       2500,  // 25% L1 referrer
  L2_BPS:       300,   //  3% L2 override
  L3_BPS:       200,   //  2% L3 override
  CHAIN_BPS:    4000,  // 40% chain pay
  TREASURY_BPS: 1500,  // 15% treasury
  CW_BPS:       1000,  // 10% community wallet
  DEVOPS_BPS:   500,   //  5% dev/ops
};

module.exports = { PARAMS, TIER_FEE_MULTIPLIERS, TIER_NAMES, SPLITS, USDC_UNIT };
