# Network + Token Selection — Design

**Date:** 2026-08-09
**Status:** Approved

## Purpose

Let a buyer choose a **network** and then a **token on that network**, instead of only the network's native asset. Adds USDC and USDT alongside SOL / ETH / BNB, which completes the asset table in the published *Ponsy Cross-Chain Swap* document.

## Verified live against Relay, 2026-08-09

Every row probed directly against `api.relay.link` with PONSY as the destination:

| Network | Token | Routes? | Steps | Signatures |
| --- | --- | --- | --- | --- |
| Solana | SOL | yes | `deposit` | 1 |
| Solana | USDC / USDT (SPL) | **no — `NO_SWAP_ROUTES_FOUND`** | — | — |
| Ethereum | ETH | yes | `deposit` | 1 |
| Ethereum | USDC, USDT | yes | `approve` + `deposit` | **2** |
| BNB Chain | BNB | yes | `deposit` | 1 |
| BNB Chain | USDT, USDC | yes | `approve` + `deposit` | **2** |
| Base | ETH | yes | `deposit` | 1 |
| Base | USDC | yes | `approve` + `deposit` | **2** |
| Robinhood | ETH | yes | `swap` (same-chain, no bridge) | 1 |

Two findings that shape the design:

**`approve` is a real transaction, not a signature.** `kind: "transaction"`, with the same field set the existing EVM path already signs (`from`, `to`, `data`, `value`, `chainId`, `gas`, `maxFeePerGas`, `maxPriorityFeePerGas`). So a token swap costs two wallet prompts and two gas fees.

**Relay approves the exact trade amount, not `uint256` max.** A 40 USDC swap emits an allowance of exactly `40000000` units. There is no infinite-approval decision to make and no standing allowance risk to design around — the upstream already chose the safe form.

## The interface

```
before                          after
[ → ROBINHOOD CHAIN ]  (label)  [ Solana ▾ ]   network
[ Solana ▾ ]           (chain)  [ SOL ▾ ]      token on that network
```

The destination stays PONSY on Robinhood Chain and remains a label, not a control — PONSY exists nowhere else, so a destination picker would hold one entry. (Selling PONSY *into* other assets is a genuine multi-destination feature and is out of scope; see below.)

Solana's token selector holds **SOL only** and renders disabled. SPL tokens do not route at all, so offering them would be a false choice.

**The two-transaction cost must be stated before the first prompt**, not discovered between them: *"This takes 2 transactions — approve, then swap."* Two unexplained wallet popups is how people abandon a swap halfway, having already paid approval gas.

## Multi-step execution

Relay returns steps in order. Both step shapes are identical to what the existing EVM path signs, so execution is: run each step through the current `buildTxParams` + `eth_sendTransaction` code, in sequence.

The load-bearing distinction:

> **`approve` moves no funds.** It grants permission for exactly the trade amount. It must **not** set `maybeSentRef` and must **not** mark the swap `unresolved`.

Without that exemption, a *successful* approval would lock the buy button before the deposit ever runs — the guards would treat step one as an unresolved fund movement. Only the fund-moving step gets `maybeSentRef`, the unconditional `setTxHash`, and the `unresolved` lock.

The exemption keys on the step's `id` being exactly `approve`. Any other step id gets the strict treatment by default, so an unexpected shape from Relay fails safe rather than silently skipping the guards.

**Abandoning between the two steps is safe and self-correcting.** A user who approves and walks away has spent approval gas and granted a bounded allowance; nothing else moved. The next attempt fetches a fresh quote, and if the existing allowance already covers it Relay returns a single step. No resume state is tracked, because none is needed.

## Backend

`originCurrency` is currently hardcoded to native (`0x0000…0000` on EVM, the SOL mint on Solana). It becomes a token selected from a **server-side allowlist keyed by network** — never taken from the request, exactly as the destination token already works, and for the same reason: a client-supplied token address is a way to route someone's money into a copy.

The response gains the full `steps` array rather than a single `tx`. Existing single-step responses keep working; a consumer that only understands one step must fail loudly on a two-step quote rather than silently signing the approval and stopping.

## Risks

**The guard interaction, not the plumbing.** `spent`, `unresolved` and `maybeSentRef` were designed around exactly one signature, and review found four Critical defects in that area during the EVM work. Multi-step execution is therefore its own implementation task with its own review, not a rider on the UI change.

**Gas cost on Ethereum mainnet.** Two transactions for a memecoin purchase is real money. The warning copy is the mitigation; if it proves too costly in practice, restricting tokens to the cheap chains is a one-line allowlist edit.

## Testing

**Backend:** the token allowlist rejects an unlisted token, rejects a client-supplied one, and selects the right currency per network; the steps array is passed through intact; a Solana origin still refuses SPL tokens before reaching Relay.

**Frontend:** step sequencing — `approve` then `deposit` — with the approve step asserted **not** to set `maybeSentRef` or `unresolved`, and the deposit step asserted to set both. A failure on step two must leave the button recoverable rather than locked as possibly-sent, since nothing was sent.

**The real gate** remains a live swap: one native-asset swap and one token swap, the latter confirming both prompts appear, the warning precedes them, and abandoning after the approval leaves a recoverable state.

## Out of scope

- **Selling PONSY into other assets** — the multi-destination direction from the PDF. Needs an approval on Robinhood Chain plus a destination selector; a separate feature.
- **SPL tokens on Solana** — the route does not exist upstream.
- **Arbitrary token entry** — the allowlist is deliberate; free-form token addresses reintroduce the impostor-token risk the destination lock exists to prevent.
