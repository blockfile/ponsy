# $PONSY stats backend

Serves live **market cap** and **holders** to the `ORIGIN STORY` panel of the
`spider-meme-coin` frontend, for an ERC-20 on **Robinhood Chain** (id 4663).

No frontend code changes are required. The site already reads its stats endpoint
from an environment variable — going live is one line in the frontend's `.env`.

---

## Quick start

```bash
npm install
cp .env.example .env      # optional: defaults already point at Robinhood Chain
npm start                 # http://localhost:8787
```

```bash
npm test                  # 67 tests, no network
npm run probe             # check each upstream and print what it returned
```

---

## Going live — the whole checklist

**1. In this project's `.env`,** set the token (and ideally the pool):

```ini
TOKEN_ADDRESS=0xYourPonsyContract
POOL_ADDRESS=0xYourUniswapV3PonsyWethPool   # optional but preferred
CORS_ORIGIN=https://your-site.com
```

**2. In the frontend's `.env`** (`D:\Jarred\test\Meme4\.env`), one line:

```ini
VITE_STATS_URL=https://your-backend-host/stats
```

That's it. No frontend source file is touched.

**Until `TOKEN_ADDRESS` is set,** `/stats` returns nulls and the panel shows
dashes. That is deliberate — see *Pre-launch behaviour* below.

---

## Why it doesn't need a frontend change

The frontend's `src/lib/stats.js` reads `VITE_STATS_URL` and maps the response
through `normalise()`, which already accepts `marketCap` and `holders`. This
backend emits exactly those names, so the existing mapping works untouched.
A test pins that contract (`test/stats.test.js`, "emits the exact field names
the frontend normalise() reads") so it cannot drift silently.

---

## Endpoints

### `GET /stats`

```json
{
  "marketCap": 3864.22,
  "holders": 126,
  "priceUsd": 0.0000038642,
  "totalSupply": 1000000000,
  "placeholder": false,
  "source": { "price": "pool", "holders": "blockscout" },
  "warnings": [],
  "stale": false,
  "updatedAt": "2026-08-08T11:17:25.990Z"
}
```

`marketCap` and `holders` are the contract with the frontend. The rest is
diagnostic — the frontend ignores unknown keys. `source` always states where
each number actually came from.

### `GET /health`

Liveness. Touches no upstream, so it stays up when they don't.

---

## Where the numbers come from

| Figure | Source | Why that one |
| --- | --- | --- |
| **holders** | Blockscout `/tokens/{addr}/counters` | A plain RPC node cannot answer "how many addresses hold this token". Answering it means replaying every Transfer since deployment — the indexing the explorer already does. |
| **supply** | your RPC, `totalSupply()` + `decimals()` | Authoritative and free. |
| **price** | your RPC, pool `slot0()` → × ETH/USD | Correct the moment your pool has liquidity. Dexscreener can lag a fresh pair by hours. |
| **price** (fallback) | Dexscreener `priceUsd` | Used when the pool read fails or `POOL_ADDRESS` is unset. |
| **ETH/USD** | Blockscout `/stats` `coin_price` | Already published by the explorer — no extra key or dependency. |

No API keys. No database.

---

## Behaviour when things break

**Pre-launch** (`TOKEN_ADDRESS` unset) — `200` with null figures and
`placeholder: true`. The frontend renders null as an em dash. This is a success
response on purpose: an error would trip the panel's RETRY view and tell
visitors the site is broken when it is merely early.

**Partial outage** — holders and price are fetched independently, so one failing
does not blank the other. The missing field is `null` and the reason lands in
`warnings`.

**Total outage** — the last good payload is served for up to `STALE_MAX_MS`
(default 10 min) with `stale: true`. Past that, `/stats` returns `503` and the
panel shows RETRY. Indefinitely stale numbers would be worse than an honest
outage.

**Load** — responses are cached for `CACHE_TTL_MS` (default 30s, against the
frontend's 60s poll) and concurrent misses share one upstream fetch, so a launch
-day crowd produces one request per cycle rather than thousands.

---

## Two correctness guards worth knowing about

**The pool must be a WETH pair.** On-chain pricing multiplies by the *native
coin* price. Against a USDC pool that is wrong by the whole ETH price — roughly
1900x — and the result still looks like a plausible market cap. The backend
checks the pool's counter token and falls back to Dexscreener rather than
publishing it.

**Token ordering is read, not assumed.** The real PONSY pool has WETH as
`token0`, so PONSY is `token1` and the price ratio is inverted. The code reads
`token0()` and inverts accordingly; assuming the order is the classic Uniswap
pricing bug.

---

## Design notes

**No `ethers` or `viem`.** Every call needed (`totalSupply`, `decimals`,
`slot0`, `token0`) takes zero arguments, so calldata is a constant 4-byte
selector and decoding is fixed-width hex slicing — about 40 lines of BigInt.
Neither library does the Uniswap price math for us either, so the dependency
would buy nothing. The only runtime dependency is Express.

**BigInt throughout.** `sqrtPriceX96` reaches 2^160 and loses precision as a JS
number; the raw 1e27 supply is already past Number's exact-integer range. Both
stay BigInt until a single final conversion, scaled by 10^36 so prices in the
1e-9 range keep their significant digits instead of flooring to zero.

---

## Layout

```
src/
  index.js              entry point — wiring and startup
  config.js             env parsing + validation, fail-fast
  server.js             Express, CORS, status codes
  stats.js              orchestration and fallback policy
  cache.js              TTL, request coalescing, stale-on-failure
  http.js               shared GET with timeout
  chain/
    rpc.js              batched JSON-RPC over fetch
    abi.js              selectors + returndata decoding
    uniswapV3.js        sqrtPriceX96 -> price, BigInt-safe
  sources/
    blockscout.js       holders + ETH/USD
    dexscreener.js      fallback price
scripts/probe.js        per-upstream diagnostic
test/                   67 tests, fixtures captured from live chain
docs/superpowers/specs/ design document
```

## Configuration

Every variable is documented in `.env.example`. The upstream defaults are
already correct for Robinhood Chain; in normal use `TOKEN_ADDRESS`,
`POOL_ADDRESS` and `CORS_ORIGIN` are the only ones you set.
