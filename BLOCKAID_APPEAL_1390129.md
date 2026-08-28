# CryptoNova — technical overview for Blockaid (ticket 1390129)

Prepared 2026-08-28 by the CryptoNova project, in reply to Peter's request of 2026-08-27 for documentation demonstrating the nature of the dApp.

## 1. What this deployment is

- **Network: Base Sepolia testnet (chain id 84532).** There is no mainnet deployment of this system.
- **The settlement token is a mock.** `MockUSDC` at `0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a` is a test token minted for the testnet; it is not Circle USDC and has no market value. No mainnet asset is reachable from any contract listed here.
- Deployed 2026-08-26T05:13:48.565Z by `0xCd0Af6a4116f2062c1594aDf34c1821D45175506`.
- CryptoNova is a matrix/referral community platform. A member pays a $10 test-USDC entry fee, is placed in a referral structure, and earns test USDC from that structure. We state the model plainly rather than describe it in softer terms.
- The domains in scope, all serving the same build and the same contracts: `www.crypto-nova.app`, `crypto-nova.app`, `v8.crypto-nova.app`, `early.crypto-nova.app`, `admin.crypto-nova.app`.

## 2. Every contract, source-verified on BaseScan

All **46** contracts of this deployment have public verified source. Verification was completed **2026-08-27** — after the flag was raised, which we believe is the likely trigger for it (see section 4). Re-checked on the date of this document by querying BaseScan for each address.

| Contract | Address | Source |
|---|---|---|
| MockUSDC | `0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a` | [BaseScan](https://sepolia.basescan.org/address/0x2D8B7b5eDec96bE441b6fb0D45D74a2BcE2C639a#code) |
| CNOVAToken | `0x98cCEb35f3C1624258073e6e66aBa1AE2be2F55a` | [BaseScan](https://sepolia.basescan.org/address/0x98cCEb35f3C1624258073e6e66aBa1AE2be2F55a#code) |
| CNOVATreasury | `0xc1ED39a0FaAd9A6B291A2f3b6CBF165D2027a8D4` | [BaseScan](https://sepolia.basescan.org/address/0xc1ED39a0FaAd9A6B291A2f3b6CBF165D2027a8D4#code) |
| StabilityFund | `0xCc6E704814B04bD492AA99e86fCa24e3cA938136` | [BaseScan](https://sepolia.basescan.org/address/0xCc6E704814B04bD492AA99e86fCa24e3cA938136#code) |
| CNOVABuybackReserve | `0xb19197a0BE1bf44098457fa4C5F836264cd95350` | [BaseScan](https://sepolia.basescan.org/address/0xb19197a0BE1bf44098457fa4C5F836264cd95350#code) |
| TierRouter | `0x0001660fF100a73134a86Ca1C8cf83977428dca4` | [BaseScan](https://sepolia.basescan.org/address/0x0001660fF100a73134a86Ca1C8cf83977428dca4#code) |
| MatrixFactory | `0xf9A1A72D2b6e2Cb7387989bA0C2D83Af869D28C3` | [BaseScan](https://sepolia.basescan.org/address/0xf9A1A72D2b6e2Cb7387989bA0C2D83Af869D28C3#code) |
| MatrixPairFactory | `0x624fA891C0b5708087dD40cCF7795f283Fc8BBDe` | [BaseScan](https://sepolia.basescan.org/address/0x624fA891C0b5708087dD40cCF7795f283Fc8BBDe#code) |
| MatrixKeeper | `0xA04aD8Dab09a9a742E0A845FB0c1e1107a86405F` | [BaseScan](https://sepolia.basescan.org/address/0xA04aD8Dab09a9a742E0A845FB0c1e1107a86405F#code) |
| V8Governance | `0x78DC530Ab3D63FC300e14381e27B6eACeD090951` | [BaseScan](https://sepolia.basescan.org/address/0x78DC530Ab3D63FC300e14381e27B6eACeD090951#code) |
| CommunityWallet | `0x591d9AB64a56eCe4A1DB9a6767b11C48ed0Ff532` | [BaseScan](https://sepolia.basescan.org/address/0x591d9AB64a56eCe4A1DB9a6767b11C48ed0Ff532#code) |
| CNOVADirectSale | `0x5C12B34b9Ce1eea4CbBE6000a4bb52cD2CaF5c50` | [BaseScan](https://sepolia.basescan.org/address/0x5C12B34b9Ce1eea4CbBE6000a4bb52cD2CaF5c50#code) |
| CouponRegistry | `0x21063617Bd76B30c884EC3554186096300FBe9C1` | [BaseScan](https://sepolia.basescan.org/address/0x21063617Bd76B30c884EC3554186096300FBe9C1#code) |
| MatrixLogicLib (library) | `0x7269E4b3D53D5F5Ca053FcEfc60F32E92036e9e8` | [BaseScan](https://sepolia.basescan.org/address/0x7269E4b3D53D5F5Ca053FcEfc60F32E92036e9e8#code) |
| TierRouterLib (library) | `0x6F3a4f290cf2B061B0c74749D6F15A5b3EF76791` | [BaseScan](https://sepolia.basescan.org/address/0x6F3a4f290cf2B061B0c74749D6F15A5b3EF76791#code) |
| MatrixKeeperLib (library) | `0xC640ac48282e5099fEcA710c059205D5ea089F3d` | [BaseScan](https://sepolia.basescan.org/address/0xC640ac48282e5099fEcA710c059205D5ea089F3d#code) |
| PairManagerV8 — tier T1 | `0x6BEbf2e8ef90fBBf0a0e5f4bb5EF9976b8ceDE2c` | [BaseScan](https://sepolia.basescan.org/address/0x6BEbf2e8ef90fBBf0a0e5f4bb5EF9976b8ceDE2c#code) |
| FigureEightMatrixV8 — T1 matrix A | `0x387DD94755F04aC16339882E4639604F755586af` | [BaseScan](https://sepolia.basescan.org/address/0x387DD94755F04aC16339882E4639604F755586af#code) |
| FigureEightMatrixV8 — T1 matrix B | `0xb1f621C11a05cc55973018131f942535bF66637E` | [BaseScan](https://sepolia.basescan.org/address/0xb1f621C11a05cc55973018131f942535bF66637E#code) |
| PairManagerV8 — tier T2 | `0xf57B6744a694040683A3E22c507e0144d9F696c6` | [BaseScan](https://sepolia.basescan.org/address/0xf57B6744a694040683A3E22c507e0144d9F696c6#code) |
| FigureEightMatrixV8 — T2 matrix A | `0x37A99CEB55507ecEeE140EAcD85fae29D3644a49` | [BaseScan](https://sepolia.basescan.org/address/0x37A99CEB55507ecEeE140EAcD85fae29D3644a49#code) |
| FigureEightMatrixV8 — T2 matrix B | `0x72e675B747c7317dC20B9E9269765Fee79647Ee2` | [BaseScan](https://sepolia.basescan.org/address/0x72e675B747c7317dC20B9E9269765Fee79647Ee2#code) |
| PairManagerV8 — tier T3 | `0xfca8FDee375c44A2c995D5a111680587b3705631` | [BaseScan](https://sepolia.basescan.org/address/0xfca8FDee375c44A2c995D5a111680587b3705631#code) |
| FigureEightMatrixV8 — T3 matrix A | `0xb8DdF0Bf85D0798946fe9b1E44D426AF72B462a7` | [BaseScan](https://sepolia.basescan.org/address/0xb8DdF0Bf85D0798946fe9b1E44D426AF72B462a7#code) |
| FigureEightMatrixV8 — T3 matrix B | `0x86d08b22A2e8Ee8EdcB7D172237635c14DbFE531` | [BaseScan](https://sepolia.basescan.org/address/0x86d08b22A2e8Ee8EdcB7D172237635c14DbFE531#code) |
| PairManagerV8 — tier T4 | `0x32B7354B4460145eC7ae32B1D376E69E157A7597` | [BaseScan](https://sepolia.basescan.org/address/0x32B7354B4460145eC7ae32B1D376E69E157A7597#code) |
| FigureEightMatrixV8 — T4 matrix A | `0x49f0ee6cE87065BFA798F18cB7E8f154F8AdC031` | [BaseScan](https://sepolia.basescan.org/address/0x49f0ee6cE87065BFA798F18cB7E8f154F8AdC031#code) |
| FigureEightMatrixV8 — T4 matrix B | `0xb212F2445b79dC260b4E97DB07Fa00366876fed2` | [BaseScan](https://sepolia.basescan.org/address/0xb212F2445b79dC260b4E97DB07Fa00366876fed2#code) |
| PairManagerV8 — tier T5 | `0x67b32Ce4560b87aF387FDa333823Cc4B6c1789Da` | [BaseScan](https://sepolia.basescan.org/address/0x67b32Ce4560b87aF387FDa333823Cc4B6c1789Da#code) |
| FigureEightMatrixV8 — T5 matrix A | `0x092Aea0D4C40205F9Bbf33f3D0b467cC1361C825` | [BaseScan](https://sepolia.basescan.org/address/0x092Aea0D4C40205F9Bbf33f3D0b467cC1361C825#code) |
| FigureEightMatrixV8 — T5 matrix B | `0x5d0D411eEE38030Fd7a68BFcCd731A6B3d228368` | [BaseScan](https://sepolia.basescan.org/address/0x5d0D411eEE38030Fd7a68BFcCd731A6B3d228368#code) |
| PairManagerV8 — tier T6 | `0x89BE85CedF44c1963B9C75Bb9d9863240D71b078` | [BaseScan](https://sepolia.basescan.org/address/0x89BE85CedF44c1963B9C75Bb9d9863240D71b078#code) |
| FigureEightMatrixV8 — T6 matrix A | `0xb4E35365F0929b5BB390caf52533a8bFE5cA743E` | [BaseScan](https://sepolia.basescan.org/address/0xb4E35365F0929b5BB390caf52533a8bFE5cA743E#code) |
| FigureEightMatrixV8 — T6 matrix B | `0x3A62286973CD07b0D4D7Eb80f3D2BD20824416ab` | [BaseScan](https://sepolia.basescan.org/address/0x3A62286973CD07b0D4D7Eb80f3D2BD20824416ab#code) |
| PairManagerV8 — tier T7 | `0x9509D95296783b0DaB1854f431F89c5BBb72f810` | [BaseScan](https://sepolia.basescan.org/address/0x9509D95296783b0DaB1854f431F89c5BBb72f810#code) |
| FigureEightMatrixV8 — T7 matrix A | `0x533B547fa585f2dEEBf34D675751Ee974D1184B3` | [BaseScan](https://sepolia.basescan.org/address/0x533B547fa585f2dEEBf34D675751Ee974D1184B3#code) |
| FigureEightMatrixV8 — T7 matrix B | `0x9518FF53b1Bbc13ad7ce516A6a015692f28dfb8a` | [BaseScan](https://sepolia.basescan.org/address/0x9518FF53b1Bbc13ad7ce516A6a015692f28dfb8a#code) |
| PairManagerV8 — tier T8 | `0x7B4d72659Eb7e881E1BB13a80347Db040b62f0fb` | [BaseScan](https://sepolia.basescan.org/address/0x7B4d72659Eb7e881E1BB13a80347Db040b62f0fb#code) |
| FigureEightMatrixV8 — T8 matrix A | `0x7Cbe7CFE2e982a0Ad1188b9ce40cE5f6a1CE6b61` | [BaseScan](https://sepolia.basescan.org/address/0x7Cbe7CFE2e982a0Ad1188b9ce40cE5f6a1CE6b61#code) |
| FigureEightMatrixV8 — T8 matrix B | `0x2dEeE6F0D80922EB131b985b8763a36c70A96f0D` | [BaseScan](https://sepolia.basescan.org/address/0x2dEeE6F0D80922EB131b985b8763a36c70A96f0D#code) |
| PairManagerV8 — tier T9 | `0x220A3446345563Bf4C7c9811E83dcdBecC8d8493` | [BaseScan](https://sepolia.basescan.org/address/0x220A3446345563Bf4C7c9811E83dcdBecC8d8493#code) |
| FigureEightMatrixV8 — T9 matrix A | `0x23De6A78f0a703C662c31DceaACC52E371A29d76` | [BaseScan](https://sepolia.basescan.org/address/0x23De6A78f0a703C662c31DceaACC52E371A29d76#code) |
| FigureEightMatrixV8 — T9 matrix B | `0xDBC1B185670e096948f8ba4a4EAcb08A64C92c6D` | [BaseScan](https://sepolia.basescan.org/address/0xDBC1B185670e096948f8ba4a4EAcb08A64C92c6D#code) |
| PairManagerV8 — tier T10 | `0x03f3E91De443d1726B4eaDfD439b0baE2F73e6BD` | [BaseScan](https://sepolia.basescan.org/address/0x03f3E91De443d1726B4eaDfD439b0baE2F73e6BD#code) |
| FigureEightMatrixV8 — T10 matrix A | `0x3F2Accd8C10D985df94a6167e5a2b27e1e249277` | [BaseScan](https://sepolia.basescan.org/address/0x3F2Accd8C10D985df94a6167e5a2b27e1e249277#code) |
| FigureEightMatrixV8 — T10 matrix B | `0x3bd9115Ae9a2Aa4d03Fbd7E2b509A65dDC96EbE1` | [BaseScan](https://sepolia.basescan.org/address/0x3bd9115Ae9a2Aa4d03Fbd7E2b509A65dDC96EbE1#code) |

One further address appears in our deployment record and is **not a contract**: `0x961fDE5C78200891f36858B2940a2B6d4F1Af854` is a plain externally-owned wallet used as a payout destination (`eth_getCode` returns `0x`). We list it here for completeness rather than leave an unexplained address in our records.

## 3. What the site asks a wallet to do

This is the part most relevant to a drainer heuristic, so we are being exact.

**The site never requests an unlimited token allowance.** There is no `MaxUint256`, no `2**256-1`, and no equivalent unlimited-approval constant anywhere in the site source. Every `approve()` call passes an exact amount computed for the specific action the member just chose. This is checkable in the page source served from the domain.

The approvals a member can be asked for, all to contracts in the table above:

| Spender | Token | When | Amount |
|---|---|---|---|
| TierRouter | MockUSDC | Registration, and tier upgrades | Exactly the entry/upgrade fee due, plus any outstanding advance being repaid |
| CouponRegistry | MockUSDC | Sponsoring another member's entry (Pay It Forward) | Exactly the $10 coupon value |
| CNOVATreasury | MockUSDC | CNOVA redemption | Exactly the amount being redeemed |
| Matrix contracts | MockUSDC | Member-initiated self-rescue / co-pay of an advance | Exactly the amount being paid |
| CNOVADirectSale | MockUSDC | Direct CNOVA purchase | Exactly the purchase amount |
| V8Governance | CNOVA | Submitting a governance proposal | Exactly the proposal fee |

The last two pages (direct sale, governance) and the liquidity page are currently behind a "Coming Soon" gate on the public domains, so a member on `www.crypto-nova.app` today is only ever asked for the first four.

⛔ **A correction to our own report.** Our submission of 2026-08-28 00:04 UTC said *"The site requests one token approval: USDC spending for TierRouter... That is the only token permission the site ever asks for."* That was written in good faith but it is not accurate, as the table above shows. We would rather correct it ourselves than have you find it. The substance we should have written is the row that actually matters: **every approval is for an exact amount, to one of our own verified contracts, and none is unlimited.**

## 4. Why we think the flag was raised

The V8.50 contracts were deployed 2026-08-26 and the site went to the community the same week. The contracts were **not** verified on BaseScan at that point — verification was completed 2026-08-27. For roughly a day, a freshly-deployed domain was asking visitors to approve token spending to an **unverified** contract, which is the textbook shape of a drainer and, we assume, what the scan reacted to. That specific condition no longer holds: every contract is verified and readable.

We had the identical experience on 2026-07-30 with an earlier deployment, for the same reason, which is why we recognise the pattern.

## 6. Where this comes from

We have been building CryptoNova for the better part of three years, and for the past few months it has been on Base Sepolia in open testing with our community.
Members register, report defects through a bug-report form on the site, and are
credited and paid bounties for what they find; that feedback has shaped the build,
including a number of the corrections recorded in `PARITY_AUDIT.md`. The testnet phase
exists precisely so that the people who will use this find its faults first.

Parameter changes are governed on chain rather than by us alone. `V8Governance`
(`0x78DC530Ab3D63FC300e14381e27B6eACeD090951`, verified) lets any CNOVA holder open a
proposal and vote on it, with voting weight equal to their CNOVA balance
(`castVote`, V8Governance.sol:766-785), and members accrue CNOVA by participating.

To be exact rather than flattering: the governance and direct-sale pages are still
behind a "Coming Soon" gate on the public domains while we complete the testnet phase,
so that surface is deployed and verified but not yet open to members.

## 7. Supporting documents

⛔ **We have not had a third-party security audit, and we are not claiming one.** The documents below are our own internal review notes. We are describing them as exactly what they are.

- **`PARITY_AUDIT.md`** — our internal claim-to-source audit. Every member-facing statement on the site is listed with the contract function or constant that backs it, under a project rule that a claim without a named source does not ship. Where the site was wrong, the row records the correction. We think this is the most useful document we have for your purpose: it shows the site is held to the contracts.
- **`PIF_CONCEPT.md`** — the design of the Pay It Forward sponsorship feature, which is the part of the site that issues coupons via CouponRegistry.

We are happy to answer specific questions about any contract or transaction path, or to walk through a registration in full.
