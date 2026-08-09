# BNB Chain as a Swap Source — Design

**Date:** 2026-08-09
**Status:** Approved

## Purpose

Let a visitor pay with **BNB on BNB Chain** to buy $PONSY on Robinhood Chain, alongside the existing ETH sources. This closes the gap between the shipped widget and the published *Ponsy Cross-Chain Swap* document, whose Initial Asset Structure names SOL, BNB, ETH and USDC.

Solana is deliberately **not** in this spec — it breaks four architectural assumptions and gets its own design. USDC and other ERC-20 sources are also out: they need an approval step before the deposit, which the execution hook does not implement.

## Verified before designing

Live probe against `api.relay.link`, 2026-08-09 — twelve candidate networks quoted against PONSY:

| Network | Chain id | Result |
| --- | --- | --- |
| **BNB Chain** | **56** | **works — −1.26% impact, 2s, single `deposit` step** |
| Base / Ethereum / Arbitrum / Optimism | 8453 / 1 / 42161 / 10 | already shipped |
| Solana | 792703809 | works (−1.44%) — separate spec |
| Polygon, Avalanche, Unichain, Sonic, Abstract | — | work; deliberately not added |
| Berachain | 80094 | `NO_SWAP_ROUTES_FOUND` |

BNB had the best price impact of any EVM source. `originCurrency: 0x0000…0000` already means "this chain's native asset" to Relay on every chain, so no currency handling changes.

## The one thing that is not config

The widget hardcodes `ETH` in four user-facing places. Left alone, a BNB payer would type into a field labelled **ETH** and read **"1 ETH = 260,000 PONSY"** while actually spending BNB — a price misstatement of roughly the ETH/BNB ratio (~3.4x at current prices), in the user's head rather than in the arithmetic. The quote itself would be correct; the label would lie about what it describes.

So each source chain carries its own native symbol, and the widget reads it.

| Site | Today | After |
| --- | --- | --- |
| `SwapWidget.jsx:355` | `aria-label="Amount of ETH to pay"` | `chain.native` |
| `SwapWidget.jsx:359` | token chip beside the input | `chain.native` |
| `SwapWidget.jsx:616` | `1 ETH = … PONSY` | `1 ${chain.native} = …` |
| `SwapWidget.jsx:301` | "Hold ETH on Base, Ethereum, …" | rewritten for mixed assets |

**Deliberate exception:** `SwapWidget.jsx:638` — "An Ethereum L2. Gas is paid in ETH" — **stays ETH**. It describes Robinhood Chain, the destination, whose gas token is ETH no matter where the payment came from. Changing it would be the mirror of the bug being fixed.

## Changes

### Backend — `d:\projects\ponsy`

| File | Change |
| --- | --- |
| `.env.example` | `ALLOWED_CHAIN_IDS` default gains `56` |
| `src/config.js` | same default in the inline fallback |
| `src/quote.js` | `CHAIN_NAMES` gains `56: 'BNB Chain'` |
| `src/quote.js:17,113` | two comments assert every source chain pays in ETH — now false, corrected |

No logic changes. The chain allowlist is a data edit; validation, normalisation and the Relay call are untouched.

### Frontend — `D:\projects\Meme4`

| File | Change |
| --- | --- |
| `src/lib/swap.js` | every `SOURCE_CHAINS` entry gains `native`; new BNB entry; `EXPLORER_BY_CHAIN_ID` gains `56: 'https://bscscan.com'` |
| `src/components/SwapWidget.jsx` | the four sites above read `chain.native` |

`SOURCE_CHAINS` keeps Robinhood Chain (4663) as a selectable source — a same-chain swap with no bridging. It works and is a legitimate path for someone already holding ETH there.

## Failure handling

Nothing new. An unlisted chain is still rejected server-side with `chain <N> is not supported`, and the frontend surfaces that message verbatim. A chain absent from `EXPLORER_BY_CHAIN_ID` renders the transaction hash as plain copyable text rather than a broken link — existing behaviour, now exercised by one more chain.

The `$25` minimum is enforced in USD after quoting, so it applies to BNB unchanged without a price table.

## Testing

**Backend:** chain `56` is accepted; an unlisted chain is still rejected; the explorer/label additions do not disturb the existing 111 tests.

**Frontend:** `explorerTxUrl(56, hash)` returns the BscScan URL. The symbol substitution has no DOM test environment (Vitest runs `environment: 'node'` and the widget has no harness), so it is verified by the local dry run: select BNB Chain and confirm the input chip, aria-label and rate line all read BNB, then select Base and confirm they read ETH.

## Out of scope

- **Solana** — separate spec. Requires base58 address validation, a Solana chain id, instruction-based signing, and a second wallet stack.
- **ERC-20 sources (USDC, USDT)** — need an approval transaction before the deposit; the execution hook signs exactly one transaction.
- **Polygon, Avalanche, Unichain, Sonic, Abstract** — verified working and cheap to add later; excluded to keep the dropdown short and the support surface small.
