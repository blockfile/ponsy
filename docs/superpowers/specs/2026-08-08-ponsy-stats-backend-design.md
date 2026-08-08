# $PONSY Stats Backend — Design

**Date:** 2026-08-08
**Status:** Approved

## Purpose

Serve live MARKET CAP and HOLDERS figures to the `ORIGIN STORY` stats panel of the
`spider-meme-coin` frontend (`D:\Jarred\test\Meme4`), for an ERC-20 on Robinhood
Chain (chain id 4663).

## Hard constraint

**No frontend code changes.** The frontend already reads a configurable endpoint
from `VITE_STATS_URL` (`src/lib/stats.js:16`) and maps the payload in
`normalise()` (`src/lib/stats.js:56-64`), which accepts `marketCap` and
`holders`. This backend emits exactly that shape. Going live is a one-line `.env`
edit in the frontend, not a code edit.

## Verified facts (probed 2026-08-08)

| Source | Endpoint | Verified result |
| --- | --- | --- |
| Robinhood RPC | `https://rpc.mainnet.chain.robinhood.com` | `eth_chainId` -> `0x1237` (4663); head block ~`0x1d958d2` |
| Blockscout | `https://robinhoodchain.blockscout.com` | v11.2.4; `/api/v2/stats` returns `coin_price` (ETH/USD) |
| Blockscout | `/api/v2/tokens/{addr}/counters` | returns `token_holders_count` |
| Dexscreener | `/latest/dex/tokens/{addr}` | supports `chainId: "robinhood"`; returns `priceUsd` |

A PONSY/WETH Uniswap v3 pair exists on Robinhood Chain, but ownership is
**unconfirmed** by the user. Therefore `TOKEN_ADDRESS` ships **unset**.

## Architecture

Standalone Node 20 + Express service. Own repo at `d:\projects\ponsy`. Deploys
anywhere (Railway / Fly / VPS / Docker). CORS enabled because the frontend calls
it cross-origin.

```
GET /stats
   |- RPC ---------- totalSupply(), decimals()          -> supply
   |                 slot0(), token0() on the v3 pool   -> PONSY/WETH price  (1)
   |- Blockscout --- /tokens/{addr}/counters            -> holders
   |                 /stats -> coin_price               -> ETH/USD
   \- Dexscreener -- priceUsd                           -> fallback if (1) fails

   marketCap = supply * priceWeth * ethUsd
```

### Modules

| File | Responsibility |
| --- | --- |
| `src/config.js` | Env parsing + validation; fail-fast on malformed address |
| `src/chain/rpc.js` | Minimal batched JSON-RPC over `fetch` |
| `src/chain/uniswapV3.js` | `sqrtPriceX96` -> price; decimal-aware, BigInt-safe |
| `src/sources/blockscout.js` | Holders + ETH/USD |
| `src/sources/dexscreener.js` | Fallback price |
| `src/stats.js` | Orchestration into the response payload |
| `src/cache.js` | TTL cache + serve-stale-on-upstream-failure |
| `src/server.js` | Express wiring, CORS, routes |

### Response shape

```json
{
  "marketCap": 3858.02,
  "holders": 126,
  "priceUsd": 0.000003858,
  "totalSupply": 1000000000,
  "source": { "price": "pool", "holders": "blockscout" },
  "stale": false,
  "updatedAt": "2026-08-08T12:00:00.000Z"
}
```

`marketCap` and `holders` are the contract with the frontend. The remaining
fields are diagnostic; `normalise()` ignores unknown keys.

## Key decisions

### No `ethers` / `viem` dependency

Every contract call required (`totalSupply`, `decimals`, `slot0`, `token0`) takes
zero arguments. Calldata is therefore a hardcoded 4-byte selector and decoding is
fixed-width hex slicing — roughly 40 lines of BigInt versus a multi-megabyte
dependency. Neither library performs the Uniswap price math for us, so the
dependency would buy nothing we need.

### BigInt price math, not floats

`sqrtPriceX96` reaches 2^160 and loses precision as a JS number. Price is
computed entirely in BigInt with a 10^36 scaling factor, converted to `Number`
only at the last step. The 10^36 factor (rather than 10^18) keeps resolution on
meme-token prices in the 1e-9 range.

For a pool where PONSY is `token0`:

```
scaled = sqrtP^2 * 10^36 * 10^dec0 / (2^192 * 10^dec1)
price  = Number(scaled) / 1e36
```

When PONSY is `token1`, the ratio is inverted. Token ordering is read from the
pool via `token0()` rather than assumed.

### Pool address is optional config

No auto-discovery via the Uniswap v3 factory: its address on Robinhood Chain is
unknown and guessing it would produce silent wrong answers. Set `POOL_ADDRESS`
for on-chain pricing; leave it unset and pricing cleanly uses Dexscreener.

### Unlaunched state returns 200, not an error

With `TOKEN_ADDRESS` unset, `/stats` returns `marketCap: null, holders: null,
placeholder: true`. The frontend's `formatUsd`/`formatCount` render `null` as
`$—` and `—`, so the panel shows dashes rather than an error state. Returning an
error would trip the panel's RETRY view, which misrepresents "not launched yet"
as "our backend is broken".

## Failure handling

- **Cache:** 30s TTL. The frontend polls every 60s (`REFRESH_MS`), so upstreams
  are never hit more than once per cycle regardless of visitor count.
- **Serve stale:** on upstream failure, the last good payload is served for up to
  10 minutes with `stale: true`. Beyond that, `/stats` returns 503 and the panel
  shows its RETRY state — an honest outage rather than indefinitely stale numbers.
- **Partial failure:** holders and price are fetched independently. If only one
  fails, the other is still returned; the missing field is `null`.
- **Price fallback:** pool read failure falls through to Dexscreener, recorded in
  `source.price` so the payload always states where the number came from.
- **Timeouts:** every upstream call is bounded by `AbortSignal.timeout`.

## Testing

`node:test`, no live network. Upstream responses are captured fixtures taken from
the 2026-08-08 probes above.

- `uniswapV3` math against known vectors, both token orderings, mismatched decimals
- ABI decoding of `slot0`/`totalSupply`/`decimals`/`token0` return data
- Cache TTL, stale window, and expiry past the stale window
- Orchestration: pool-success, pool-fail-dexscreener-success, both-fail,
  holders-fail, token-unset
- HTTP integration against a stubbed upstream server

## Out of scope

`/rewards`, `/quote`, and the site-content endpoints (`/token`, `/narrative`,
`/how-it-works`, `/memes`, `/film`, `/footer`). The rewards and swap sections are
switched off in the frontend (`REWARDS_ENABLED = false`, `SWAP_ENABLED = false`),
and the content endpoints serve static marketing copy that is better left as
mock data than given a runtime failure mode.
