// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./MatrixKeeperLib.sol";

/**
 * @title  MatrixKeeper
 * @notice Chainlink Automation-compatible keeper for the V8.1 Elevator system.
 *
 *         RESPONSIBILITIES
 *         ----------------
 *         1. Velocity gate -- monitors per-tier entry rate; sets
 *            tierRouter.tierVelocityGreen[tier] based on a rolling window.
 *
 *         2. Deflation state machine -- tracks systemwide entry rate:
 *              NORMAL   -> entries in last window >= deflationThreshold
 *              SLOW     -> entries < deflationThreshold; activates L2 referral
 *                          carve and L4 devOps carve in StabilityFund
 *              RECOVERY -> entries recovering; transitions back to NORMAL
 *                          after recoveryThreshold consecutive green windows
 *
 *         3. Ghost entries -- when a matrix slot is idle for idleSlotTimeout
 *            seconds, the keeper funds a ghost entry from StabilityFund
 *            (L1 = entry fee from SF) so the matrix stays alive.
 *
 *         4. Idle slot reclaim -- after extendedIdleTimeout, a slot that is
 *            still idle after ghost funding is reclaimed (zero'd) to prevent
 *            a stuck slot from blocking future occupants.
 *
 *         5. Chain-link wiring -- after MatrixFactory.registerPair(), the
 *            keeper must call setChainNext() on new matrices to integrate them
 *            into the circular chain. The deploy script calls this directly;
 *            the keeper can also do it during upkeep.
 *
 *         AUTOMATION MODEL
 *         ----------------
 *         Chainlink Automation calls checkUpkeep() each block. If it returns
 *         true, Automation calls performUpkeep(performData) in the same block.
 *
 *         checkUpkeep encodes a WorkItem[] array in performData:
 *           - Each item has a type (VELOCITY_CHECK, GHOST_ENTRY, RECLAIM_SLOT)
 *             and up to 2 address/uint params.
 *
 *         performUpkeep processes all items in the batch.
 *
 *         GAS LIMIT
 *         ---------
 *         Set Chainlink upkeep gas limit to 3,000,000. Each ghost entry costs
 *         ~150k gas; each velocity check is ~30k; each reclaim is ~50k.
 *         The keeper batches at most MAX_ITEMS_PER_UPKEEP items to avoid
 *         exceeding the gas limit.
 */

// -- MatrixKeeper -------------------------------------------------------------

contract MatrixKeeper is Ownable {

    uint8 public constant STATE_NORMAL   = 0;
    uint8 public constant STATE_SLOW     = 1;
    uint8 public constant STATE_RECOVERY = 2;

    /// @notice ⚠️ HISTORICAL ONLY — DO NOT REASON FROM THIS VALUE. V8.49 (2026-08-15).
    ///         This said "must match MatrixLogicLib.RESCUE_REPAY_BPS" for three versions
    ///         after that constant stopped existing: V8.32 removed it (see the note at
    ///         MatrixLogicLib.sol:200) in favour of StabilityFund.rescueRepayBps (DAO
    ///         param #50), and V8.47 replaced THAT for the live redirect with the BANDED
    ///         clawback — StabilityFund.clawbackBpsFor(member), keyed to the issuing tier
    ///         (clawbackBpsByBand default [9000, 8000, 7000, 6000]; T1–T3 = 60%, not 50%).
    ///
    ///         Nothing reads this constant any more. It is kept, deprecated, only because
    ///         it was the input to the retired CROSSING_BUFFER_BPS derivation below, and
    ///         a future reader needs to know the derivation rested on a stale number:
    ///         redone at the live 60% band, the old formula yields 37.8%, not 36%.
    ///
    ///         THE LESSON, which outlives this constant: a mirrored constant with a
    ///         "must match X" comment silently becomes a lie the moment X moves. Read the
    ///         live value from the owning contract instead of mirroring it.
    uint256 public constant RESCUE_REPAY_BPS = 5_000;

    /// @notice The crossing reserve carved on entry — mirrors MatrixLogicLib's
    ///         CROSSING_RESERVE_BPS (:190) and, since V8.50 item A, prices the crossing
    ///         itself in _doParkedRescue. It is LOAD-BEARING here, not decorative.
    ///
    ///         ⛔ V8.50 DEFECT 2: `DIRECT_EARN_BPS = 500` USED TO SIT ON THIS LINE AND IT
    ///         WAS WRONG. V8.32 halved the real value to 250 (MatrixLogicLib:191) and
    ///         made payBase the full entry fee; the 50/5/45 split this docstring
    ///         described has not existed since. Nothing in the contract referenced it, so
    ///         it never broke a test — but it was PUBLIC, so any script reading it off
    ///         the keeper got 5% instead of 2.5% with no error to notice.
    ///
    ///         Deleted rather than corrected. This is the RESCUE_REPAY_BPS lesson
    ///         directly above, applied a second time: a mirrored constant with a
    ///         "must match X" comment becomes a lie the moment X moves. The three
    ///         scripts that mention direct earn (model_item_a, model_reserve_bps,
    ///         predeploy_check) all carry their own 250 with a source citation, and
    ///         model_item_a says outright that it does NOT read this one. They were
    ///         already routing around it.
    uint256 public constant CROSSING_RESERVE_BPS = 5_000;  // 50%

    /// @notice Effective pool income as a BPS fraction of the full entry fee.
    ///         V8.50 defect 2, same sweep: the derivation here was written against the
    ///         retired 4500 payBase. Since V8.32 payBase IS the entry fee and the pool
    ///         takes splitPoolBps of it directly — 1800bps, which is what the constant
    ///         has always said. The VALUE was right; only the arithmetic explaining it
    ///         was stale, which is the more dangerous shape of wrong.
    ///         pool income per entry = entryFee × splitPoolBps / 10_000
    ///                               = entryFee × 1800 / 10_000
    uint256 public constant POOL_BPS = 1_800;

    /// @notice BPS of the entry fee advanced as a CROSSING BUFFER on top of the entry-fee
    ///         shortfall, seeded into the rescued member's withdrawable so they can cross
    ///         again sooner. **DEFAULT 0 SINCE V8.49 — the buffer is OFF.**
    ///
    ///         V8.31 set this to a hardcoded 3_600 (36%) on this derivation: the next
    ///         crossing needs 50% of the fee from withdrawable, the member already has 5%
    ///         direct earn plus a 9% net pool cycle, so 50 − 5 − 9 = 36. That derivation
    ///         used RESCUE_REPAY_BPS = 5_000, which was already stale (see above).
    ///
    ///         WHY IT IS OFF (owner decision 2026-08-15, measured on the live V8.48 chain
    ///         with scripts/diag_floor_halt.js — full numbers in V8_49_SCOPE.md item 1b):
    ///
    ///         1. IT DWARFED THE THING IT SUPPLEMENTED. Real entry-fee shortfalls on the
    ///            live queue ran $0.41–$1.72 at a $10 T1 fee. The flat buffer added $3.60
    ///            to every one — **80% of everything the Stability Fund was asked for**
    ///            ($187.20 of $232.29 across 52 parked members).
    ///         2. IT MADE THE INSOLVENCY FLOOR UNENFORCEABLE. At 3_600 the buffer alone
    ///            exceeded insolvencyFloorBps (3_400), so EVERY advance cleared the floor
    ///            on its way past — including for a member with zero debt and zero
    ///            shortfall. The floor could not refuse anyone. At 0 it refuses on roughly
    ///            the third loan, which is the policy it was written for.
    ///         3. IT FED THE DEBT SPIRAL IT WAS MEANT TO PREVENT. The buffer is booked as
    ///            debt, and the banded clawback then takes 60% of the member's pool income
    ///            to repay it — consuming the very earnings they need to fund the next
    ///            crossing. Bigger advance → heavier clawback → larger next shortfall.
    ///            That is the loop diag_parked_growth.js measured on 2026-08-13.
    ///
    ///         KEPT AS A GOVERNED PARAM RATHER THAN DELETED so it is reversible without a
    ///         redeploy. The accepted risk of 0 is that rescued members re-park sooner
    ///         (they are re-seated with $0 withdrawable and must earn the full 50% again).
    ///         **If the parked queue stops draining, this is the knob** — dial it up and
    ///         the old behaviour returns at 3_600.
    ///
    ///         DAO param 61. Menu 0 / 900 / 1800 / 2700 / 3600 (0% / 9% / 18% / 27% / 36%).
    uint256 public crossingBufferBps = 0;

    uint8 public constant WORK_VELOCITY      = 0;
    uint8 public constant WORK_GHOST         = 1;
    uint8 public constant WORK_RECLAIM       = 2;
    uint8 public constant WORK_CHAIN_LINK    = 3;
    uint8 public constant WORK_PARKED_RESCUE = 4;
    uint8 public constant WORK_VELOCITY_GATE = 5;
    uint8 public constant WORK_EVICT_PARKED  = 6;
    uint8 public constant WORK_DISTRIBUTE_CW = 7;
    /// @notice V8.44 (item E): force-rotate a frozen full MatB. BACKSTOP ONLY —
    ///         V8.44's contract-driven flow (crossing-fund fix + overflow
    ///         rework) must keep MatBs rotating on their own; this work item
    ///         exists for pathological cases and must never be the primary
    ///         rotation driver (design law, owner 2026-07-25).
    uint8 public constant WORK_FORCE_ROTATE  = 8;
    /// @notice V8.44 (plan I1): auto-advance the CommunityWallet epoch on the
    ///         25th — without this, claimable never updates on mainnet and the
    ///         pending pool just grows.
    uint8 public constant WORK_ADVANCE_EPOCH = 9;

    uint256 public velocityWindow      = 3_600;
    uint256 public velocityThreshold   = 3;
    uint256 public deflationThreshold  = 10;
    uint256 public recoveryThreshold   = 3;
    uint256 public idleSlotTimeout     = 259_200;   // V8.33: 3 days (was 43200 = 12h)
    uint256 public extendedIdleTimeout = 604_800;   // V8.33: 7 days (was 86400 = 24h)
    /// @notice V8.50 defect 5 — 15 -> 20, AND IT IS NO LONGER THE GAS CONTROL.
    ///         Read minGasPerItem below first; this constant is now a coarse upper bound
    ///         on discovery work and calldata size, nothing more.
    ///
    ///         HOW IT GOT HERE, BECAUSE THE PATH MATTERS MORE THAN THE VALUE. Defect 5
    ///         opened as "lower it to 5 on gas grounds", resting on ~2.6M per rescued
    ///         item measured on the V8.49 private chain — a number that predated items A
    ///         and E1 and so described a population that no longer existed. It was held
    ///         at 15 rather than shipped, then MEASURED
    ///         (test/V8_50_KeeperGas.test.js, on this code, MATRIX_SIZE 7):
    ///             SF-funded rescue    1.49M median, 1.76M max
    ///             self-funded (item A) 0.92M       -- 1.62x cheaper
    ///             eviction             0.09M
    ///             ghost / reclaim      0.04M
    ///
    ///         A SATURATED batch — which defect 6 made ORDINARY, by taking parked work
    ///         first — projected at 1.76M/slot against a ~17.8M ceiling: 5 fits at 49%,
    ///         10 at 99%, 15 EXCEEDS at 148%. At the live MATRIX_SIZE 127, where the same
    ///         item costs ~2.6M, 5 fits at 73% and 10 EXCEEDS at 146%. So the answer
    ///         really was 5 — for a count.
    ///
    ///         ⛔ BUT A COUNT IS THE WRONG UNIT, AND 5 PROVED IT. An eviction costs 1/18th
    ///         of a rescue and a reclaim 1/44th. A count sized for the worst mix throws
    ///         away almost all the throughput on the common one: GAS-1 measured a
    ///         28-item batch at 4.90M, barely a quarter of the ceiling, while a cap of 5
    ///         would have run six of those items and stopped.
    ///
    ///         So the safety moved to minGasPerItem, which spends the transaction until
    ///         it genuinely cannot afford another item, and the count went UP rather than
    ///         down. A batch of evictions now runs all 20 for ~2M; a batch of rescues
    ///         still stops after four or five, because the floor stops it. Neither has to
    ///         be predicted in advance.
    ///
    ///         Why 20 and not 40: discovery is a view, but performData is CALLDATA on the
    ///         way back in, and _scanMatrix walks every position of every matrix before
    ///         the cap binds. 20 is the largest DAO menu value that keeps both modest.
    ///
    ///         DAO param 60; menu 5 / 10 / 15 / 20, setter additionally accepts 30 / 40.
    uint256 public maxItemsPerUpkeep   = 20;

    /// @notice V8.50 defect 8 — THE GAS FLOOR. performUpkeep stops starting new work
    ///         once fewer than this many gas units remain.
    ///
    ///         ⛔ AN OUT-OF-GAS BATCH DOES NOT REVERT. THAT IS WHY THIS EXISTS, AND THE
    ///         DEFECT 5 COMMENT ABOVE USED TO SAY THE OPPOSITE.
    ///
    ///         Every work item in performUpkeep is dispatched as `try this._doXExternal()`
    ///         — an external self-call. Under EIP-150 a sub-call receives 63/64 of the
    ///         remaining gas, so when the batch runs dry the sub-call consumes its 63/64,
    ///         reverts on out-of-gas, and the CATCH FIRES. The loop then continues with
    ///         1/64 of nothing and every remaining item fails the same way.
    ///
    ///         So exhaustion does not announce itself as a reverted transaction. It
    ///         announces itself as a CASCADE OF WorkItemFailed EVENTS — the same events
    ///         a floor refusal, an SF exhaustion or an already-rescued member produce.
    ///         The keeper looks like it ran. The queue looks like it was refused. This
    ///         is the failure this project already spent a day misdiagnosing once, in
    ///         exactly the shape that makes it hard to see.
    ///
    ///         THE FLOOR MUST EXCEED THE WORST SINGLE ITEM, or it lets the batch enter an
    ///         item it cannot finish and buys nothing. Measured in
    ///         test/V8_50_KeeperGas.test.js: worst item 1.76M at MATRIX_SIZE 7, and the
    ///         V8.49 chain measured ~2.6M for the same item at the live 127. 3_500_000
    ///         clears the live figure with ~35% margin.
    ///
    ///         WHY THIS AND NOT A SMALLER maxItemsPerUpkeep: an item count is the wrong
    ///         unit. An eviction costs 0.09M and a reclaim 0.04M against a rescue's
    ///         1.76M — a factor of 44 — so any count sized for the worst mix throws away
    ///         nearly all the throughput on the common one. The floor spends the
    ///         transaction until it genuinely cannot afford another item, so a batch of
    ///         evictions runs to completion and a batch of rescues stops early, without
    ///         either being told in advance which it is.
    ///
    ///         DAO param 63. Menu 2.5M / 3.5M / 5M / 7.5M.
    uint256 public minGasPerItem = 3_500_000;
    uint256 public parkedGracePeriod   = 6 hours;

    /// @notice V8.48 item 12 — floor for a rescue that costs the Stability Fund NOTHING
    ///         (the member's own withdrawable + crossing reserve covers the fee).
    ///
    ///         parkedGracePeriod protects members from unwanted LOANS. A self-funded
    ///         rescue is not a loan, so that protection does not apply — the member just
    ///         waits, 24h at the live setting, and then gets a loan anyway because the
    ///         copay path does not re-check self-funding after the wait.
    ///
    ///         5 minutes, matching fastlane_rescue.js's MIN_AGE. It is a race guard, not
    ///         a policy window: it stops a rescue being queued in the same minute a
    ///         member is mid-registration or mid-upgrade.
    ///         V8.49 CORRECTION: this line used to end "V8.25: mainnet default 6h;
    ///         testnet owner can set as low as 5 min". **6h was never reachable** —
    ///         setSelfFundedGracePeriod's menu stops at 3600 (1 hour) and that cap is
    ///         deliberate, because item 12 (above) redefined this from a protection
    ///         window into a RACE GUARD. The old text was a stale V8.25 statement that
    ///         item 12 superseded, and both deploy_v8.js and predeploy_check.js were
    ///         repeating it — predeploy would have HARD-FAILED a mainnet deploy demanding
    ///         a value no setter would accept. 5 minutes is correct on both networks; the
    ///         long window belongs to parkedGracePeriod, which is what it is for.
    uint256 public selfFundedGracePeriod = 5 minutes;

    /// @notice V8.49 item 1 — THE eviction clock. How long a parked member heading for
    ///         eviction (not rescue) is left alone first. **7 days.** ONE knob, read by
    ///         BOTH discovery and execution.
    ///
    ///         Owner policy, stated on V8.48 deploy day: "the SF always grows
    ///         organically, eviction should not happen for 3 to 5 days… 24hrs of
    ///         registrations before automated rescue kicks in on testnet and 48hrs on
    ///         mainnet — that is by design, to have members rescue themselves before SF
    ///         takes over."
    ///
    ///         ⚠️ READ THIS BEFORE BELIEVING THE SCOPE'S ORIGINAL FRAMING OF ITEM 1.
    ///         That framing — "V8.48 will evict real members 24 hours after they park" —
    ///         WAS WRONG, and this comment is the correction. It was written from
    ///         MatrixKeeperLib's evict branch alone, which gates DISCOVERY. Execution has
    ///         always had its own, independent gate: _doEvictParked refused any non-ghost
    ///         eviction until `extendedIdleTimeout` had passed — 7 days, never set at
    ///         deploy, so 7 days is what has always shipped. A member could be QUEUED for
    ///         eviction from 24h and simply never evicted; the work item was consumed and
    ///         _doEvictParked returned silently. **No member was ever exposed to a 24-hour
    ///         eviction.** The owner's 3-5 day policy was already met, at 7 days.
    ///
    ///         WHAT WAS ACTUALLY BROKEN, AND STILL IS WORTH FIXING: two unrelated knobs
    ///         governed one behaviour. Discovery used parkedGracePeriod (the SF rescue
    ///         clock); execution used extendedIdleTimeout (the IDLE-SLOT RECLAIM clock,
    ///         borrowed by V8.46 "mirroring _doReclaimSlot"). Neither means "eviction",
    ///         so eviction timing could not be read off any one value, could not be voted
    ///         on, and moved if either unrelated knob moved. And for six of those seven
    ///         days discovery emitted EVICT work items that execution refused — burning
    ///         slots out of maxItemsPerUpkeep (15) against a queue of 88 parked members.
    ///
    ///         SO THIS PARAM IS NOW THE ONLY EVICTION CLOCK. _checkParked gates discovery
    ///         on it and _doEvictParked gates execution on it. They agree by construction
    ///         and no futile work item is ever queued. extendedIdleTimeout goes back to
    ///         meaning only what its name says: idle-slot reclaim.
    ///
    ///         DEFAULT 7 DAYS = TODAY'S REAL BEHAVIOUR, deliberately (owner decision
    ///         2026-08-16). This change is therefore member-neutral: nobody's eviction
    ///         timing moves. Dialling it to 3/4/5 days is now a DAO vote instead of a
    ///         redeploy, which is the point — the policy became reachable, not enacted.
    ///
    ///         WHO WAITS: the three cases that remove a REAL member — withdrawRatio past
    ///         rescueRatioBps, off the bottom of the SF rescue ladder, and the item 46
    ///         insolvency floor. GHOSTS DO NOT, on either side: a parked record whose
    ///         holder is already seated is dequeued on parkedGracePeriod in discovery and
    ///         bypasses the gate entirely in _doEvictParked. It costs its holder nothing
    ///         and there is no one to protect.
    ///
    ///         DAO param 62. Menu 0 / 1d / 2d / 3d / 4d / 5d / 7d. Setting it EQUAL to
    ///         parkedGracePeriod reproduces pre-V8.49 DISCOVERY exactly — that collapse
    ///         property is what keeps V8_48_KeeperScan's frozen-keeper equivalence
    ///         harness meaningful, and it is asserted in V8_49_EvictionClock.test.js.
    ///         0 means evict as soon as triage says so, with NO wait: it is the same
    ///         admin/testing override parkedGracePeriod's 0 is, not an "off" switch.
    ///
    ///         MAINNET: parkedGracePeriod 48h must be set AT DEPLOY. This one ships at
    ///         its declared default; predeploy_check.js asserts the default is inside
    ///         policy so that cannot change silently.
    uint256 public evictionGracePeriod = 7 days;   // 604_800 — today's real behaviour
    uint256 public rescueRatioBps      = 7_000;
    /// @notice V8.44 (item E) / V8.48 item 24 (owner decision 2026-08-13): how long
    ///         a FULL MatB may sit without rotating before on-chain automation
    ///         force-rotates it. Was 6 hours framed as a "backstop the design
    ///         should never need" — but ALL 6,726 force-rotations in the
    ///         protocol's history came from the VPS script rotating at ~10
    ///         minutes: prompt rotation of a quiet full MatB IS the lived
    ///         policy members' cycling speed depends on. The CONTRACT now owns
    ///         it at 15 minutes; the VPS frozen_matb_keeper is retired at the
    ///         V8.48 deploy (delete its cron line — do not run two policies).
    ///         Owner/governance-settable, 5 min – 30 days.
    uint256 public frozenMatBTimeout   = 15 minutes;
    /// @notice V8.33: Ghost entries are disabled by default.  Ghost entries drain the SF to
    ///         fill empty slots with fake positions.  At launch, empty slots should fill with
    ///         real members.  DAO can flip on if the matrix genuinely stalls.
    bool    public ghostEntryEnabled   = false;

    address public tierRouter;
    address public stabilityFund;
    address public communityWallet;
    /// @notice V8.20: DAO governance contract. Co-governs the params below
    ///         alongside owner -- neither replaces the other (owner keeps emergency backstop).
    address public governance;

    /// @notice V8.46 item 1: allowlist of EOAs permitted to drive performUpkeep
    ///         (the DigitalOcean keeper wallets; Chainlink forwarder if kept).
    ///         owner() and governance are always allowed. Closes the open-door hole
    ///         where anyone could hand-craft a WorkItem[] and drive the whole queue.
    mapping(address => bool) public upkeepCaller;

    /// @notice V8.20/V8.21: SF parked-rescue coverage ladder, governable.
    ///         thresholds[i] = bps breakpoint on what the member holds versus what the
    ///                         crossing costs (descending). V8.50 item A: BOTH sides of
    ///                         that ratio changed and neither is "withdrawable/entryFee"
    ///                         any more — the numerator credits the crossing reserve
    ///                         carve and the denominator is the crossing price, which is
    ///                         half a fee on an A->B hop. See
    ///                         MatrixKeeperLib._triageParked for why, and do not
    ///                         re-derive these presets from the old description.
    ///         bpsLadder[i]  = SF coverage bps at that breakpoint (ascending).
    ///         Below the lowest threshold => ineligible for rescue (evict instead).
    ///         V8.21: free-form custom arrays were removed -- the DAO now picks
    ///         one of 4 curated presets via setSfRescueLadderPreset() instead of
    ///         designing a ladder from scratch. Defaults reproduce the exact
    ///         V8.18 hardcoded ladder (preset 1, "Default").
    uint256[] public sfRescueThresholds = [
        uint256(10_000), 9_500, 9_000, 8_500, 8_000, 7_500, 7_000, 6_500, 6_000, 5_000, 4_000
    ];
    uint256[] public sfRescueBpsLadder = [
        uint256(0), 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 6_000
    ];
    /// @notice Which preset is currently active. 0=Conservative, 1=Default,
    ///         2=Generous, 3=Maximum. See setSfRescueLadderPreset() for the
    ///         exact numbers in each.
    uint8 public sfRescueLadderPreset = 1;

    uint8   public deflationState;
    uint256 public lastVelocityCheck;
    uint256 public consecutiveGreenWindows;
    uint256 public consecutiveRedWindows;

    mapping(uint8 => address) public pairManagerForTier;
    uint8 public configuredTierCount;

    mapping(address => uint256) public lastGhostTime;
    mapping(address => mapping(address => uint256)) public reclaimAttemptTime;

    /// @dev V8.48 item 12a: the struct is declared in MatrixKeeperLib so the library
    ///      can build the scan snapshot from it. Field order and the public getter's
    ///      ABI are unchanged.
    MatrixKeeperLib.PendingChainLink[] public pendingChainLinks;

    event VelocityUpdated(uint8 indexed tier, bool green, uint256 entryCount);
    event DeflationStateChanged(uint8 from, uint8 to);
    event GhostEntryFunded(address indexed matrix, uint8 tierIndex);
    event SlotReclaimed(address indexed matrix, address indexed member, uint256 idleSeconds);
    event ChainLinked(address newMatA, address newMatB, address prevMatB);
    event PairManagerSet(uint8 indexed tierIndex, address pairManager);
    event ParkedRescued(address indexed matrix, address indexed member, uint8 tierIndex);
    event VelocityGateOpened(uint8 indexed forTierIndex);
    event ParkedMemberEvicted(address indexed matrix, address indexed member, uint256 totalWithdrawn);
    event ConfigUpdated(string indexed param, uint256 value);
    event CommunityDistributed(address indexed cw);
    event WorkItemFailed(uint8 indexed workType, uint8 tierIndex, address addr1, address addr2);
    /// @notice V8.50 defect 8: the batch stopped early because gas ran low. Emitted
    ///         INSTEAD of the silent WorkItemFailed cascade described at minGasPerItem —
    ///         the whole point is that exhaustion is now distinguishable from refusal in
    ///         the logs. `processed` items ran; `total - processed` were left for the
    ///         next upkeep, which will rediscover them.
    event BatchGasHalted(uint256 processed, uint256 total, uint256 gasRemaining);
    event GovernanceSet(address indexed governance);
    event UpkeepCallerSet(address indexed caller, bool allowed);
    /// @dev V8.21: replaces SfRescueLadderUpdated -- presets, not free-form arrays.
    event SfRescueLadderPresetSet(uint8 preset, uint256 rungs, uint256 deepestBps);

    error MK_NotKeeper();
    error MK_InvalidParam();
    error MK_ZeroAddress();

    /// @dev V8.48 item 12a: WorkItem moved to MatrixKeeperLib. performData stays
    ///      wire-compatible — abi.encode of an identical tuple shape — so an upkeep
    ///      already in flight across the upgrade still decodes.
    using MatrixKeeperLib for MatrixKeeperLib.ScanCfg;

    constructor(address _tierRouter, address _stabilityFund) Ownable(msg.sender) {
        if (_tierRouter    == address(0)) revert MK_ZeroAddress();
        if (_stabilityFund == address(0)) revert MK_ZeroAddress();
        tierRouter    = _tierRouter;
        stabilityFund = _stabilityFund;
        lastVelocityCheck = block.timestamp;
    }

    /// @notice V8.20: owner keeps emergency backstop, governance address co-governs.
    modifier onlyOwnerOrGovernance() {
        require(msg.sender == owner() || msg.sender == governance, "MK: not authorized");
        _;
    }

    /// @notice V8.20: wire the V8Governance contract so DAO-passed proposals can execute.
    function setGovernance(address _gov) external onlyOwner {
        if (_gov == address(0)) revert MK_ZeroAddress();
        governance = _gov;
        emit GovernanceSet(_gov);
    }

    /// @notice V8.46 item 1: authorize/deauthorize an EOA to call performUpkeep.
    function setUpkeepCaller(address caller, bool allowed) external onlyOwnerOrGovernance {
        if (caller == address(0)) revert MK_ZeroAddress();
        upkeepCaller[caller] = allowed;
        emit UpkeepCallerSet(caller, allowed);
    }

    function setPairManager(uint8 tierIndex, address pm) external onlyOwner {
        if (pm == address(0)) revert MK_ZeroAddress();
        if (pairManagerForTier[tierIndex] == address(0)) configuredTierCount++;
        pairManagerForTier[tierIndex] = pm;
        emit PairManagerSet(tierIndex, pm);
    }

    function queueChainLink(address newMatA, address newMatB, address prevMatB, uint8 tierIdx)
        external onlyOwner
    {
        pendingChainLinks.push(MatrixKeeperLib.PendingChainLink(newMatA, newMatB, prevMatB, tierIdx));
    }

    function setVelocityWindow(uint256 v) external onlyOwnerOrGovernance {
        require(v == 1800 || v == 3600 || v == 7200 || v == 14400, "MK: invalid window");
        velocityWindow = v;
    }
    function setVelocityThreshold(uint256 v) external onlyOwnerOrGovernance {
        require(v == 1 || v == 2 || v == 3 || v == 5, "MK: invalid threshold");
        velocityThreshold = v;
    }
    function setDeflationThreshold(uint256 v) external onlyOwnerOrGovernance {
        require(v == 5 || v == 10 || v == 15 || v == 20, "MK: invalid deflation threshold");
        deflationThreshold = v;
    }
    function setIdleSlotTimeout(uint256 v) external onlyOwnerOrGovernance {
        // V8.33: expanded range — 6h, 12h, 24h, 3d, 7d
        require(v == 21600 || v == 43200 || v == 86400 || v == 3 days || v == 7 days, "MK: invalid idle timeout");
        idleSlotTimeout = v;
        emit ConfigUpdated("idleSlotTimeout", v);
    }
    /// @notice V8.33: DAO-governable reclaim window (1 day – 90 days).
    function setExtendedIdleTimeout(uint256 v) external onlyOwnerOrGovernance {
        require(v >= 1 days && v <= 90 days, "MK: out of range (1d-90d)");
        extendedIdleTimeout = v;
        emit ConfigUpdated("extendedIdleTimeout", v);
    }
    /// @notice V8.33: Toggle ghost entries on/off.  Off by default — preserves SF for rescues.
    function setGhostEntryEnabled(bool v) external onlyOwnerOrGovernance {
        ghostEntryEnabled = v;
        emit ConfigUpdated("ghostEntryEnabled", v ? 1 : 0);
    }
    /// @notice V8.50 defect 8. Enumerated like every other keeper setter. The floor
    ///         must stay ABOVE the worst single item's cost or it stops protecting
    ///         anything — 2_500_000 is the lowest value offered and it is already close
    ///         to the ~2.6M a live-size rescue measured, so treat it as the floor of the
    ///         floor rather than a normal choice.
    function setMinGasPerItem(uint256 v) external onlyOwnerOrGovernance {
        require(v == 2_500_000 || v == 3_500_000 || v == 5_000_000 || v == 7_500_000,
            "MK: invalid min gas (2.5M/3.5M/5M/7.5M)");
        minGasPerItem = v;
        emit ConfigUpdated("minGasPerItem", v);
    }

    function setMaxItemsPerUpkeep(uint256 v) external onlyOwnerOrGovernance {
        // V8.31: ceiling raised to 40 to handle 10 tiers × 2 matrices at scale
        require(v == 5 || v == 10 || v == 15 || v == 20 || v == 30 || v == 40, "MK: invalid max items");
        maxItemsPerUpkeep = v;
    }
    /// @notice V8.20: DAO-governable.
    /// @dev V8.25: changed from enum check to range. 0 = no grace period (testing/admin override).
    ///      Non-zero values must be between 5 minutes and 30 days.
    ///      Mainnet recommendation: 6 hours (21600). Testnet: 0 or 5-10 minutes.
    function setParkedGracePeriod(uint256 v) external onlyOwnerOrGovernance {
        require(v == 0 || (v >= 5 minutes && v <= 30 days), "MK: grace period out of range (0 or 5min-30d)");
        parkedGracePeriod = v;
        emit ConfigUpdated("parkedGracePeriod", v);
    }
    /// @notice V8.20: DAO-governable. Allowed: 5000,6000,7000,8000,9000,9500.
    /// @notice V8.48 item 12. Enumerated like every other keeper setter. Capped at 1
    ///         hour: this is a race guard, and anything longer is a loan-protection
    ///         window, which is what parkedGracePeriod is for.
    function setSelfFundedGracePeriod(uint256 v) external onlyOwnerOrGovernance {
        require(v == 0 || v == 60 || v == 300 || v == 900 || v == 1800 || v == 3600,
            "MK: invalid self-funded grace (0/60/300/900/1800/3600)");
        selfFundedGracePeriod = v;
        emit ConfigUpdated("selfFundedGracePeriod", v);
    }

    /// @notice V8.49 item 1: the EVICTION clock. Enumerated like every other keeper
    ///         setter (house convention: menus, not free ranges).
    /// @dev    BOTH ends of the menu are load-bearing and neither is decoration:
    ///
    ///         86400 (24h) is the PRE-V8.49 value. A default that is not on its own
    ///         menu cannot be voted back (the item-42 lesson), and here the value to be
    ///         able to return to is not just the default — it is the OLD BEHAVIOUR.
    ///         Set this equal to parkedGracePeriod and V8.49's clock split collapses
    ///         to nothing, which is the property the frozen-keeper equivalence harness
    ///         in V8_48_KeeperScan.test.js depends on.
    ///
    ///         0 is the admin/testing override, exactly as it is for
    ///         setParkedGracePeriod — evict the instant triage says so. It is NOT an
    ///         "eviction off" switch; it is the opposite, and it is on the menu because
    ///         that same equivalence harness pins BOTH clocks to 0.
    ///
    ///         Capped at 7 days: beyond that a parked seat is held indefinitely by a
    ///         member the triage has already judged unrescuable, which is the queue
    ///         congestion the eviction valve exists to relieve. 7 days is also the
    ///         DEFAULT — it is what extendedIdleTimeout was already enforcing on the
    ///         execution side before V8.49 made this the single clock, so the cap and
    ///         the default coincide by design, not by accident. Voting the policy's
    ///         3-5 days means voting DOWN from here.
    function setEvictionGracePeriod(uint256 v) external onlyOwnerOrGovernance {
        require(
            v == 0 || v == 86_400 || v == 172_800 || v == 259_200 ||
            v == 345_600 || v == 432_000 || v == 604_800,
            "MK: invalid eviction grace (0/1d/2d/3d/4d/5d/7d)"
        );
        evictionGracePeriod = v;
        emit ConfigUpdated("evictionGracePeriod", v);
    }

    function setRescueRatioBps(uint256 v) external onlyOwnerOrGovernance {
        require(
            v == 5_000 || v == 6_000 || v == 7_000 ||
            v == 8_000 || v == 9_000 || v == 9_500,
            "MK: invalid ratio"
        );
        rescueRatioBps = v;
        emit ConfigUpdated("rescueRatioBps", v);
    }

    /// @notice V8.49: the crossing buffer, now a dial instead of a hardcoded 36%.
    ///         DEFAULT 0 — see the crossingBufferBps declaration for why, and for what
    ///         to watch before turning it back up. Enumerated like every other keeper
    ///         setter (house convention: menus, not free ranges), with BOTH the current
    ///         default (0) and the retired V8.31 value (3_600) on the menu — the item-42
    ///         lesson: a default that is not on its own menu cannot be voted back.
    function setCrossingBufferBps(uint256 v) external onlyOwnerOrGovernance {
        require(
            v == 0 || v == 900 || v == 1_800 || v == 2_700 || v == 3_600,
            "MK: invalid crossing buffer (0/900/1800/2700/3600)"
        );
        crossingBufferBps = v;
        emit ConfigUpdated("crossingBufferBps", v);
    }
    function setCommunityWallet(address _cw) external onlyOwner {
        communityWallet = _cw;
        emit ConfigUpdated("communityWallet", uint256(uint160(_cw)));
    }
    /// @notice V8.44 (item E): DAO/owner-tunable frozen-MatB backstop delay.
    ///         5 min – 30 days; 0 = fire immediately (testing only).
    function setFrozenMatBTimeout(uint256 v) external onlyOwnerOrGovernance {
        require(v == 0 || (v >= 5 minutes && v <= 30 days), "MK: timeout out of range");
        frozenMatBTimeout = v;
        emit ConfigUpdated("frozenMatBTimeout", v);
    }

    /// @notice V8.21: Pick one of 4 curated SF parked-rescue coverage ladders.
    ///         Replaces the old free-form custom-array proposal -- the community
    ///         picks a shape, it doesn't design one from scratch.
    ///         0 = Conservative: floor at 50% withdrawn, coverage caps at 50%.
    ///             [10000,9000,8000,7000,6000,5000] -> [0,1000,2000,3000,4000,5000]
    ///         1 = Default: the original V8.18 ladder. Floor 40%, caps at 60%.
    ///             [10000,9500,9000,8500,8000,7500,7000,6500,6000,5000,4000]
    ///             -> [0,1000,1500,2000,2500,3000,3500,4000,4500,5000,6000]
    ///         2 = Generous: floor at 30% withdrawn, coverage caps at 80%.
    ///             [10000,9000,8000,7000,6000,5000,4000,3000] -> [0,1500,2500,3500,4500,5500,7000,8000]
    ///         3 = Maximum: floor at 10% withdrawn, coverage can reach 100%.
    ///             [10000,9000,8000,7000,6000,5000,4000,3000,2000,1000]
    ///             -> [0,1500,2500,3500,5000,6000,7000,8000,9000,10000]
    /// @dev Takes uint256 (not uint8) so it matches the generic uint256-value
    ///      dispatch every other governance setter in this codebase uses.
    function setSfRescueLadderPreset(uint256 preset) external onlyOwnerOrGovernance {
        require(preset <= 3, "MK: invalid preset (0-3)");
        sfRescueLadderPreset = uint8(preset);
        _applyLadderPreset(uint8(preset));
    }

    /// @dev ✅ OWNER DECISION 2026-08-18 — THE BOTTOM RUNG STAYS AT PRESET 1 (4000 bps).
    ///
    ///      The question was whether item A pushes early-MatB members off the bottom of
    ///      the ladder: their effective contribution reads ~3400 bps against preset 1's
    ///      4000 floor, so they would fall off DEBT-FREE where V8.48 kept them on it
    ///      owing $1.60. Presets 2 and 3 reach 3000 and 1000 and would have caught them.
    ///
    ///      MEASURED — scripts/model_item_a.js PHASE 7, all 40 live MatB parkers:
    ///          10000+      6 members
    ///          8000-8500   3
    ///          7000-7500  24
    ///          6500-7000   7
    ///          BELOW 4000  0      <- NOBODY
    ///      Preset 2 would additionally rescue 0. Preset 3 would additionally rescue 0.
    ///
    ///      ⛔ THE ~3400 READING WAS A PRE-E1 ARTEFACT. It only arises on the LEDGER
    ///      basis, where item A leaves journey-A earnings stranded in the MatA ledger
    ///      that the re-entry gate cannot see. Item E1 carries that balance across, so
    ///      the gate sees journey A + journey B and the whole population sits at 6500
    ///      bps and above. E1 did not only close the conservation hole — it removed the
    ///      reason to touch this ladder at all.
    ///
    ///      Changing the rung would therefore be a change with NO MEASURED EFFECT, on a
    ///      structure every rescue test is calibrated against. Re-open it only if a
    ///      future PHASE 7 shows members below 4000.
    function _applyLadderPreset(uint8 preset) internal {
        delete sfRescueThresholds;
        delete sfRescueBpsLadder;

        if (preset == 0) {
            uint256[6] memory t = [uint256(10_000), 9_000, 8_000, 7_000, 6_000, 5_000];
            uint256[6] memory b = [uint256(0), 1_000, 2_000, 3_000, 4_000, 5_000];
            for (uint256 i = 0; i < t.length; i++) { sfRescueThresholds.push(t[i]); sfRescueBpsLadder.push(b[i]); }
        } else if (preset == 1) {
            uint256[11] memory t = [uint256(10_000), 9_500, 9_000, 8_500, 8_000, 7_500, 7_000, 6_500, 6_000, 5_000, 4_000];
            uint256[11] memory b = [uint256(0), 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 6_000];
            for (uint256 i = 0; i < t.length; i++) { sfRescueThresholds.push(t[i]); sfRescueBpsLadder.push(b[i]); }
        } else if (preset == 2) {
            uint256[8] memory t = [uint256(10_000), 9_000, 8_000, 7_000, 6_000, 5_000, 4_000, 3_000];
            uint256[8] memory b = [uint256(0), 1_500, 2_500, 3_500, 4_500, 5_500, 7_000, 8_000];
            for (uint256 i = 0; i < t.length; i++) { sfRescueThresholds.push(t[i]); sfRescueBpsLadder.push(b[i]); }
        } else {
            uint256[10] memory t = [uint256(10_000), 9_000, 8_000, 7_000, 6_000, 5_000, 4_000, 3_000, 2_000, 1_000];
            uint256[10] memory b = [uint256(0), 1_500, 2_500, 3_500, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000];
            for (uint256 i = 0; i < t.length; i++) { sfRescueThresholds.push(t[i]); sfRescueBpsLadder.push(b[i]); }
        }

        emit SfRescueLadderPresetSet(preset, sfRescueThresholds.length, sfRescueBpsLadder[sfRescueBpsLadder.length - 1]);
    }

    /**
     * @notice V8.48 item 12a: the scan itself lives in MatrixKeeperLib.
     *
     *         This function's only job now is to snapshot the storage the scan
     *         reads and hand it over. That snapshot is not free, but checkUpkeep is
     *         simulated OFF-CHAIN by Chainlink — no member ever pays for it — and
     *         it buys back the headroom item 12 needs.
     *
     *         lastGhostTime crosses as a storage reference rather than a copy: it is
     *         a mapping, so there is no bounded set of keys to flatten.
     */
    function checkUpkeep(bytes calldata)
        external view
        returns (bool upkeepNeeded, bytes memory performData)
    {
        address[] memory pms = new address[](configuredTierCount);
        for (uint8 t = 0; t < configuredTierCount; t++) pms[t] = pairManagerForTier[t];

        MatrixKeeperLib.ScanCfg memory cfg = MatrixKeeperLib.ScanCfg({
            maxItems:            maxItemsPerUpkeep,
            lastVelocityCheck:   lastVelocityCheck,
            velocityWindow:      velocityWindow,
            frozenMatBTimeout:   frozenMatBTimeout,
            idleSlotTimeout:     idleSlotTimeout,
            extendedIdleTimeout: extendedIdleTimeout,
            parkedGracePeriod:   parkedGracePeriod,
            selfFundedGracePeriod: selfFundedGracePeriod,
            evictionGracePeriod: evictionGracePeriod,
            // V8.49 item 1b: carried ONLY so discovery can ask the insolvency floor about
            // the same advance _doParkedRescue will ask the SF for. Leaving it out would
            // let a future vote on param 61 silently re-arm the batch-halt path, because
            // discovery would be asking about sfShare while the lender was asked for
            // sfShare + buffer. The ScanCfg field order is not load-bearing (named
            // initialiser), but a MISSING field is a compile error — deliberately.
            crossingBufferBps:   crossingBufferBps,
            rescueRatioBps:      rescueRatioBps,
            configuredTierCount: configuredTierCount,
            tierRouter:          tierRouter,
            stabilityFund:       stabilityFund,
            communityWallet:     communityWallet,
            pairManagers:        pms,
            links:               pendingChainLinks,
            sfThresholds:        sfRescueThresholds,
            sfLadder:            sfRescueBpsLadder
        });

        MatrixKeeperLib.WorkItem[] memory items = MatrixKeeperLib.discover(cfg, lastGhostTime);
        if (items.length == 0) return (false, "");
        upkeepNeeded = true;
        performData  = abi.encode(items);
    }

    /**
     * @notice V8.17: try/catch per work item so one failure never blocks the loop.
     */
    function performUpkeep(bytes calldata performData) external {
        // V8.46 item 1: allowlist — was external with NO guard, so anyone could drive the queue.
        require(
            msg.sender == owner() || msg.sender == governance || upkeepCaller[msg.sender],
            "MK: not authorized keeper"
        );
        MatrixKeeperLib.WorkItem[] memory items =
            abi.decode(performData, (MatrixKeeperLib.WorkItem[]));
        uint256 chainLinkProcessed = 0;
        for (uint256 i = 0; i < items.length; i++) {
            // V8.50 defect 8. Checked BEFORE dispatch, not after: the point is never to
            // start an item the transaction cannot finish. `gasleft()` is 2 gas, so this
            // costs nothing measurable against a batch that spends millions.
            //
            // Deliberately a `break` and not a `revert`. The items not reached are still
            // in the queue and checkUpkeep rediscovers them on the next tick — the work
            // is deferred, never dropped. Reverting would throw away the items that
            // ALREADY SUCCEEDED in this transaction, which is the opposite of what a
            // gas guard is for.
            if (gasleft() < minGasPerItem) {
                emit BatchGasHalted(i, items.length, gasleft());
                break;
            }
            MatrixKeeperLib.WorkItem memory item = items[i];
            if (item.workType == WORK_VELOCITY) {
                try this._doVelocityCheckExternal() {}
                catch { emit WorkItemFailed(WORK_VELOCITY, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_GHOST) {
                try this._doGhostEntryExternal(item.addr1, item.tierIndex) {}
                catch { emit WorkItemFailed(WORK_GHOST, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_RECLAIM) {
                try this._doReclaimSlotExternal(item.addr1, item.addr2, item.tierIndex) {}
                catch { emit WorkItemFailed(WORK_RECLAIM, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_CHAIN_LINK) {
                try this._doChainLinkExternal(item.addr1, item.addr2, chainLinkProcessed) {}
                catch { emit WorkItemFailed(WORK_CHAIN_LINK, item.tierIndex, item.addr1, item.addr2); }
                chainLinkProcessed++;
            } else if (item.workType == WORK_PARKED_RESCUE) {
                // V8.18: only swallow expected "already done" strings; unexpected reverts bubble up.
                // V8.24: added "insufficient withdrawable for rescue" -- member cannot cover their
                //        share under the SF rescue ladder; skip them so the rest of the batch runs.
                //        This is what makes the ladder self-sustaining without SF top-ups.
                // V8.49 item 1b: added "SF: insolvency floor" and "SF: below floor".
                //
                // BELT AND BRACES, AND SAY WHY. Discovery now asks the floor about the
                // exact advance the SF will be asked for (MatrixKeeperLib._triageParked),
                // so a floor refusal here should be unreachable. "Should be" is the whole
                // reason it is on the list: the alternative to swallowing it is reverting
                // the ENTIRE batch — velocity, chain-links, evictions, the CW epoch — on
                // one member's arithmetic. A skipped member is recoverable next tick; a
                // halted keeper is the outage this project spent 2026-07-30 recovering
                // from. "SF: below floor" is the same shape: the fund running out of
                // money must skip a member, never stop the queue (measured 2026-08-16:
                // stabilityFloor is $0.00 today, so exhaustion degrades gracefully — any
                // non-zero floor voted in turns it into a batch revert without this).
                //
                // NEITHER IS SILENT. Both emit WorkItemFailed, so a keeper that starts
                // refusing loans shows up in the logs as failed items rather than as an
                // absence. If WORK_PARKED_RESCUE failures climb, read the floor first.
                try this._doParkedRescueExternal(item.addr1, item.addr2, item.tierIndex) {}
                catch Error(string memory reason) {
                    bytes32 h = keccak256(bytes(reason));
                    if (h == keccak256("F8V8: already in matrix") || h == keccak256("F8V8: not parked") ||
                        h == keccak256("F8V8: still in matrix") ||
                        h == keccak256("SF: insolvency floor") ||
                        h == keccak256("SF: below floor") ||
                        h == keccak256("F8V8: insufficient withdrawable for rescue")) {
                        emit WorkItemFailed(WORK_PARKED_RESCUE, item.tierIndex, item.addr1, item.addr2);
                    } else {
                        revert(reason);
                    }
                }
                catch { emit WorkItemFailed(WORK_PARKED_RESCUE, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_EVICT_PARKED) {
                try this._doEvictParkedExternal(item.addr1, item.addr2) {}
                catch { emit WorkItemFailed(WORK_EVICT_PARKED, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_VELOCITY_GATE) {
                try this._doVelocityGateExternal(item.tierIndex) {}
                catch { emit WorkItemFailed(WORK_VELOCITY_GATE, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_FORCE_ROTATE) {
                try this._doForceRotateExternal(item.addr1) {}
                catch { emit WorkItemFailed(WORK_FORCE_ROTATE, item.tierIndex, item.addr1, item.addr2); }
            } else if (item.workType == WORK_DISTRIBUTE_CW) {
                _doDistributeCW(item.addr1);
            } else if (item.workType == WORK_ADVANCE_EPOCH) {
                try ICommunityWalletKeeper(item.addr1).advanceEpoch() {
                    emit CommunityDistributed(item.addr1);
                } catch { emit WorkItemFailed(WORK_ADVANCE_EPOCH, item.tierIndex, item.addr1, item.addr2); }
            }
        }
        if (chainLinkProcessed > 0) _flushChainLinks(chainLinkProcessed);
    }

    modifier onlySelf() {
        require(msg.sender == address(this), "MK: only self");
        _;
    }

    function _doVelocityCheckExternal()                                        external onlySelf { _doVelocityCheck(); }
    function _doGhostEntryExternal(address m, uint8 t)                        external onlySelf { _doGhostEntry(m, t); }
    function _doReclaimSlotExternal(address m, address mb, uint8 t)           external onlySelf { _doReclaimSlot(m, mb, t); }
    function _doChainLinkExternal(address a, address b, uint256 idx)          external onlySelf { _doChainLink(a, b, idx); }
    function _doParkedRescueExternal(address matrix, address member, uint8 t) external onlySelf { _doParkedRescue(matrix, member, t); }
    function _doEvictParkedExternal(address matrix, address member)           external onlySelf { _doEvictParked(matrix, member); }
    function _doVelocityGateExternal(uint8 t)                                 external onlySelf { _doVelocityGate(t); }
    function _doForceRotateExternal(address matB)                             external onlySelf { _doForceRotate(matB); }

    /// @notice V8.44 (item E): force-rotate a frozen full MatB. Re-verifies the
    ///         frozen condition at execution time (checkUpkeep→performUpkeep
    ///         race), then calls the matrix's keeperForceRotateRoot — which is
    ///         authorised by matrixKeeper address, NOT ownership, so it works
    ///         on factory-spawned matrices regardless of owner drift.
    event FrozenMatBRotated(address indexed matB);

    function _doForceRotate(address matB) internal {
        if (!MatrixKeeperLib.isFrozenMatB(matB, frozenMatBTimeout)) return;
        IFigureEightKeeper(matB).keeperForceRotateRoot();
        emit FrozenMatBRotated(matB);
    }

    function _doParkedRescue(address matrix, address member, uint8 tierIdx) internal {
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        if (!mat.isParked(member)) return;

        // Declare outputs before the scoped block so they survive into the SF-call section.
        // The block frees fee/crossingCost/effectiveContrib/sfBps/maxShortfall from the EVM
        // stack before the payForceCross call, keeping peak depth ≤ 9 (limit = 16).
        //
        // V8.50 item A added three locals to this frame (carve, crossingCost and the
        // ladder contribution). The reads are NESTED one scope deeper rather than added
        // alongside the others, so withdrawable/reserve/carve die before maxShortfall is
        // born: peak inside is 7 where V8.49's was 6. MatrixKeeperLib._triageParked has
        // the same shape for the same reason — that frame has already blown the stack once.
        uint256 sfShare;
        uint256 crossingBuffer;

        {   // ---- amount-computation block ----------------------------------------
            uint256 fee = mat.ENTRY_FEE();

            // V8.50 ITEM A: the price of THIS crossing, not the entry fee. Mirrors
            // MatrixKeeperLib._crossingCost exactly — the full reasoning lives on
            // _triageParked there and this block must not be read without it. A MatA
            // member is crossing into the pair's MatB, which their reserve pre-funded; a
            // MatB member is starting a NEW cycle at full fee. MatrixLogicLib's
            // forceCrossKeeper prices itself the same way and REQUIRES
            // sfContribution <= crossingCost, so a keeper still computing against the
            // full fee here would revert its own rescue on an A->B hop.
            uint256 crossingCost = mat.isMatrixA() ? fee * CROSSING_RESERVE_BPS / 10_000 : fee;

            uint256 effectiveContrib;
            uint256 sfBps;
            {
                uint256 withdrawable = mat.withdrawableOf(member);
                // V8.31: crossing reserve reduces SF shortfall — read it alongside withdrawable.
                uint256 reserve      = mat.crossingReserveOf(member);

                // -- Zero-balance eviction guard -----------------------------------------
                // If this member has $0 in both withdrawable AND crossingReserve, AND already
                // carries rescue debt from a prior rescue, they've proven they cannot repay
                // (likely a testnet zero-income wallet or mainnet member who never referred anyone).
                // Evict instead of piling on more unpayable debt that drains the SF indefinitely.
                //
                // V8.50 ITEM A — NOW GATED ON isMatrixA(), AND THAT GATE IS THE POINT.
                //
                // This is the SECOND DOOR to an eviction item A would otherwise open (the first
                // is the ladder, in MatrixKeeperLib._triageParked). "reserve == 0" was evidence
                // of destitution only while every seated member was guaranteed to hold one.
                // Item A makes a zero reserve the NORMAL, HEALTHY state for every member in a
                // MatB, because it was spent getting them there. A member who borrowed at
                // re-entry, was seated in a fresh MatA, crossed free into MatB and had their
                // MatA earnings taken by the clawback reads $0 / $0 / debt > 0 and is perfectly
                // mid-cycle. Under V8.48 they held a $5 carve and this line could not fire on
                // them at all.
                //
                // In a MatA the old evidence still holds — a MatA member is SUPPOSED to hold a
                // reserve, so zero means it was released (softParkIdle) and then spent — and
                // those members keep exactly the V8.48 behaviour.
                //
                // MatB members are not waved through. They fall to the ladder, the shortfall
                // and the insolvency floor below, which is the single governed arbiter of how
                // large an advance the fund will absorb. What they no longer meet is a
                // heuristic item A silently invalidated.
                if (mat.isMatrixA() && withdrawable == 0 && reserve == 0 && mat.rescueDebtOf(member) > 0) {
                    _doEvictParked(matrix, member);
                    return;
                }

                // V8.31: effective contribution = crossingReserve + withdrawable.
                // V8.50 item A: the NUMERATOR is untouched — only the price basis moved.
                // A "notional carve" credit was tried here and reverted the same hour; the
                // full reasoning is on MatrixKeeperLib._triageParked and must be read before
                // anyone adds one back. Whatever this expression is, it has to MATCH
                // discovery's exactly, or discovery queues a rescue this function refuses —
                // and that disagreement is the batch-halt shape V8.49 item 1b closed.
                effectiveContrib = reserve + withdrawable;
                sfBps = MatrixKeeperLib.rescueBpsFor(
                    sfRescueThresholds,
                    sfRescueBpsLadder,
                    effectiveContrib,
                    crossingCost
                );
            }   // withdrawable and reserve freed here
            if (sfBps == type(uint256).max) return;

            // Cap sfShare at the actual shortfall (don't advance more than needed).
            uint256 maxShortfall = crossingCost > effectiveContrib ? crossingCost - effectiveContrib : 0;
            sfShare = crossingCost * sfBps / 10_000;
            if (sfShare > maxShortfall) sfShare = maxShortfall;

            // -- Crossing buffer --------------------------------------------------
            // V8.49: crossingBufferBps is 0 by DEFAULT, so this is normally 0 and the
            // member is advanced their entry-fee shortfall and nothing more. Rationale
            // and the reversal knob are on the crossingBufferBps declaration above.
            //
            // NOTE THE CONSEQUENCE AT 0, because it is load-bearing: a SELF-FUNDED member
            // has sfShare == 0, so totalSfNeeded is 0, so the payForceCross call below is
            // skipped entirely by its own `> 0` guard. That is what makes item 12's
            // "this rescue costs the fund nothing" true — it was NOT true while the
            // buffer was unconditional, and the resulting call reached the SF's
            // insolvency floor, whose revert is not on performUpkeep's swallow-list and
            // would have reverted the WHOLE batch. See V8_49_SCOPE.md item 1b finding (ii).
            // Any future change that makes this non-zero for a self-funded member
            // re-arms that batch-halt path.
            //
            // V8.50 ITEM A: STILL THE FULL FEE, ON PURPOSE, while everything above it was
            // repriced to the crossing cost. The buffer is not a share of THIS crossing —
            // it is seed money for the member's NEXT one, and after an A->B hop that is a
            // full-fee MatA re-entry. Halving it would under-seed exactly the members item
            // A exists to carry through a whole cycle. MatrixKeeperLib._triageParked
            // computes the same term the same way when it asks the insolvency floor about
            // the advance; those two expressions must never drift apart.
            crossingBuffer = fee * crossingBufferBps / 10_000;
        }   // fee, crossingCost, effectiveContrib, sfBps, maxShortfall freed here

        uint256 totalSfNeeded = sfShare + crossingBuffer;
        uint256 sfBal         = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        // Fall back to total SF balance if tier bucket cannot fully cover the rescue cost.
        // FIX V8.31: was `sfBal > 0` — caused stall when bucket had pennies left (> 0 but < sfShare).
        uint256 sfAvail       = sfBal >= totalSfNeeded ? sfBal : IStabilityFundKeeper(stabilityFund).totalBalance();

        // If SF cannot cover both, trim the buffer rather than skip the rescue entirely
        if (sfAvail < totalSfNeeded) {
            crossingBuffer = sfAvail > sfShare ? sfAvail - sfShare : 0;
            totalSfNeeded  = sfShare + crossingBuffer;
        }
        if (sfAvail < sfShare) return;   // can't even cover the entry shortfall -- bail

        // V8.48 item 46: member travels with the funding call so the SF can enforce
        // the insolvency floor at the lender. Discovery already routes floored
        // members to eviction, so this reverting here means checkUpkeep and the SF
        // disagree — surface it, do not swallow it.
        if (totalSfNeeded > 0) IStabilityFundKeeper(stabilityFund).payForceCross(member, tierIdx, matrix, totalSfNeeded);
        mat.forceCrossKeeper(member, sfShare, crossingBuffer);
        emit ParkedRescued(matrix, member, tierIdx);
    }

    function _doEvictParked(address matrix, address member) internal {
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        if (mat.parkedAt(member) == 0) return;

        // V8.48 items 45/47: a GHOST (parked record whose holder is seated in either
        // half of the pair) BYPASSES the time gates — the matrix-level valve will
        // only dequeue the stale record for a seated member, which is harmless at
        // any age, and 41 of these were live on 2026-08-13 burning copay attempts.
        bool ghost = mat.isInMatrix(member);
        if (!ghost) {
            address partner = mat.partner();
            ghost = partner != address(0) && IFigureEightKeeper(partner).isActiveInMatrix(member);
        }
        if (!ghost) {
            // V8.46 item 1: eviction had NO time gate — anyone could evict a freshly-parked
            // member and lock them out of rescue re-entry (selfRescue/coPayRescue need parkedAt>0).
            // Require a completed rotation and a full window first, mirroring _doReclaimSlot.
            //
            // V8.49 item 1: THE WINDOW IS evictionGracePeriod NOW, was extendedIdleTimeout.
            // That was the idle-slot RECLAIM timeout, borrowed here because at the time it
            // was the nearest thing to an eviction delay — and it is what made eviction's
            // real clock 7 days while discovery ran on parkedGracePeriod's 24h. Two knobs,
            // neither named for this behaviour, governing it between them: discovery
            // queued EVICT items for six days that this line silently refused, consuming
            // slots out of maxItemsPerUpkeep against an 88-member parked queue.
            //
            // Both sides read the same value now, so they agree by construction and no
            // futile item is ever queued. THE DEFAULT IS 7 DAYS ON PURPOSE — identical to
            // what extendedIdleTimeout was already enforcing, so this reconciliation moves
            // nobody's eviction. The clock became votable; it did not become shorter.
            //
            // Do NOT re-point this at extendedIdleTimeout to "keep them in step". They are
            // different policies that happened to share a number: reclaiming an idle SEAT
            // is not evicting a PARKED member, and a DAO vote on one must not move the
            // other. That coupling is the entire defect this item exists to remove.
            if (mat.rotationCount() == 0) return;
            if (block.timestamp - mat.parkedAt(member) < evictionGracePeriod) return;
        }
        uint256 withdrawn = mat.getMemberTotalWithdrawn(member);
        mat.evictParked(member);
        emit ParkedMemberEvicted(matrix, member, withdrawn);
    }

    function _doDistributeCW(address cw) internal {
        try ICommunityWalletKeeper(cw).distribute() {
            emit CommunityDistributed(cw);
        } catch {}
    }

    function _doVelocityGate(uint8 tierIdx) internal {
        uint8 nextTier = tierIdx + 1;
        if (nextTier >= 10) return;
        if (ITierRouterKeeper(tierRouter).tierVelocityGreen(nextTier)) return;
        ITierRouterKeeper(tierRouter).setTierVelocityGreen(nextTier, true);
        emit VelocityGateOpened(nextTier);
    }

    function manualVelocityCheck() external onlyOwner { _doVelocityCheck(); }
    function manualGhostEntry(address matrix, uint8 tierIdx) external onlyOwner { _doGhostEntry(matrix, tierIdx); }
    function manualReclaimSlot(address matrix, address member, uint8 tierIdx) external onlyOwner { _doReclaimSlot(matrix, member, tierIdx); }

    function _doVelocityCheck() internal {
        uint256 windowStart = block.timestamp - velocityWindow;
        lastVelocityCheck   = block.timestamp;
        for (uint8 t = 0; t < configuredTierCount; t++) {
            uint256 cnt   = ITierRouterKeeper(tierRouter).getTierEntryCount(t, windowStart);
            bool    green = cnt >= velocityThreshold;
            if (ITierRouterKeeper(tierRouter).tierVelocityGreen(t) != green)
                ITierRouterKeeper(tierRouter).setTierVelocityGreen(t, green);
            emit VelocityUpdated(t, green, cnt);
        }
        uint256 sysCount = ITierRouterKeeper(tierRouter).getSystemEntryCount(windowStart);
        uint8   prev     = deflationState;
        if (sysCount >= deflationThreshold) {
            consecutiveRedWindows = 0;
            if (deflationState == STATE_SLOW) {
                deflationState = STATE_RECOVERY;
                consecutiveGreenWindows = 1;
            } else if (deflationState == STATE_RECOVERY) {
                consecutiveGreenWindows++;
                if (consecutiveGreenWindows >= recoveryThreshold) {
                    deflationState = STATE_NORMAL;
                    consecutiveGreenWindows = 0;
                    _setStabilityLayers(false);
                }
            }
        } else {
            consecutiveGreenWindows = 0;
            consecutiveRedWindows++;
            if (deflationState == STATE_NORMAL && consecutiveRedWindows >= 2) {
                deflationState = STATE_SLOW;
                _setStabilityLayers(true);
            }
        }
        if (deflationState != prev) {
            ITierRouterKeeper(tierRouter).setDeflationState(deflationState);
            emit DeflationStateChanged(prev, deflationState);
        }
    }

    function _setStabilityLayers(bool active) internal {
        IStabilityFundKeeper(stabilityFund).activateLayer(2, active);
        IStabilityFundKeeper(stabilityFund).activateLayer(4, active);
    }

    function _doGhostEntry(address matrix, uint8 tierIdx) internal {
        if (!ghostEntryEnabled) return;  // V8.33: ghost entries disabled by default at launch
        address pm = pairManagerForTier[tierIdx];
        if (pm == address(0)) return;
        uint256 fee   = IPairManagerKeeper(pm).entryFee();
        uint256 sfBal   = IStabilityFundKeeper(stabilityFund).balanceByTier(tierIdx);
        // Fall back to total SF balance if tier bucket cannot cover the ghost entry fee.
        // FIX V8.31: was `sfBal > 0` — same stall-on-pennies bug as rescue path.
        uint256 sfAvail = sfBal >= fee ? sfBal : IStabilityFundKeeper(stabilityFund).totalBalance();
        if (sfAvail < fee) return;
        lastGhostTime[matrix] = block.timestamp;
        IStabilityFundKeeper(stabilityFund).payGhostEntry(tierIdx, pm);
        emit GhostEntryFunded(matrix, tierIdx);
    }

    function _doReclaimSlot(address matrix, address member, uint8) internal {
        IFigureEightKeeper mat = IFigureEightKeeper(matrix);
        // Never reclaim from a matrix that hasn't completed its first rotation.
        // Members waiting for an unfilled matrix to reach 127 are not idle —
        // they're simply waiting for growth. Idle logic only applies to
        // matrices that are already cycling.
        if (mat.rotationCount() == 0) return;
        if (!mat.isInMatrix(member)) return;
        uint256 idleTime = block.timestamp - mat.lastActivityTime(member);
        if (idleTime < extendedIdleTimeout) return;
        reclaimAttemptTime[matrix][member] = block.timestamp;
        // V8.33: soft park instead of hard eviction — member goes to the rescue queue
        // and is re-entered automatically.  reclaimIdleSlot sent members to limbo with
        // no path back; softParkIdle keeps them in the system.
        mat.softParkIdle(member);
        emit SlotReclaimed(matrix, member, idleTime);
    }

    function _doChainLink(address newMatA, address newMatB, uint256 idx) internal {
        if (idx >= pendingChainLinks.length) return;
        MatrixKeeperLib.PendingChainLink memory link = pendingChainLinks[idx];
        if (link.newMatA != newMatA || link.newMatB != newMatB) return;
        emit ChainLinked(newMatA, newMatB, link.prevMatB);
    }

    function _flushChainLinks(uint256 count) internal {
        if (count >= pendingChainLinks.length) {
            delete pendingChainLinks;
        } else {
            uint256 remaining = pendingChainLinks.length - count;
            for (uint256 i = 0; i < remaining; i++)
                pendingChainLinks[i] = pendingChainLinks[count + i];
            for (uint256 i = 0; i < count; i++)
                pendingChainLinks.pop();
        }
    }

    /// @notice V8.50 — THIS DOCSTRING WAS ORPHANED, AND IT IS DELETED RATHER THAN MOVED.
    ///
    ///         It described the SF rescue ladder ("V8.20: ladder is now governable
    ///         storage… V8.31: the ladder ratio is now (crossingReserve + withdrawable) /
    ///         entryFee") and was sitting on pendingChainLinkCount(), which counts pending
    ///         chain links. V8.48 item 12a moved _rescueBpsFor out to MatrixKeeperLib and
    ///         the comment did not travel with it — it stayed behind and attached itself
    ///         to whatever function came next.
    ///
    ///         Not moved, because by V8.50 it was also WRONG: item A made both sides of
    ///         that ratio something else. The live description lives on
    ///         MatrixKeeperLib._rescueBpsFor and _triageParked, which is the only place it
    ///         can be kept honest. Recorded here rather than deleted silently so a future
    ///         session does not go looking for a comment it half-remembers.
    function pendingChainLinkCount() external view returns (uint256) {
        return pendingChainLinks.length;
    }

    function getDeflationState() external view returns (string memory) {
        if (deflationState == STATE_NORMAL)   return "NORMAL";
        if (deflationState == STATE_SLOW)     return "SLOW";
        if (deflationState == STATE_RECOVERY) return "RECOVERY";
        return "UNKNOWN";
    }
}
