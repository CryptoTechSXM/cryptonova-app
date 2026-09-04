# CryptoNova — V8.52 redeployment address table (ticket 1390129)

Prepared 2026-09-04 by the CryptoNova project. Sent unprompted, as an update to our 2026-09-01
V8.51 table. **No reply or action is requested — this is notice of a change on our side, so your
records are not stale.**

## What changed

- We redeployed the whole system on **2026-09-04** to fix a routing fault in which a full matrix
  could stop receiving entries. **Every contract address below is new.** The addresses in our
  2026-09-01 table are the previous deployment; members are being moved off them today
  (site cutover 18:00–20:00 UTC).
- **Nothing else changed.** Same network (**Base Sepolia testnet, chain id 84532**), same domains,
  same operators, same contact, same model, same answers to every question in your checklist.
- **The settlement token is unchanged and deliberately reused:** `0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a`
  is the same MockUSDC already in your record. It is a test token, not Circle USDC, with no market
  value. No mainnet asset is reachable from any contract listed here.
- Deployed 2026-09-04 09:42–11:10 UTC by `0xCd0Af6a4116f2062c1594aDf34c1821D45175506`.
- Domains in scope, unchanged and all serving the same build: `www.crypto-nova.app`,
  `crypto-nova.app`, `v8.crypto-nova.app`, `early.crypto-nova.app`, `admin.crypto-nova.app`.

## Verification was completed BEFORE any member was pointed at these contracts

Same order as our 2026-09-01 deployment, kept deliberately:

1. Contracts deployed and wired — **2026-09-04, 09:42–11:10 UTC.**
2. **All 46 contracts source-verified on BaseScan — completed before any traffic.** Two independent
   passes: a submission pass, then a separate pass that re-queried BaseScan for each address rather
   than trusting the submitter's own report. Result: **46 verified, 0 unverified, 0 unknown.**
3. Only then is the frontend repointed and members told (cutover 18:00–20:00 UTC today).

At no point is a member directed at an unverified contract in this deployment.

## Every contract, source-verified on BaseScan

| Contract | Address | Source |
|---|---|---|
| MockUSDC | `0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a` | [BaseScan](https://sepolia.basescan.org/address/0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a#code) |
| CNOVAToken | `0x3848800e1d819EE6823E211B60dA623d9eCD7cdA` | [BaseScan](https://sepolia.basescan.org/address/0x3848800e1d819EE6823E211B60dA623d9eCD7cdA#code) |
| CNOVATreasury | `0xfE21170e1128153F5209dA47a332C830D5e9dc90` | [BaseScan](https://sepolia.basescan.org/address/0xfE21170e1128153F5209dA47a332C830D5e9dc90#code) |
| StabilityFund | `0x15167d0ed6ba7D05b8703b389a15626156a8C4AC` | [BaseScan](https://sepolia.basescan.org/address/0x15167d0ed6ba7D05b8703b389a15626156a8C4AC#code) |
| CNOVABuybackReserve | `0x1b3D4bf142f1D3aD75799aD4B37922de98319AA8` | [BaseScan](https://sepolia.basescan.org/address/0x1b3D4bf142f1D3aD75799aD4B37922de98319AA8#code) |
| TierRouter | `0xBacE079aDB755Ea42b32310FE2E414CF036dd318` | [BaseScan](https://sepolia.basescan.org/address/0xBacE079aDB755Ea42b32310FE2E414CF036dd318#code) |
| MatrixFactory | `0x7Ecdf65a606f51047E31f85af6Aed1E5Ef923112` | [BaseScan](https://sepolia.basescan.org/address/0x7Ecdf65a606f51047E31f85af6Aed1E5Ef923112#code) |
| MatrixPairFactory | `0x1B19818dEe4953CFA1914eFb3375516B56c93d09` | [BaseScan](https://sepolia.basescan.org/address/0x1B19818dEe4953CFA1914eFb3375516B56c93d09#code) |
| MatrixKeeper | `0x6fEee431026d1F7F2538FcB96Da145Fe0AC6DEE2` | [BaseScan](https://sepolia.basescan.org/address/0x6fEee431026d1F7F2538FcB96Da145Fe0AC6DEE2#code) |
| V8Governance | `0xc72D5B209c0cDb120177F267FeD3651Fc6030E93` | [BaseScan](https://sepolia.basescan.org/address/0xc72D5B209c0cDb120177F267FeD3651Fc6030E93#code) |
| CommunityWallet | `0x47c3A08b72df4fbC245BA30bbdEBb7824A06F8E9` | [BaseScan](https://sepolia.basescan.org/address/0x47c3A08b72df4fbC245BA30bbdEBb7824A06F8E9#code) |
| CNOVADirectSale | `0xaeEe448e879a7661871E592F3150A180B6aB07e1` | [BaseScan](https://sepolia.basescan.org/address/0xaeEe448e879a7661871E592F3150A180B6aB07e1#code) |
| CouponRegistry | `0x2636f7594d7b59C35e49920b8e6B0d72B305089e` | [BaseScan](https://sepolia.basescan.org/address/0x2636f7594d7b59C35e49920b8e6B0d72B305089e#code) |
| MatrixLogicLib (library) | `0x79427128d4411eA56d8ee7744B0CAa6F630aA0ad` | [BaseScan](https://sepolia.basescan.org/address/0x79427128d4411eA56d8ee7744B0CAa6F630aA0ad#code) |
| TierRouterLib (library) | `0xBFc6363c19d03233ef39263399C0711384C59eB5` | [BaseScan](https://sepolia.basescan.org/address/0xBFc6363c19d03233ef39263399C0711384C59eB5#code) |
| MatrixKeeperLib (library) | `0x750F0aCE9F08fbcda271b9b2a4F828F2406868cC` | [BaseScan](https://sepolia.basescan.org/address/0x750F0aCE9F08fbcda271b9b2a4F828F2406868cC#code) |
| PairManagerV8 — tier T1 | `0xc2fCD4aFddfdf400F39d5Bf74AA5bA136d2d42c7` | [BaseScan](https://sepolia.basescan.org/address/0xc2fCD4aFddfdf400F39d5Bf74AA5bA136d2d42c7#code) |
| FigureEightMatrixV8 — T1 matrix A | `0xe1ad92CF96416BC8B92b57AA1cf8f562D3D22277` | [BaseScan](https://sepolia.basescan.org/address/0xe1ad92CF96416BC8B92b57AA1cf8f562D3D22277#code) |
| FigureEightMatrixV8 — T1 matrix B | `0x98EBe197A1C6a393315823C43187A0ccA367a332` | [BaseScan](https://sepolia.basescan.org/address/0x98EBe197A1C6a393315823C43187A0ccA367a332#code) |
| PairManagerV8 — tier T2 | `0x32a42248e17d34eE3F145359EA6fe33852b57Dd8` | [BaseScan](https://sepolia.basescan.org/address/0x32a42248e17d34eE3F145359EA6fe33852b57Dd8#code) |
| FigureEightMatrixV8 — T2 matrix A | `0x0A29212c9B2e9d7a05E8baD57EEb78E371AE4691` | [BaseScan](https://sepolia.basescan.org/address/0x0A29212c9B2e9d7a05E8baD57EEb78E371AE4691#code) |
| FigureEightMatrixV8 — T2 matrix B | `0xfFb61EF2d93Aa1D67649f10cb88b1CAFc994C365` | [BaseScan](https://sepolia.basescan.org/address/0xfFb61EF2d93Aa1D67649f10cb88b1CAFc994C365#code) |
| PairManagerV8 — tier T3 | `0x18C80793F9D9bD5b9309B28b44Dc7eeE350eaf39` | [BaseScan](https://sepolia.basescan.org/address/0x18C80793F9D9bD5b9309B28b44Dc7eeE350eaf39#code) |
| FigureEightMatrixV8 — T3 matrix A | `0xa4C0b888Db843cBE27f75eee85D7D9E8A419b2d6` | [BaseScan](https://sepolia.basescan.org/address/0xa4C0b888Db843cBE27f75eee85D7D9E8A419b2d6#code) |
| FigureEightMatrixV8 — T3 matrix B | `0xD6073D6B5808D257b291E960850344214d612ca6` | [BaseScan](https://sepolia.basescan.org/address/0xD6073D6B5808D257b291E960850344214d612ca6#code) |
| PairManagerV8 — tier T4 | `0x95F5FEAaeA0FB1e436484087eEe1Ce7997340014` | [BaseScan](https://sepolia.basescan.org/address/0x95F5FEAaeA0FB1e436484087eEe1Ce7997340014#code) |
| FigureEightMatrixV8 — T4 matrix A | `0xC00BA8b4125BE505e684AFE344f2488d34bB87F6` | [BaseScan](https://sepolia.basescan.org/address/0xC00BA8b4125BE505e684AFE344f2488d34bB87F6#code) |
| FigureEightMatrixV8 — T4 matrix B | `0x2e7689ae56698689Ea6d70Ae3526f99d7e4dA897` | [BaseScan](https://sepolia.basescan.org/address/0x2e7689ae56698689Ea6d70Ae3526f99d7e4dA897#code) |
| PairManagerV8 — tier T5 | `0x1d07B5D1569d1531b2bd050371DEd3c504eA7FeB` | [BaseScan](https://sepolia.basescan.org/address/0x1d07B5D1569d1531b2bd050371DEd3c504eA7FeB#code) |
| FigureEightMatrixV8 — T5 matrix A | `0x64675C595466e4C3E1eC6f7B8031E37Cdf13Ca70` | [BaseScan](https://sepolia.basescan.org/address/0x64675C595466e4C3E1eC6f7B8031E37Cdf13Ca70#code) |
| FigureEightMatrixV8 — T5 matrix B | `0x0FE8Ca90A2a051F058eAFA207f56E7dd0FEadC81` | [BaseScan](https://sepolia.basescan.org/address/0x0FE8Ca90A2a051F058eAFA207f56E7dd0FEadC81#code) |
| PairManagerV8 — tier T6 | `0x0075A2bf4E66762D0746697821B5553fccC82AE2` | [BaseScan](https://sepolia.basescan.org/address/0x0075A2bf4E66762D0746697821B5553fccC82AE2#code) |
| FigureEightMatrixV8 — T6 matrix A | `0x924CA04146a80a01A30323D29d7C322928E2789d` | [BaseScan](https://sepolia.basescan.org/address/0x924CA04146a80a01A30323D29d7C322928E2789d#code) |
| FigureEightMatrixV8 — T6 matrix B | `0x4E2f7b04a4b9f6b0aa7FC2c302267D95A92598f6` | [BaseScan](https://sepolia.basescan.org/address/0x4E2f7b04a4b9f6b0aa7FC2c302267D95A92598f6#code) |
| PairManagerV8 — tier T7 | `0x3d6c17797D955fD11F526fd7Df8EAD9966bAc2c1` | [BaseScan](https://sepolia.basescan.org/address/0x3d6c17797D955fD11F526fd7Df8EAD9966bAc2c1#code) |
| FigureEightMatrixV8 — T7 matrix A | `0xeF360Bdc985D910a34eCa4b9e2Fca5A9189803f4` | [BaseScan](https://sepolia.basescan.org/address/0xeF360Bdc985D910a34eCa4b9e2Fca5A9189803f4#code) |
| FigureEightMatrixV8 — T7 matrix B | `0x35F0943902A1c676C660f94f98e32F959f17FFC4` | [BaseScan](https://sepolia.basescan.org/address/0x35F0943902A1c676C660f94f98e32F959f17FFC4#code) |
| PairManagerV8 — tier T8 | `0xE1bf1D49C23652B5a7e72cd0D130EdCcbA17067E` | [BaseScan](https://sepolia.basescan.org/address/0xE1bf1D49C23652B5a7e72cd0D130EdCcbA17067E#code) |
| FigureEightMatrixV8 — T8 matrix A | `0x022716F266F47048704Ad3A8da66cc27aA7E9941` | [BaseScan](https://sepolia.basescan.org/address/0x022716F266F47048704Ad3A8da66cc27aA7E9941#code) |
| FigureEightMatrixV8 — T8 matrix B | `0x02f230F76d6290bD1226FD9FB466A90117042012` | [BaseScan](https://sepolia.basescan.org/address/0x02f230F76d6290bD1226FD9FB466A90117042012#code) |
| PairManagerV8 — tier T9 | `0x13ed4cAe6C93500F3B9a4E00EbbD95A4E7C221b5` | [BaseScan](https://sepolia.basescan.org/address/0x13ed4cAe6C93500F3B9a4E00EbbD95A4E7C221b5#code) |
| FigureEightMatrixV8 — T9 matrix A | `0xe3803c898CEE0dA03d4858c6F26b50bd615AB669` | [BaseScan](https://sepolia.basescan.org/address/0xe3803c898CEE0dA03d4858c6F26b50bd615AB669#code) |
| FigureEightMatrixV8 — T9 matrix B | `0x073dE0c9599695cAF2d847877E03a20480a1C660` | [BaseScan](https://sepolia.basescan.org/address/0x073dE0c9599695cAF2d847877E03a20480a1C660#code) |
| PairManagerV8 — tier T10 | `0xE848C624F9F48Ab3FA10C0cd45f2660E63019956` | [BaseScan](https://sepolia.basescan.org/address/0xE848C624F9F48Ab3FA10C0cd45f2660E63019956#code) |
| FigureEightMatrixV8 — T10 matrix A | `0xf38a1f75DBa473318705489c2Cb9E2976a540344` | [BaseScan](https://sepolia.basescan.org/address/0xf38a1f75DBa473318705489c2Cb9E2976a540344#code) |
| FigureEightMatrixV8 — T10 matrix B | `0x3884bB8e8DDFb2a7D08fa3A25FBE689f5262a067` | [BaseScan](https://sepolia.basescan.org/address/0x3884bB8e8DDFb2a7D08fa3A25FBE689f5262a067#code) |

**46 contracts, all with public verified source.**

One address in our deployment file, `liquidityReserve` `0x961fDE5C78200891f36858B2940a2B6d4F1Af854`, is an
externally-owned account with no bytecode. We list it here for completeness rather than omit it;
there is nothing to verify on an EOA.

## Contact

**Clive A. Caesar**, project lead, known as **CryptoTech** to the community — `cryptocounsels@gmail.com`.
We answer enquiries from regulators, security vendors and wallet providers directly and in full.
