/**
 * diagnose_cycle.js — pinpoint why handleCycleOut never increments totalSystemCycles
 *
 * Run: node scripts/diagnose_cycle.js
 *
 * ABI notes (critical — wrong types silently fail):
 *  - Fixed arrays use uint256 index: tierEntryFees(uint256), tierPairManagers(uint256), tierMatrixAAddr(uint256)
 *  - Mappings use declared key type: tierCycles(address,uint8), tierVelocityGreen(uint8), etc.
 *  - MemberOptions tuple order: (autoUpgradeDisabled, autoReentryEnabled, doubleReentryEnabled, optionsSet)
 *  - getVelocityGates() PANICS on deployed V8.8 (bool[7] but loops to MAX_TIERS=10) — NEVER call it
 */
const { ethers } = require('ethers');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const RPC_URL     = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const TIER_ROUTER = '0x16c34eE760868E54E2450d6B10c0C44B0f704856';
const T1_MATA     = '0xE23eF8d2c5d90CD8239ea729479fEdd1E9Fd3e1b';
const T1_MATB     = '0xF059Da5E6C86A7aDeA9AaEAA2Fb8f717BcCD0E4d';
const T2_MATA     = '0xb024A680FEA2bf465FB9871b25a5380f5871559b';
const W1_ADDR     = '0x6512e9B5FE1690F2570AFEE5E7b904EF106C9435';

const fmt6 = n => '$' + (Number(n) / 1e6).toFixed(4);
const ok   = v => v ? 'OK' : 'FAIL';

// Safe call wrapper — returns defaultVal instead of throwing on CALL_EXCEPTION / missing function
async function safeCall(fn, defaultVal) {
  try { return await fn(); }
  catch { return defaultVal; }
}

// ── ABI (field types must EXACTLY match deployed bytecode) ────────────────────
//   Fixed array getters: uint256 index
//   Mapping getters: declared key type (uint8 for tierVelocityGreen, etc.)
const MATA_ABI = [
  'function tierRouter()                 external view returns (address)',
  'function tierIndex()                  external view returns (uint8)',
  'function partner()                    external view returns (address)',
  'function pairManager()                external view returns (address)',
  'function ENTRY_FEE()                  external view returns (uint256)',
  'function MATRIX_SIZE()                external view returns (uint256)',
  'function occupancy()                  external view returns (uint256)',
  'function nextSlot()                   external view returns (uint256)',
  'function rotationCount()              external view returns (uint256)',
  'function getMember(address)           external view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))',
  'function isActiveInMatrix(address)    external view returns (bool)',
  'function posToMember(uint256)         external view returns (address)',
];

const TR_ABI = [
  // mappings (key type preserved)
  'function authorizedMatrices(address)  external view returns (bool)',
  'function matrixTierIndex(address)     external view returns (uint8)',
  'function tierCycles(address,uint8)    external view returns (uint256)',
  'function memberHighestTier(address)   external view returns (uint8)',
  'function memberReferrer(address)      external view returns (address)',
  'function globalJoined(address)        external view returns (bool)',
  'function tierVelocityGreen(uint8)     external view returns (bool)',
  // memberOptions: tuple field order MUST match struct: (autoUpgradeDisabled, autoReentryEnabled, doubleReentryEnabled, optionsSet)
  'function memberOptions(address)       external view returns (tuple(bool autoUpgradeDisabled, bool autoReentryEnabled, bool doubleReentryEnabled, bool optionsSet))',
  // fixed arrays (uint256 index — NOT uint8)
  'function tierEntryFees(uint256)       external view returns (uint256)',
  'function tierPairManagers(uint256)    external view returns (address)',
  'function tierMatrixAAddr(uint256)     external view returns (address)',
  // plain public vars
  'function totalSystemCycles()          external view returns (uint256)',
  'function systemPaused()               external view returns (bool)',
  'function autoUpgradeCycleThreshold()  external view returns (uint256)',
  'function reentryMinCycles()           external view returns (uint256)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, 84532, { staticNetwork: true });

  console.log('=================================================================');
  console.log('  CYCLE-OUT DIAGNOSTIC  (V8.8 / Base Sepolia)');
  console.log('=================================================================\n');

  const tr   = new ethers.Contract(TIER_ROUTER, TR_ABI, provider);
  const matA = new ethers.Contract(T1_MATA, MATA_ABI, provider);
  const matB = new ethers.Contract(T1_MATB, MATA_ABI, provider);

  // ── 1. TierRouter basics (individual safeCall so one bad fn can't kill the rest) ─
  const matbAuth   = await safeCall(() => tr.authorizedMatrices(T1_MATB), null);
  const matbTierIdx= await safeCall(() => tr.matrixTierIndex(T1_MATB),    null);
  const t1Fee      = await safeCall(() => tr.tierEntryFees(0),             null);
  const t2Fee      = await safeCall(() => tr.tierEntryFees(1),             null);
  const t1PM       = await safeCall(() => tr.tierPairManagers(0),          null);
  const t2PM       = await safeCall(() => tr.tierPairManagers(1),          null);
  const t2MatAOnChain = await safeCall(() => tr.tierMatrixAAddr(1),        null);
  // tierVelocityGreen — mapping(uint8 => bool). If deployed as fixed-array the call fails; wrap it.
  const t1Gate     = await safeCall(() => tr.tierVelocityGreen(0),         null);
  const t2Gate     = await safeCall(() => tr.tierVelocityGreen(1),         null);
  const totalCyc   = await safeCall(() => tr.totalSystemCycles(),          null);
  const w1CycT1    = await safeCall(() => tr.tierCycles(W1_ADDR, 0),       null);
  const w1Tier     = await safeCall(() => tr.memberHighestTier(W1_ADDR),   null);
  const w1Ref      = await safeCall(() => tr.memberReferrer(W1_ADDR),      null);
  const paused     = await safeCall(() => tr.systemPaused(),               null);
  const threshold  = await safeCall(() => tr.autoUpgradeCycleThreshold(),  null);
  const reentryMin = await safeCall(() => tr.reentryMinCycles(),           null);
  // memberOptions tuple order: (autoUpgradeDisabled, autoReentryEnabled, doubleReentryEnabled, optionsSet)
  const w1Opts     = await safeCall(() => tr.memberOptions(W1_ADDR), { autoUpgradeDisabled: null, autoReentryEnabled: null, optionsSet: null });
  const w1GlobalJoined = await safeCall(() => tr.globalJoined(W1_ADDR), null);

  const NA = v => v === null ? 'N/A (fn not found in deployed bytecode)' : v;

  console.log('── TierRouter ──────────────────────────────────────────────────');
  console.log('  totalSystemCycles  :', NA(totalCyc),
    totalCyc === null ? '' : (totalCyc > 0n ? '✅ WORKING' : '❌ STUCK AT 0'));
  console.log('  systemPaused       :', NA(paused), paused ? '❌ PAUSED!' : (paused === false ? '✅' : ''));
  console.log('  T1 fee             :', t1Fee === null ? 'N/A' : fmt6(t1Fee));
  console.log('  T2 fee             :', t2Fee === null ? 'N/A' : fmt6(t2Fee));
  console.log('  T1 PM              :', NA(t1PM));
  console.log('  T2 PM              :', NA(t2PM));
  console.log('  T2 MatA in TR      :', NA(t2MatAOnChain));
  console.log('  T1 gate            :', t1Gate === null ? 'N/A (tierVelocityGreen may be fixed-array — try uint256 key)' : (t1Gate ? '✅ open' : '❌ CLOSED'));
  console.log('  T2 gate            :', t2Gate === null ? 'N/A' : (t2Gate ? '✅ open' : '🔒 closed (upgrades disabled)'));
  console.log('  autoUpgCycles      :', NA(threshold));
  console.log('  reentryMinCycles   :', NA(reentryMin));

  console.log('\n  W1 info:');
  console.log('    globalJoined     :', NA(w1GlobalJoined));
  console.log('    T1-cycles        :', NA(w1CycT1));
  console.log('    highestTier      :', w1Tier === null ? 'N/A' : 'T' + w1Tier.toString());
  console.log('    referrer         :', NA(w1Ref));
  console.log('    optionsSet       :', w1Opts.optionsSet === null ? 'N/A' : w1Opts.optionsSet);
  console.log('    autoUpgDisabled  :', NA(w1Opts.autoUpgradeDisabled));
  console.log('    autoReenEnabled  :', NA(w1Opts.autoReentryEnabled));

  // ── 2. handleCycleOut require guards ────────────────────────────────────────
  const r1 = matbAuth === true;
  const r2 = matbTierIdx !== null && Number(matbTierIdx) === 0;
  console.log('\n── handleCycleOut require() guards (msg.sender = T1_MATB) ─────');
  console.log('  [1] authorizedMatrices[T1_MATB] :', matbAuth,
    r1 ? '✅' : (matbAuth === null ? 'N/A' : '❌ ROOT CAUSE: "TR: unauthorized"'));
  console.log('  [2] matrixTierIndex[T1_MATB]==0 :', matbTierIdx === null ? 'N/A' : Number(matbTierIdx),
    r2 ? '✅' : (matbTierIdx === null ? '' : `❌ ROOT CAUSE: stored=${matbTierIdx} → "TR: tier mismatch"`));
  console.log('  [3] tierIndex(0) < MAX_TIERS    : true ✅');

  // ── 3. MatB internal pointers ───────────────────────────────────────────────
  const mbTR      = await safeCall(() => matB.tierRouter(),    null);
  const mbTierIdx = await safeCall(() => matB.tierIndex(),     null);
  const mbPartner = await safeCall(() => matB.partner(),       null);
  const mbPM      = await safeCall(() => matB.pairManager(),   null);
  const mbFee     = await safeCall(() => matB.ENTRY_FEE(),     null);
  const mbSize    = await safeCall(() => matB.MATRIX_SIZE(),   null);
  const mbOcc     = await safeCall(() => matB.occupancy(),     null);
  const mbNext    = await safeCall(() => matB.nextSlot(),      null);
  const mbRots    = await safeCall(() => matB.rotationCount(), null);

  const trMatch   = mbTR && mbTR.toLowerCase() === TIER_ROUTER.toLowerCase();
  const pmMatch   = mbPM && t1PM && mbPM.toLowerCase() === t1PM.toLowerCase();
  const partMatch = mbPartner && mbPartner.toLowerCase() === T1_MATA.toLowerCase();

  console.log('\n── T1 MatB internal pointers ───────────────────────────────────');
  console.log('  tierRouter  :', NA(mbTR), trMatch ? '✅' : (mbTR ? `❌ ROOT CAUSE: MISMATCH! Expected\n              ${TIER_ROUTER}` : ''));
  console.log('  tierIndex   :', mbTierIdx === null ? 'N/A' : mbTierIdx.toString(), mbTierIdx !== null && Number(mbTierIdx) === 0 ? '✅' : '❌');
  console.log('  partner     :', NA(mbPartner), partMatch ? '✅' : (mbPartner ? '❌ MISMATCH! Expected T1_MatA' : ''));
  console.log('  pairManager :', NA(mbPM), pmMatch ? '✅' : (mbPM ? `❌ MISMATCH! Expected ${t1PM}` : ''));
  console.log('  occupancy   :', mbOcc === null ? 'N/A' : `${mbOcc}/${mbSize}`,
    mbOcc !== null && mbSize !== null && mbOcc >= mbSize ? '(FULL — next entry triggers overflow)' : '');
  console.log('  nextSlot    :', NA(mbNext));
  console.log('  rotations   :', NA(mbRots));

  // ── 4. MatA internal pointers ───────────────────────────────────────────────
  const maTR      = await safeCall(() => matA.tierRouter(),    null);
  const maTierIdx = await safeCall(() => matA.tierIndex(),     null);
  const maPartner = await safeCall(() => matA.partner(),       null);
  const maPM      = await safeCall(() => matA.pairManager(),   null);
  const maOcc     = await safeCall(() => matA.occupancy(),     null);
  const maNext    = await safeCall(() => matA.nextSlot(),      null);
  const maRots    = await safeCall(() => matA.rotationCount(), null);

  const maPMmatch   = maPM && t1PM && maPM.toLowerCase() === t1PM.toLowerCase();
  const maPartMatch = maPartner && maPartner.toLowerCase() === T1_MATB.toLowerCase();

  console.log('\n── T1 MatA internal pointers ───────────────────────────────────');
  console.log('  tierIndex   :', maTierIdx === null ? 'N/A' : maTierIdx.toString(), maTierIdx !== null && Number(maTierIdx) === 0 ? '✅' : '❌');
  console.log('  partner     :', NA(maPartner), maPartMatch ? '✅' : (maPartner ? '❌ MISMATCH! Expected T1_MatB' : ''));
  console.log('  pairManager :', NA(maPM), maPMmatch ? '✅' : (maPM ? `❌ ROOT CAUSE: MISMATCH! Expected ${t1PM}` : ''));
  console.log('  occupancy   :', maOcc === null ? 'N/A' : `${maOcc}/127`);
  console.log('  nextSlot    :', NA(maNext));
  console.log('  rotations   :', NA(maRots));

  // ── 5. CRITICAL: Who is the current T1_MatB root, and are they in T1_MatA? ──
  console.log('\n── *** CRITICAL CHECK *** Current T1_MatB root vs T1_MatA ──────');
  let rootCause5 = false;
  let currentRoot = null;
  try {
    currentRoot = await matB.posToMember(1);
    console.log('  T1_MatB pos-1 (current root) :', currentRoot);

    if (!currentRoot || currentRoot === ethers.ZeroAddress) {
      console.log('  MatB is empty or pos-1 is zero address!');
    } else {
      const rootInMatB = await safeCall(() => matB.getMember(currentRoot), null);
      const rootInMatA = await safeCall(() => matA.getMember(currentRoot), null);
      const rootTRCyc  = await safeCall(() => tr.tierCycles(currentRoot, 0), null);
      const rootGlobal = await safeCall(() => tr.globalJoined(currentRoot), null);

      if (rootInMatB) {
        console.log('\n  In T1_MatB (as root):');
        console.log('    isInMatrix     :', rootInMatB.isInMatrix, rootInMatB.isInMatrix ? '✅' : '⚠ NOT in MatB?');
        console.log('    hasEverJoined  :', rootInMatB.hasEverJoined);
        console.log('    withdrawable   :', fmt6(rootInMatB.withdrawable));
        console.log('    cyclesCompleted:', rootInMatB.cyclesCompleted.toString());
      }

      if (rootInMatA) {
        console.log('\n  In T1_MatA (re-entry destination):');
        console.log('    isInMatrix     :', rootInMatA.isInMatrix,
          rootInMatA.isInMatrix ? '❌ ROOT CAUSE CONFIRMED: "F8V8: already in matrix"' : '✅ re-entry slot is clear');
        console.log('    hasEverJoined  :', rootInMatA.hasEverJoined);
        console.log('    withdrawable   :', fmt6(rootInMatA.withdrawable));

        if (rootInMatA.isInMatrix) {
          rootCause5 = true;
          console.log('\n  !!! ROOT CAUSE CONFIRMED !!!');
          console.log('  handleCycleOut → _executeAndDouble → T1_MatA.enterFor(root)');
          console.log('  guard: require(!hasEverJoined || !isInMatrix)');
          console.log('       = require(!true || !true) = require(false)');
          console.log('  → REVERT "F8V8: already in matrix"');
          console.log('  → caught by T1_MatB._cycleOutRoot try-catch → totalSystemCycles stays 0');
          console.log('\n  HOW this happened:');
          console.log('  push_parked.js checks matB.getMember(addr).isInMatrix before rescuing.');
          console.log('  But it does NOT check if the addr is the CURRENT T1_MatB ROOT.');
          console.log('  When root was at a non-root position in MatB and also in MatA,');
          console.log('  the check passed and they were entered into MatA → dual-listing created.');
          console.log('  Now when MatB triggers handleCycleOut for this root → REVERT.');
        }
      }

      if (rootInMatB) {
        const canReenter = t1Fee !== null && rootInMatB.withdrawable >= t1Fee;
        console.log('\n  deductForUpgrade (needs', t1Fee !== null ? fmt6(t1Fee) : '?', '):');
        console.log('    withdrawable   :', fmt6(rootInMatB.withdrawable),
          t1Fee === null ? '' : (canReenter ? '✅ sufficient' : '❌ INSUFFICIENT → "F8V8: insufficient earnings"'));
      }

      console.log('\n  In TierRouter:');
      console.log('    globalJoined   :', NA(rootGlobal));
      console.log('    T1 cycles      :', NA(rootTRCyc));
    }
  } catch (e) {
    console.log('  posToMember / getMember error:', e.message);
  }

  // ── 6. W1 state ──────────────────────────────────────────────────────────────
  const w1B = await safeCall(() => matB.getMember(W1_ADDR), null);
  const w1A = await safeCall(() => matA.getMember(W1_ADDR), null);
  console.log('\n── W1 status ───────────────────────────────────────────────────');
  if (w1B) {
    console.log('  W1 in T1_MatB: isInMatrix=' + w1B.isInMatrix,
      '  withdrawable=' + fmt6(w1B.withdrawable),
      '  cycles=' + w1B.cyclesCompleted.toString());
  } else { console.log('  W1 in T1_MatB: read failed'); }
  if (w1A) {
    console.log('  W1 in T1_MatA: isInMatrix=' + w1A.isInMatrix,
      '  withdrawable=' + fmt6(w1A.withdrawable));
  } else { console.log('  W1 in T1_MatA: read failed'); }

  // ── 7. _resolveDest sim for the current root ─────────────────────────────────
  if (currentRoot && currentRoot !== ethers.ZeroAddress) {
    try {
      const rootInMatB = await safeCall(() => matB.getMember(currentRoot), null);
      const rootOpts   = await safeCall(() => tr.memberOptions(currentRoot), null);
      const rootCycles = await safeCall(() => tr.tierCycles(currentRoot, 0), null);

      if (rootInMatB && rootCycles !== null) {
        const nextCycles = rootCycles + 1n;
        const thresh     = threshold || 5n;
        const earlyPhase = nextCycles < thresh;
        const gB = !earlyPhase && rootOpts && rootOpts.optionsSet && rootOpts.autoUpgradeDisabled;
        const gE = t2Fee !== null && rootInMatB.withdrawable < t2Fee;
        const gG = t2Gate === false;

        console.log('\n── _resolveDest simulation for current MatB root ───────────────');
        console.log('  root T1-cycles (next) :', nextCycles.toString());
        console.log('  earlyPhase            :', earlyPhase, `(cycles ${nextCycles} < threshold ${thresh})`);
        console.log('  guard b (autoUpg off) :', gB, gB ? '→ re-entry' : '');
        console.log('  guard e (< T2 fee)    :', gE, t2Fee ? `(${fmt6(rootInMatB.withdrawable)} vs ${fmt6(t2Fee)})` : '');
        console.log('  guard g (T2 closed)   :', gG);
        const blocked = gB ? 'b' : gE ? 'e' : gG ? 'g' : null;
        if (blocked) {
          console.log(`  => isUpgrade = false (guard ${blocked}) → T1 re-entry`);
          const canAfford = t1Fee !== null && rootInMatB.withdrawable >= t1Fee;
          console.log('  => deductForUpgrade   :', canAfford ? '✅ OK' : '❌ INSUFFICIENT EARNINGS');
        } else if (t2Fee !== null) {
          console.log('  => isUpgrade = TRUE → T2 upgrade ($' + (Number(t2Fee)/1e6).toFixed(2) + ')');
        }
      }
    } catch(e) { console.log('  _resolveDest sim error:', e.message); }
  }

  // ── 8. T2 MatA ──────────────────────────────────────────────────────────────
  try {
    const m2 = new ethers.Contract(T2_MATA, [
      'function isActiveInMatrix(address) external view returns (bool)',
      'function occupancy()               external view returns (uint256)',
      'function getMember(address)        external view returns (tuple(uint256 id, address referrer, uint256 joinedAt, uint256 withdrawable, uint256 totalEarned, uint256 cyclesCompleted, bool isInMatrix, bool hasEverJoined))',
      'function posToMember(uint256)      external view returns (address)',
    ], provider);
    const t2Occ  = await safeCall(() => m2.occupancy(), null);
    const w1InT2 = await safeCall(() => m2.isActiveInMatrix(W1_ADDR), null);
    const w1T2   = await safeCall(() => m2.getMember(W1_ADDR), null);
    console.log('\n── T2 MatA ─────────────────────────────────────────────────────');
    console.log('  occupancy     :', t2Occ === null ? 'N/A' : `${t2Occ}/127`);
    console.log('  W1 in T2_MatA :', NA(w1InT2), w1InT2 ? '⚠ guard h would block T2 upgrade' : '✅');
    if (t2Occ !== null && t2Occ > 0n) {
      const t2pos1 = await safeCall(() => m2.posToMember(1), null);
      console.log('  T2_MatA pos-1 :', NA(t2pos1));
    }
    if (w1T2) console.log('  W1 T2 withdrawable:', fmt6(w1T2.withdrawable));
  } catch(e) { console.log('\nT2 MatA check error:', e.message); }

  // ── VERDICT ──────────────────────────────────────────────────────────────────
  console.log('\n=================================================================');
  console.log('  VERDICT');
  console.log('=================================================================');

  if (mbTR && !trMatch) {
    console.log('  ROOT CAUSE [A]: MatB.tierRouter =', mbTR);
    console.log('    handleCycleOut fires on the WRONG contract. The real TierRouter is never called.');
    console.log('\n  FIX: Add setTierRouter(address) to FigureEightMatrixV8 and redeploy T1_MatB.');
    console.log('       Or if the function already exists: call T1_MatB.setTierRouter(' + TIER_ROUTER + ')');
  } else if (!r1) {
    console.log('  ROOT CAUSE [B]: T1_MatB not in authorizedMatrices → "TR: unauthorized"');
    console.log('\n  FIX (5 seconds): tierRouter.registerMatrix(T1_MATB, 0) from deployer wallet');
  } else if (!r2) {
    console.log('  ROOT CAUSE [C]: matrixTierIndex[T1_MATB] =', matbTierIdx, '(should be 0)');
    console.log('\n  FIX: tierRouter.deregisterMatrix(T1_MATB) then tierRouter.registerMatrix(T1_MATB, 0)');
  } else if (maPM && !maPMmatch) {
    console.log('  ROOT CAUSE [D]: T1_MatA.pairManager =', maPM);
    console.log('    enterFor("F8V8: not pairManager") fails. Expected:', t1PM);
    console.log('\n  FIX: T1_MatA.setPairManager(' + t1PM + ') from owner');
  } else if (rootCause5) {
    console.log('  ROOT CAUSE [E]: Current T1_MatB root is ALSO in T1_MatA.');
    console.log('    handleCycleOut → enterFor → require(!isInMatrix) → REVERT');
    console.log('    ~6M gas consumed, caught by try-catch, totalSystemCycles stays 0.');
    console.log('\n  HOW TO FIX — choose one:');
    console.log('  Option A (instant): run fix_dual_member.js to evict root from T1_MatA.');
    console.log('    This places their MatA slot into the parked queue so another wallet');
    console.log('    fills that position, then the root is free to re-enter via handleCycleOut.');
    console.log('  Option B: run push_parked.js with a single-wallet override to push a DIFFERENT');
    console.log('    wallet into MatA at the root\'s slot, naturally displacing them.');
    console.log('\n  ALSO: add a guard in push_parked.js: never rescue a wallet that equals');
    console.log('    T1_MatB.posToMember(1) (i.e., is the current MatB root).');
    console.log('\n  Root address to fix:', currentRoot);
  } else if (totalCyc !== null && Number(totalCyc) === 0) {
    console.log('  All basic wiring checks PASSED. The cascade is failing deeper:');
    console.log('  Likely culprits (require a Tenderly trace to confirm):');
    console.log('    1. treasury.depositReserve() in _distributePayments (bare call, no try-catch)');
    console.log('       → check treasury.authorizedCallers(T1_MatA) and (T1_MatB)');
    console.log('    2. The current root has insufficient withdrawable for deductForUpgrade');
    console.log('    3. T1_MatA.pairManager mismatch (check shown above)');
    console.log('\n  Tenderly trace:');
    console.log('    https://dashboard.tenderly.co/tx/base-sepolia/<TX_HASH>');
    console.log('  BaseScan internal txs:');
    console.log('    https://sepolia.basescan.org/tx/0x946e150f...');
  } else if (totalCyc !== null && Number(totalCyc) > 0) {
    console.log('  ✅ totalSystemCycles =', totalCyc.toString(), '— cycles ARE working now!');
    console.log('  Run BATCH=20 node scripts/push_parked.js to continue rescuing parked wallets.');
  }

  console.log('\n  Quick snapshot:');
  console.log('  MatB', mbOcc + '/' + mbSize, ' MatA', maOcc + '/127',
    ' SysCycles', totalCyc !== null ? totalCyc.toString() : 'N/A',
    ' MatB-rots', mbRots !== null ? mbRots.toString() : 'N/A',
    ' MatA-rots', maRots !== null ? maRots.toString() : 'N/A');
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
