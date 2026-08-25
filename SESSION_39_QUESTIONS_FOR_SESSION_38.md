# QUESTIONS FROM SESSION 39 TO SESSION 38 — V8.50 COMMUNITY DEPLOY vs PHASE G

Paste this into the still-open session 38. Session 39 opened on the 38 handoff, verified the
repo state, and hit one contradiction it cannot resolve from disk.

**Answer from your own record, not from reconstruction.** If something was never established
in your session, say **NOT ESTABLISHED** — do not derive it now. A reconstructed answer is
exactly the failure 38.3 earned its rule about. Where an answer exists, name the section,
commit, script or log line it comes from.

---

## THE CONTRADICTION

`V8_50_HANDOFF.md` 38.4 item 3 says: *"THE COMMUNITY DEPLOY. Nothing above blocks it."*
36.6 says: *"THE GOAL IS THE COMMUNITY DEPLOY OF V8.50."* The owner has confirmed
(2026-08-25) that it is indeed **V8.50**, not opening the live V8.48 app to members.

But `GO_LIVE_RUNBOOK.md` puts **PHASE G — the private gate** immediately before **PHASE 2 —
Community announcement**, and the PHASE G ledger records **G.5, G.7 and G.8 as never run**,
with **G.4 needing its pass criterion rewritten before it can be re-run**.

**PHASE G is not mentioned anywhere in `V8_50_HANDOFF.md` after session 34** (last mention,
line 1534). Sessions 35, 36, 37 and 38 dropped it. Session 39 found no run artifact for
`model_item_a.js` or `audit_frontend_abi.js` anywhere in `logs/`.

---

## THE QUESTIONS

**1. WHICH CHAIN DOES THE COMMUNITY DEPLOY GO TO — Base mainnet, or the testnet the members
are on now?**
Sessions 36-38 never name it. 38.2 fixed a mainnet-vs-testnet deploy default and speaks of
"a mainnet deploy" as a live risk, and `C:\CryptoNova-Mainnet-App` exists. Everything else in
36-38 is testnet-app work. The answer changes every prerequisite below it.

**2. WHEN 36.6 WROTE "NOTHING BLOCKS THE COMMUNITY DEPLOY", WAS PHASE G CONSIDERED?**
Three possibilities and they are not the same: (a) PHASE G was judged passed — on what
evidence; (b) PHASE G was deliberately waived or narrowed — on whose call and recorded where;
(c) PHASE G was simply not in context. If (c), say so plainly. That is the useful answer, not
the embarrassing one.

**3. G.5, G.7 AND G.8 — IS THERE A RECORD OF ANY OF THEM RUNNING, UNDER ANY NAME?**
G.5 = measurement 3, `scripts/model_item_a.js` on the private chain, PASS at or near the
67-of-67 self-funded projection. G.7 = re-confirm PARAM 59 and the rescue-ladder rung on a
running system. G.8 = `scripts/audit_frontend_abi.js`, run BEFORE the addresses change.
If none ran: is the intent still to run all three, or has the gate been narrowed since
session 33 built that ledger?

**4. G.4 — WAS A REPLACEMENT PASS CRITERION EVER DRAFTED?**
Measurement 2's PASS was *"`BatchGasHalted` fires, `processed < total`, `gasRemaining` just
under 5,000,000"*. After 31.4's fix — `minGasPerItem` 5M → **7.5M**, `maxItemsPerUpkeep` →
**1**, driver budget → **16.5M** — there is no in-batch halt left to observe. Was a new
criterion written down anywhere, or is that still open?

**5. IS THE PRIVATE V8.50 CHAIN STILL UP?**
G.5 and G.7 both need a running system. Is the droplet chain still live and reachable, and is
`scripts/deployed_addresses_v8_50_private.json` (md5 `9031510611821cdd129d8ab480e15633`)
still the current pair on both ends? If it was torn down, say when.

**6. WHAT HAPPENS TO THE 393 PARKED V8.48 POSITIONS ON MIGRATION DAY?**
V8.50 has no proxy machinery — migration means every member re-registers on new addresses.
38.5 measured **295 members holding the money and needing only an approval**, plus **3
genuinely stuck**. Does parked state carry across, or does the migration wipe it?
And: the community post that went out on 2026-08-24 tells those members how to self-rescue on
V8.48. **If a migration is imminent, does that post need a follow-up?** Session 39 will not
draft one without your answer.

**7. `insolvencyFloorBps` — WHICH VALUE SHIPS ON THE COMMUNITY DEPLOY, 3400 OR 5000?**
Live V8.48 runs **3400**; the private V8.50 deploy came up at **5000**. 6d records the owner
decision as *"PARAM 59 STAYS AT 3400"*. Was that decision made about the **live V8.48 chain**,
or about **what V8.50 ships with**? What does `deploy_v8.js` actually set today? This is the
same two-copies-of-one-fact shape 38.2 just caught on the loan clock, on a parameter that
decides who can borrow.

**8. THE `directCount` SPONSORSHIP GATE — STILL INERT?**
Confirm it still ships at `baseAdvanceBps` **10000** (inert) and is armed only at
**PHASE 7b, after migration and after the referral tree rebuilds**, via
`scripts/set_base_advance.js` with `ARM=1` — and that nothing in sessions 35-38 armed it,
scheduled it, or moved it earlier.

**9. WHAT DID "THE COMMUNITY DEPLOY" MEAN AS A CHECKLIST WHEN YOU WROTE 38.4 ITEM 3?**
The runbook's PHASE 1 is the contract deploy; PHASE 2 is the announcement; PHASE 3-6 are the
frontend re-point, owner human test, keepers re-pointed, go live. Which of those did you have
in mind as the next action, and what did you expect the owner to run first?

---

## WHAT SESSION 39 ALREADY VERIFIED — DO NOT RE-DO IT

* Contracts `v8.1` == `origin/v8.1` == **`5e76c0e`**. Working tree carries three files that
  show modified and are **zero real changed lines** under `--ignore-cr-at-eol`:
  `archive/windows_keeper/corescue.bat`, `contracts/test/CryptoNovaCommunityWallet.sol`,
  and `scripts/diag_wallet_charges.js`. The `.gitattributes` phantom. Nothing uncommitted.
* Testnet app `admin` == `preview` == `main` == **`6779fbf`**, local tree clean.
* `fund_list.txt` divergence confirmed: **110** addresses in the app copy, **100** in the
  Keepers copy.
* ⚠ **TWO CORRECTIONS TO 38.5.** (a) `CryptoNova-Keepers/fund_list.txt` **must not be
  deleted** — `CryptoNova-Keepers/fund_testers.js` reads it. It needs repointing at the
  canonical file. (b) 38.5 says `scripts/fund_leaders_30k.js` line 14 "documents the stale
  one". It does not — that block is a **history note** listing the three lists that had
  diverged in 36.4, and the code at line 56 defaults correctly to the app copy. No fix needed
  there.
