# Solana as a Swap Source — Design

**Date:** 2026-08-09
**Status:** Approved (design); implementation not started

## Purpose

Let someone holding **SOL on Solana** buy $PONSY on Robinhood Chain in one signature, alongside the existing EVM sources. This is the last unshipped row of the published *Ponsy Cross-Chain Swap* document's Initial Asset Structure.

Solana was deliberately excluded from the EVM v1 plan because it breaks four architectural assumptions at once. This spec addresses them.

## Verified against live Relay, 2026-08-09

Probed directly, not inferred:

| Fact | Value |
| --- | --- |
| Solana chain id (Relay's numbering) | `792703809` |
| SOL currency identifier | `11111111111111111111111111111111` |
| Routes to PONSY | yes — 0.16% impact on $19, 0.35% on $38 |
| `steps[0].items[0].data` keys | `instructions`, `addressLookupTableAddresses` — **no** `to`/`value`/`chainId`/`gas`/`from` |
| Instruction count | 1, programId `99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2` |
| Distinct accounts | **6, every one named explicitly** |
| Lookup tables | 1 (`Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP`) |
| `details` block | **identical in shape to EVM** |
| `requestId` + `check.endpoint` | **identical to EVM** |
| `sender` / `recipient` | base58 / `0x` — necessarily different |

Two upstream behaviours found while probing, both worth designing around:

- **Relay rejects bad prices itself.** A quote during a volatile moment came back `SWAP_IMPACT_TOO_HIGH: Swap impact is too high: -44.80%` rather than quoting it. The widget must render that as a "try a smaller amount / try again shortly" state, not a generic failure.
- **SPL-token origins do not route.** Solana USDC returns `NO_SWAP_ROUTES_FOUND` to every destination, not just PONSY. **Native SOL only.**

## The two-wallet model

Paying from Solana and receiving on an EVM chain are irreducibly two different addresses. A Solana keypair has no corresponding EVM address, so nothing can be derived.

- **MetaMask stays as it is** and becomes the **recipient**. It is already connected for every other source chain.
- **Phantom/Solflare connects as the payer**, only when Solana is selected.

No destination address is ever typed. That is the point: a mistyped Robinhood Chain address sends PONSY somewhere unrecoverable, and nothing downstream can validate it beyond a checksum.

## Architecture

```
POST /quote  chainId=792703809, user=<base58 payer>, recipient=<0x… receiver>
   |
   |  backend: originCurrency = SOL mint; destination stays fixed to PONSY,
   |           never client-supplied, exactly as today
   v
Relay -> instructions[] (6 explicit accounts)
   |
   |  backend: build a LEGACY transaction, attach a fresh blockhash, base64
   v
{ ...identical details/rate/impact/minReceived as EVM...,
  solanaTx: { base64, lastValidBlockHeight }, requestId }
   |
   v
frontend: deserialize -> window.solana.signAndSendTransaction -> poll requestId
```

**Most of the system does not change.** Because Relay's `details` block is shape-identical, quote rendering, the `$25` minimum, the high-impact warning, the `spent`/`unresolved` guards and the entire status-polling loop work untouched. Only the signing step branches.

### Backend — `d:\projects\ponsy`

| File | Change |
| --- | --- |
| `src/quote.js` | Accept a `recipient` parameter (validated `0x`, defaulting to `user` so EVM behaviour is unchanged); validate a Solana `user` as base58 rather than `0x`; select `originCurrency` by VM |
| `src/chain/solana.js` | **New.** Build the legacy transaction from Relay's instruction; fetch and briefly cache a blockhash |
| `src/config.js` | `SOLANA_RPC_URL`; add `792703809` to the allowlist |
| `src/server.js` | No change — `/quote` already forwards query parameters |

The response carries `solanaTx` **instead of** `tx`, never both. A consumer must branch on which is present; that is deliberate, so a frontend that has not been updated fails loudly rather than signing something meaningless.

### Frontend — `D:\projects\Meme4`

| File | Change |
| --- | --- |
| `src/lib/swap.js` | Solana entry in `SOURCE_CHAINS` with a `vm: 'svm'` marker and `native: 'SOL'`; Solscan in the explorer map |
| `src/hooks/useSolanaWallet.js` | **New.** Connect `window.solana` / `window.solflare`, mirroring the existing raw-`window.ethereum` pattern |
| `src/hooks/useSwapExecute.js` | Branch on `quote.solanaTx` vs `quote.tx`. The EVM path is untouched |
| `src/components/SwapWidget.jsx` | Second connect button, shown only when Solana is selected |

Wallet access uses the **raw injected provider**, matching the EVM side's deliberate avoidance of wallet libraries. Phantom and Solflare cover the large majority of Solana users.

## The dependency departure

The backend rule has been **no npm dependencies**. This spec breaks it, and the reasoning deserves to be explicit rather than assumed.

That rule was justified by a specific argument: every EVM call took zero arguments, so calldata was a constant 4-byte selector and decoding was fixed-width hex slicing — about 40 lines of BigInt against a multi-megabyte library that would not have done the Uniswap math anyway.

**That argument does not transfer.** A Solana transaction is a message header, a compact-u16 account array, per-instruction account-index encoding, a blockhash, and base64 — roughly 150 lines of exact binary work in which a single off-by-one produces a malformed transaction over real funds. Hand-rolling it would be the opposite trade to the one that justified the original rule.

So: **`@solana/web3.js` on the backend.**

**The frontend half is unresolved and must be settled during implementation, not assumed.** The reliable path is `@solana/web3.js` for deserialization. Phantom may accept a pre-serialized message via `request({ method: 'signAndSendTransaction' })`, which would avoid a frontend dependency entirely — but that is unverified, and the implementation task must check it against a real wallet before choosing. Do not add the dependency without first establishing it is needed; do not skip it on the assumption that it is not.

## Two accepted risks

**Legacy transaction instead of v0.** Relay returns a v0 shape with one lookup table, but all six accounts are named explicitly, so a legacy transaction carries the same instruction and is functionally identical on-chain. This is a deliberate simplification that removes an RPC round trip per quote. It is **reasoned, not yet proven on-chain** — the first real Solana swap is what confirms it. If Relay's solver turns out to care about the transaction format, the fallback is fetching the lookup-table accounts and building v0, which is a change contained entirely within `src/chain/solana.js`.

**Blockhash expiry.** A Solana blockhash is valid roughly 60–90 seconds. The widget re-quotes every 20s, so it should never go stale in normal use. But unlike a stale EVM quote, which is merely mispriced, a stale blockhash makes the transaction **unsubmittable**. The backend returns `lastValidBlockHeight` so the UI can say precisely that, rather than surfacing an opaque wallet error. Blockhash fetches are cached briefly and shared across users, so a public Solana RPC is sufficient — this is one cheap call, not per-user RPC load.

## Failure handling

Everything the EVM path already does, plus:

- **`SWAP_IMPACT_TOO_HIGH`** — Relay's own guard. Render as "the price moved too far for this size, try a smaller amount or try again shortly", not as a generic failure. This is a healthy refusal, not a bug.
- **No Solana wallet installed** — the same shape as the existing "No wallet found" for MetaMask.
- **Payer connected but recipient not** — refuse to quote, and say which one is missing. Never guess a destination.
- **Wallet rejection** — Phantom's user-rejection maps to the same silent return-to-idle that EVM code `4001` gets.
- **Stale blockhash** — a specific message naming expiry, with a re-quote as the remedy.

## Testing

**Backend:** the transaction builder is pure and fully unit-testable against the captured instruction — account ordering, signer/writable flags, the blockhash slot, base64 round-tripping. Plus: base58 accepted for a Solana `user` and rejected for an EVM one, `recipient` required when the origin is Solana, `originCurrency` selected by VM, and an SPL-token origin refused before it reaches Relay.

**Frontend:** the branch selection (`solanaTx` vs `tx`) is testable without a DOM. The wallet interaction is not — as with the EVM path, the real gate is a live swap.

**The real gate:** one actual SOL → PONSY swap. Nothing in this spec is proven until that lands, and the legacy-transaction assumption in particular is only confirmed by it.

## Out of scope

- **SPL tokens as the source** (Solana USDC, USDT) — Relay returns `NO_SWAP_ROUTES_FOUND` for SPL origins to every destination. Not a limitation of this design; the route does not exist.
- **Selling PONSY back to SOL** — the reverse direction quotes, but needs an ERC-20 approval on Robinhood Chain first, which the execution hook does not implement for any chain.
- **Solana as a destination** — receiving PONSY on Solana is not a thing; PONSY is an ERC-20.
- **Additional EVM networks** (Polygon, Avalanche, Unichain, Sonic, Abstract) — all verified working and cheap to add, excluded from both this and the BNB spec to keep the dropdown short.
