# Burn Tracking — Design

**Date:** 2026-08-10
**Status:** Approved

## Purpose

Show how much $PONSY has been burned, alongside the existing MARKET CAP and
HOLDERS figures.

## What "burned" means for this token — verified on-chain, 2026-08-10

$PONSY is a plain ERC-20. Probed directly against
`rpc.mainnet.chain.robinhood.com`:

| probe | result |
| --- | --- |
| `decimals()` | 18 |
| `totalSupply()` | 1,000,000,000 |
| `balanceOf(0x…dEaD)` | **30,436,764 — 3.0437%** |
| `balanceOf(0x0)` | 0 |
| `burn(uint256)` | **absent** |
| `totalBurned()` | **absent** |
| `owner()` | absent |

There is no burn function and no burn accounting. Burning here means
**sending tokens to the dead address**, which is why `totalSupply` never
moves — those 30.4M tokens still count toward it.

So the measurement is `balanceOf(0x…dEaD)`. Anyone can verify it on
Blockscout, which matters for a number whose whole purpose is trust.

`0x0` is read and added too. It holds nothing today, but it is the other
conventional burn sink and the figure should not silently miss a transfer
there. It costs nothing — see below.

## The market-cap question, and the decision

`marketCap` is `priceUsd × totalSupply`, which counts the burned tokens.
Dexscreener reports `priceUsd × circulating`, excluding them. Measured the
same minute: **site $175,900, Dexscreener $170,546.**

Excluding burned supply is the convention on Dexscreener, CoinGecko and CMC.
It was raised, and **the decision is to leave `marketCap` unchanged.** Burn
is additive information only.

The consequence, recorded so it is not rediscovered as a bug: the site's
market cap will continue to read ~3% above Dexscreener's, and publishing a
burn percentage gives a visitor the arithmetic to notice. Revisiting this
means changing a headline number downward, which is a product decision, not
a technical one.

## Backend

`readChain` in `src/stats.js` already builds an array of calls and sends them
through `rpc.ethCallBatch` — its own doc comment says "in as few round trips
as possible." The two `balanceOf` reads become two more entries in that
array.

**This is a hard requirement, not an optimisation.** Adding a *sequential*
upstream call to `/stats` is what caused this project's 504 outage, and
adding one to `/quote` nearly repeated it on 2026-08-10. Burn must ride the
existing round trip. A burn implementation that adds a round trip is wrong
even if it returns the right number.

The response gains two fields:

```
burned:     30436764     whole tokens, decimals applied
burnedPct:  3.0437       percent of totalSupply
```

Everything already in the response keeps its exact meaning. Purely additive,
so deploy order against the frontend does not matter.

`burnedPct` is derived from the same batch as `totalSupply`, never from a
second fetch: a percentage whose numerator and denominator come from
different blocks is wrong in a way nobody would spot.

### Failure behaviour

A failed burn read sets `burned` and `burnedPct` to `null` and appends a
warning — exactly how `marketCap` already degrades. **It must never fail
`/stats`.** Market cap and holders are what people came for; losing them to
a burn read would trade a headline feature for a secondary one.

## Frontend

Built on a branch cut from **`origin/swap`**, containing only this feature.
The local `swap` branch carries 31 commits of unshipped swap work and has
`SWAP_ENABLED` set differently from production; building there would drag
that in or silently flip the flag.

Three constraints discovered by reading the deployed code:

1. `StatsRow` is **i18n-driven**: labels come from `t('stats.<key>')`, with
   the API's `label` as fallback. A new stat needs a stable `key`.
2. `package.json` runs `check:i18n && vite build`, so **missing translations
   fail the build**. Burn needs `en`, `ru` and `zh` entries.
3. The stat grid already caps at 3 columns and adapts, so a third stat needs
   no layout work. The loading skeleton hardcodes two panels and must become
   three, or the section jumps when the numbers land.

The row:

```
MARKET CAP        HOLDERS        BURNED
$172.1K           537            30.4M
                                 3.04% OF SUPPLY
```

Stat rows gain an optional `sub` field. The existing two rows omit it and
render exactly as they do today.

`30,436,764` renders as **30.4M**. The existing `formatCount` prints full
digits, which is right for a holder count and wrong for tens of millions
beside a `$172.1K`.

## Testing

**Backend:** the burn reads are in the batch rather than sequential; a failed
burn read degrades to `null` and leaves `marketCap` and `holders` intact;
`burnedPct` is computed against `totalSupply`; decimals are applied, so the
figure is whole tokens and not raw units.

**Frontend:** a row without `sub` renders unchanged; the grid and the loading
skeleton both handle three; the burn value is abbreviated, not comma-grouped;
`check:i18n` passes for all three locales.

## Out of scope

- **Changing `marketCap` to circulating supply** — decided above.
- **Burn history or a chart** — one number, not a time series. There is no
  burn event to index, only a balance, so history would mean scanning
  Transfer logs to the dead address: a different and much larger feature.
- **Burn on any chain but Robinhood** — PONSY exists nowhere else.
