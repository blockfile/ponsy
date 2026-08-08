# PONSY Cross-Chain Swap (EVM v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a visitor holding ETH on Base, Ethereum, Arbitrum or Optimism buy $PONSY on Robinhood Chain in one wallet signature, with a live quote and real execution.

**Architecture:** The existing stats backend at `api.ponsy.fun` gains a `/quote` endpoint that proxies Relay's intent API. The backend — never the browser — decides which token is PONSY, which chains are allowed, and what the minimum trade is. The frontend's existing `SwapWidget` gets its inert button wired to sign and send the transaction Relay returns, then polls for completion.

**Tech Stack:** Node 20 + Express (backend, no new dependencies), React 18 + Vite (frontend), Vitest (new, frontend tests only), Relay REST API, `window.ethereum` EIP-1193.

## Global Constraints

- **PONSY is exactly `0x2E84F2E0b88BD3FFB5D6738aE0e3C7c00137083E` on chain `4663`.** 12 tokens on that chain are named PONSY, two using vanity addresses ending `...083e`. Never resolve by symbol. Never accept a token address from the client.
- **Relay API base is `https://api.relay.link`.** Quote is `POST /quote`; status is `GET /intents/status?requestId=<id>`.
- **EVM only in this version.** Solana requires a second wallet stack and is explicitly out of scope — `SOURCE_CHAINS` in `src/lib/swap.js` is already EVM-only.
- **Allowed source chains: 8453 (Base), 1 (Ethereum), 42161 (Arbitrum), 10 (Optimism), 4663 (Robinhood).** Reject anything else server-side.
- **Minimum trade is $25 USD equivalent.** Below that, fixed relayer + gas costs exceed 5% of the trade (measured: a $5 trade executes 20.8% worse than spot).
- **Backend adds no npm dependencies.** Express is already present; use `fetch`.
- **`formatPct(n)` in `src/lib/swap.js` multiplies by 100.** Relay returns `totalImpact.percent` already as a percentage string (`"-5.12"`). Normalisation MUST divide by 100 or the UI shows `-512%`.
- **Do not deploy the frontend with `SWAP_ENABLED = true` until Task 8 is complete.** It is currently `true` in the repo but `QUOTE_ENDPOINT` is empty, which serves `mockQuote()` — a rate of `385_862_278.81` PONSY/ETH against a live rate near `14,354,028`, over-promising tokens by roughly 24x.

---

## File Structure

**Backend — `d:\projects\ponsy`**

| File | Responsibility |
| --- | --- |
| `src/sources/relay.js` | CREATE. Talks to Relay: build request, POST quote, GET status. No policy. |
| `src/quote.js` | CREATE. Policy + normalisation: validates input, calls relay.js, maps to the UI shape. |
| `src/config.js` | MODIFY. Add swap config block. |
| `src/server.js` | MODIFY. Add `GET /quote` and `GET /quote/status`. |
| `test/relay.test.js` | CREATE. |
| `test/quote.test.js` | CREATE. |
| `test/fixtures.js` | MODIFY. Add a captured Relay quote response. |

**Frontend — `D:\projects\Meme4`**

| File | Responsibility |
| --- | --- |
| `src/lib/swap.js` | MODIFY. Delete `mockQuote`/`MOCK_RATE`, rewrite `normaliseQuote` for Relay, add `MIN_TRADE_USD`. |
| `src/lib/swap.test.js` | CREATE. Unit tests for the normaliser. |
| `src/hooks/useSwapExecute.js` | CREATE. Wallet chain-switch, send transaction, poll status. |
| `src/components/SwapWidget.jsx` | MODIFY. Wire the button, render status and the impact warning. |
| `vitest.config.js` | CREATE. |
| `package.json` | MODIFY. Add vitest + `test` script. |

---

### Task 1: Relay client (backend)

**Files:**
- Create: `d:\projects\ponsy\src\sources\relay.js`
- Create: `d:\projects\ponsy\test\relay.test.js`
- Modify: `d:\projects\ponsy\test\fixtures.js`

**Interfaces:**
- Consumes: `getJson` from `src/http.js` (existing).
- Produces: `fetchRelayQuote(baseUrl, params, opts) -> Promise<object>` (raw Relay response); `fetchRelayStatus(baseUrl, requestId, opts) -> Promise<object>`.

- [ ] **Step 1: Add the captured Relay fixture**

Append to `d:\projects\ponsy\test\fixtures.js`:

```js
/**
 * POST /quote — 0.02 ETH on Base -> PONSY on Robinhood Chain.
 * Captured 2026-08-09. Trimmed to the fields the service reads.
 */
export const RELAY_QUOTE = {
  steps: [
    {
      id: 'deposit',
      kind: 'transaction',
      requestId: '0x2451e373b348261c1e1d6b6df9f1edc9da51f9f9ca5047b34710b8c5b4',
      items: [
        {
          status: 'incomplete',
          data: {
            from: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
            to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
            data: '0x49290c1c0000000000000000000000002dfec17b1d8dce43cb5b1111352fd58be01d389e',
            value: '20000000000000000',
            chainId: 8453,
            gas: 32713,
          },
          check: {
            endpoint: '/intents/status?requestId=0x2451e373b348261c1e1d6b6df9f1edc9',
            method: 'GET',
          },
        },
      ],
    },
  ],
  fees: {
    gas: { amountUsd: '0.000276' },
    relayer: { amountUsd: '0.730005' },
    app: { amountUsd: '0' },
  },
  details: {
    operation: 'swap',
    currencyIn: {
      currency: { chainId: 8453, symbol: 'ETH', decimals: 18 },
      amount: '20000000000000000',
      amountFormatted: '0.02',
      amountUsd: '38.427738',
    },
    currencyOut: {
      currency: {
        chainId: 4663,
        address: '0x2e84f2e0b88bd3ffb5d6738ae0e3c7c00137083e',
        symbol: 'PONSY',
        decimals: 18,
      },
      amount: '287080575613057682974296',
      amountFormatted: '287080.575613057682974296',
      amountUsd: '36.462148',
      minimumAmount: '281338964100796529311189',
    },
    totalImpact: { usd: '-1.965590', percent: '-5.12' },
    swapImpact: { usd: '-1.235585', percent: '-3.22' },
    timeEstimate: 3,
  },
}

/** GET /intents/status — a completed intent. */
export const RELAY_STATUS_SUCCESS = {
  status: 'success',
  txHashes: ['0xaaa1'],
  destinationChainId: 4663,
}
```

- [ ] **Step 2: Write the failing test**

Create `d:\projects\ponsy\test\relay.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchRelayQuote, fetchRelayStatus } from '../src/sources/relay.js'
import { RELAY_QUOTE, RELAY_STATUS_SUCCESS, stubFetch } from './fixtures.js'

const PARAMS = {
  user: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
  originChainId: 8453,
  destinationChainId: 4663,
  originCurrency: '0x0000000000000000000000000000000000000000',
  destinationCurrency: '0x2e84f2e0b88bd3ffb5d6738ae0e3c7c00137083e',
  amount: '20000000000000000',
}

test('POSTs a well-formed quote request', async () => {
  const fetchImpl = stubFetch([['/quote', async () => RELAY_QUOTE]])
  await fetchRelayQuote('https://api.relay.link', PARAMS, { fetchImpl })

  const call = fetchImpl.calls[0]
  assert.equal(call.init.method, 'POST')
  const body = JSON.parse(call.init.body)
  assert.equal(body.originChainId, 8453)
  assert.equal(body.destinationChainId, 4663)
  assert.equal(body.tradeType, 'EXACT_INPUT')
  assert.equal(body.recipient, PARAMS.user, 'recipient defaults to the sender')
})

test('returns the raw Relay payload untouched', async () => {
  const fetchImpl = stubFetch([['/quote', async () => RELAY_QUOTE]])
  const out = await fetchRelayQuote('https://api.relay.link', PARAMS, { fetchImpl })
  assert.equal(out.details.currencyOut.amountFormatted, '287080.575613057682974296')
})

test('surfaces a Relay error code rather than a bare status', async () => {
  const fetchImpl = stubFetch([
    ['/quote', async () => ({ __status: 400, errorCode: 'NO_SWAP_ROUTES_FOUND' })],
  ])
  await assert.rejects(
    () => fetchRelayQuote('https://api.relay.link', PARAMS, { fetchImpl }),
    /NO_SWAP_ROUTES_FOUND/,
  )
})

test('fetches intent status by requestId', async () => {
  const fetchImpl = stubFetch([['/intents/status', async () => RELAY_STATUS_SUCCESS]])
  const out = await fetchRelayStatus('https://api.relay.link', '0xabc', { fetchImpl })
  assert.equal(out.status, 'success')
  assert.match(fetchImpl.calls[0].url, /requestId=0xabc/)
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd d:\projects\ponsy && npm test`
Expected: FAIL — `Cannot find module '../src/sources/relay.js'`

- [ ] **Step 4: Teach the stub to return error bodies**

`stubFetch` currently discards the body on a `__status >= 400`. Relay's error detail lives in that body, so replace the `__status` branch in `d:\projects\ponsy\test\fixtures.js`:

```js
      if (result?.__status && result.__status >= 400) {
        const { __status, ...rest } = result
        return { ok: false, status: __status, json: async () => rest }
      }
```

- [ ] **Step 5: Write the implementation**

Create `d:\projects\ponsy\src\sources\relay.js`:

```js
/**
 * RELAY
 * -----------------------------------------------------------------------------
 * Transport only: builds the request, posts it, hands back what Relay said.
 *
 * All policy — which token, which chains, what minimum — lives in quote.js.
 * Keeping them apart means the rules can be tested without a network stub and
 * the transport can be tested without reasoning about the rules.
 */

/**
 * Requests a swap quote.
 *
 * @returns {Promise<object>} the raw Relay response
 */
export async function fetchRelayQuote(baseUrl, params, { timeoutMs = 15000, signal, fetchImpl = fetch } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)

  const res = await fetchImpl(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      user: params.user,
      /* The payer receives the tokens. A separate recipient is a footgun we
         have no use for: it would let a caller direct someone else's funds. */
      recipient: params.user,
      originChainId: params.originChainId,
      destinationChainId: params.destinationChainId,
      originCurrency: params.originCurrency,
      destinationCurrency: params.destinationCurrency,
      amount: params.amount,
      tradeType: 'EXACT_INPUT',
      ...(params.appFees ? { appFees: params.appFees } : {}),
    }),
    signal: AbortSignal.any(signals),
  })

  const json = await res.json().catch(() => ({}))

  if (!res.ok) {
    /* Relay names the failure — NO_SWAP_ROUTES_FOUND, AMOUNT_TOO_LOW and so on.
       Passing that through beats "HTTP 400", which tells the user nothing. */
    throw new Error(json.errorCode || json.message || `Relay HTTP ${res.status}`)
  }
  return json
}

/** Polls an intent by the requestId returned with the quote. */
export async function fetchRelayStatus(baseUrl, requestId, { timeoutMs = 10000, signal, fetchImpl = fetch } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)

  const url = `${baseUrl}/intents/status?requestId=${encodeURIComponent(requestId)}`
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any(signals),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.errorCode || `Relay HTTP ${res.status}`)
  return json
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd d:\projects\ponsy && npm test`
Expected: PASS — 4 new tests, all previous tests still passing.

- [ ] **Step 7: Commit**

```bash
cd d:/projects/ponsy
git add src/sources/relay.js test/relay.test.js test/fixtures.js
git commit -m "feat: Relay quote and status client"
```

---

### Task 2: Quote policy and normalisation (backend)

**Files:**
- Create: `d:\projects\ponsy\src\quote.js`
- Create: `d:\projects\ponsy\test\quote.test.js`
- Modify: `d:\projects\ponsy\src\config.js`

**Interfaces:**
- Consumes: `fetchRelayQuote` from Task 1; `buildConfig` from `src/config.js`.
- Produces: `createQuoteService({ config, fetchImpl }) -> { getQuote(input), getStatus(requestId) }`. `getQuote` takes `{ user, chainId, amount }` and resolves to the normalised payload described in Step 3.

- [ ] **Step 1: Add swap config**

In `d:\projects\ponsy\src\config.js`, inside the object returned by `buildConfig`, after the `dexscreenerUrl` entry:

```js
    relayUrl: parseUrl(env.RELAY_URL, 'https://api.relay.link', 'RELAY_URL'),

    /* Chains a user may pay from. Server-side because it is a safety rule, not
       a preference: an unlisted chain means an unaudited route. */
    allowedChainIds: (env.ALLOWED_CHAIN_IDS ?? '8453,1,42161,10,4663')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),

    /* Below this, fixed relayer and gas costs are a double-digit percentage of
       the trade. Measured: a $5 trade executes 20.8% worse than spot. */
    minTradeUsd: parsePositiveInt(env.MIN_TRADE_USD, 25, 'MIN_TRADE_USD'),
```

Append to `d:\projects\ponsy\.env.example`:

```ini
# Relay intent API. The default is correct.
RELAY_URL=https://api.relay.link

# Chains a visitor may pay from: Base, Ethereum, Arbitrum, Optimism, Robinhood.
ALLOWED_CHAIN_IDS=8453,1,42161,10,4663

# Minimum trade in USD. Below this, fixed costs exceed 5% of the trade.
MIN_TRADE_USD=25
```

- [ ] **Step 2: Write the failing test**

Create `d:\projects\ponsy\test\quote.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/config.js'
import { createQuoteService } from '../src/quote.js'
import { RELAY_QUOTE, RELAY_STATUS_SUCCESS, TOKEN_ADDRESS, stubFetch } from './fixtures.js'

const USER = '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E'
const config = buildConfig({ TOKEN_ADDRESS })
const ok = () => stubFetch([
  ['/quote', async () => RELAY_QUOTE],
  ['/intents/status', async () => RELAY_STATUS_SUCCESS],
])

test('normalises a Relay quote into the shape the widget renders', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok() })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })

  assert.equal(q.amountIn, 0.02)
  assert.equal(q.amountInUsd, 38.427738)
  assert.ok(Math.abs(q.amountOut - 287080.5756130577) < 0.001)
  assert.equal(q.amountOutUsd, 36.462148)
  assert.equal(q.mock, false)
})

test('converts price impact to a fraction, because formatPct multiplies by 100', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok() })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
  /* Relay says "-5.12" meaning -5.12%. The widget's formatPct renders n*100,
     so passing -5.12 through unchanged would display "-512.00%". */
  assert.ok(Math.abs(q.priceImpact - -0.0512) < 1e-9)
})

test('carries minimum received as whole tokens', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok() })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
  assert.ok(Math.abs(q.minReceived - 281338.9641007965) < 0.001)
  assert.ok(q.minReceived < q.amountOut, 'minimum must be below expected')
})

test('exposes the transaction to sign and the requestId to poll', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok() })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })

  assert.equal(q.tx.to, '0x4cd00e387622c35bddb9b4c962c136462338bc31')
  assert.equal(q.tx.from, '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E')
  assert.equal(q.tx.chainId, 8453)
  assert.equal(q.tx.value, '20000000000000000')
  assert.match(q.requestId, /^0x/)
})

test('sends the hardcoded PONSY address, never one from the caller', async () => {
  const fetchImpl = ok()
  const svc = createQuoteService({ config, fetchImpl })
  await svc.getQuote({
    user: USER, chainId: 8453, amount: '0.02',
    destinationCurrency: '0xd314ee5350570e57c8e2e5bb6b3920cd1a16083e', // impostor
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.destinationCurrency, TOKEN_ADDRESS)
  assert.equal(body.destinationChainId, 4663)
})

test('rejects a chain that is not allowlisted', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok() })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 137, amount: '0.02' }),
    /chain 137 is not supported/,
  )
})

test('rejects a malformed user address', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok() })
  await assert.rejects(
    () => svc.getQuote({ user: 'nope', chainId: 8453, amount: '0.02' }),
    /user must be/,
  )
})

test('rejects a non-positive amount', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok() })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '0' }),
    /amount must be a positive number/,
  )
})

test('rejects a trade below the USD minimum, naming the minimum', async () => {
  const tiny = {
    ...RELAY_QUOTE,
    details: {
      ...RELAY_QUOTE.details,
      currencyIn: { ...RELAY_QUOTE.details.currencyIn, amountUsd: '5.00' },
    },
  }
  const svc = createQuoteService({
    config,
    fetchImpl: stubFetch([['/quote', async () => tiny]]),
  })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '0.0026' }),
    /minimum trade is \$25/,
  )
})

test('refuses to run when TOKEN_ADDRESS is unset', async () => {
  const svc = createQuoteService({ config: buildConfig({}), fetchImpl: ok() })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' }),
    /TOKEN_ADDRESS is not set/,
  )
})

test('passes status through', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok() })
  const s = await svc.getStatus('0xabc')
  assert.equal(s.status, 'success')
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd d:\projects\ponsy && npm test`
Expected: FAIL — `Cannot find module '../src/quote.js'`

- [ ] **Step 4: Write the implementation**

Create `d:\projects\ponsy\src\quote.js`:

```js
/**
 * QUOTE POLICY
 * -----------------------------------------------------------------------------
 * Everything the browser is not allowed to decide.
 *
 * The destination token is fixed here and never read from the request. Twelve
 * tokens on chain 4663 call themselves PONSY, two of them using vanity
 * addresses ending ...083e to look like the real one. A client-supplied
 * destination would make this endpoint a convenient way to route a visitor's
 * money into a copy.
 */

import { fetchRelayQuote, fetchRelayStatus } from './sources/relay.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Native ETH, which is what every allowed source chain pays with. */
const NATIVE = '0x0000000000000000000000000000000000000000'

/** Decimal string -> integer wei string, without floating point. */
export function toWei(amount, decimals = 18) {
  const s = String(amount).trim()
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') {
    throw new Error(`amount must be a positive number, got: ${amount}`)
  }
  const [whole = '0', frac = ''] = s.split('.')
  if (frac.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimal places`)
  }
  const padded = (whole + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '')
  if (BigInt(padded) <= 0n) {
    throw new Error(`amount must be a positive number, got: ${amount}`)
  }
  return padded
}

/** Raw integer string -> whole tokens as a Number. */
function fromRaw(raw, decimals = 18) {
  const v = BigInt(raw)
  const scale = 10n ** BigInt(decimals)
  return Number(v / scale) + Number(v % scale) / Number(scale)
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function createQuoteService({ config, fetchImpl = fetch }) {
  async function getQuote({ user, chainId, amount }) {
    if (!config.tokenAddress) {
      throw new Error('TOKEN_ADDRESS is not set')
    }
    if (!ADDRESS_RE.test(String(user ?? ''))) {
      throw new Error('user must be a 0x-prefixed 40-hex-character address')
    }
    const origin = Number(chainId)
    if (!config.allowedChainIds.includes(origin)) {
      throw new Error(`chain ${chainId} is not supported`)
    }

    const raw = await fetchRelayQuote(
      config.relayUrl,
      {
        user,
        originChainId: origin,
        destinationChainId: 4663,
        originCurrency: NATIVE,
        // Fixed. Deliberately ignores anything the caller sent.
        destinationCurrency: config.tokenAddress,
        amount: toWei(amount),
      },
      { fetchImpl, timeoutMs: config.upstreamTimeoutMs },
    )

    const d = raw?.details ?? {}
    const inUsd = num(d.currencyIn?.amountUsd)

    /* Checked after quoting rather than before, because the minimum is in USD
       and only Relay knows what the user's ETH is worth right now. */
    if (inUsd > 0 && inUsd < config.minTradeUsd) {
      throw new Error(
        `minimum trade is $${config.minTradeUsd} — fixed costs would exceed 5% below that`,
      )
    }

    const outDecimals = d.currencyOut?.currency?.decimals ?? 18
    const amountOut = num(d.currencyOut?.amountFormatted)
    const amountIn = num(d.currencyIn?.amountFormatted)
    const item = raw?.steps?.[0]?.items?.[0]

    if (!item?.data?.to) {
      throw new Error('Relay returned no transaction to sign')
    }

    return {
      amountIn,
      amountOut,
      amountInUsd: inUsd,
      amountOutUsd: num(d.currencyOut?.amountUsd),
      // Tokens per 1 ETH. Derived rather than read, so it always agrees with
      // the two amounts shown directly above it in the UI.
      rate: amountIn > 0 ? amountOut / amountIn : 0,
      /* A fraction, not a percentage: the widget's formatPct multiplies by 100.
         Relay's "-5.12" passed through unchanged would render "-512.00%". */
      priceImpact: num(d.totalImpact?.percent) / 100,
      minReceived: d.currencyOut?.minimumAmount
        ? fromRaw(d.currencyOut.minimumAmount, outDecimals)
        : 0,
      feeUsd: num(raw?.fees?.relayer?.amountUsd) + num(raw?.fees?.app?.amountUsd),
      timeEstimate: num(d.timeEstimate),
      route: `${originName(origin)} to Robinhood Chain, one transaction`,
      tx: {
        /* Carried through because some wallets reject eth_sendTransaction
           without an explicit `from`. Relay echoes back the `user` we sent, so
           this is the connected account by construction. */
        from: item.data.from,
        to: item.data.to,
        data: item.data.data,
        value: String(item.data.value ?? '0'),
        chainId: item.data.chainId,
      },
      requestId: raw?.steps?.[0]?.requestId ?? null,
      mock: false,
    }
  }

  function getStatus(requestId) {
    if (!requestId) throw new Error('requestId is required')
    return fetchRelayStatus(config.relayUrl, requestId, {
      fetchImpl,
      timeoutMs: config.upstreamTimeoutMs,
    })
  }

  return { getQuote, getStatus }
}

const CHAIN_NAMES = {
  1: 'Ethereum',
  10: 'Optimism',
  8453: 'Base',
  42161: 'Arbitrum',
  4663: 'Robinhood Chain',
}
function originName(id) {
  return CHAIN_NAMES[id] ?? `Chain ${id}`
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd d:\projects\ponsy && npm test`
Expected: PASS — 11 new tests.

- [ ] **Step 6: Commit**

```bash
cd d:/projects/ponsy
git add src/quote.js src/config.js test/quote.test.js .env.example
git commit -m "feat: quote policy, validation and normalisation"
```

---

### Task 3: Quote endpoints (backend)

**Files:**
- Modify: `d:\projects\ponsy\src\server.js`
- Modify: `d:\projects\ponsy\src\index.js`
- Modify: `d:\projects\ponsy\test\server.test.js`

**Interfaces:**
- Consumes: `createQuoteService` from Task 2.
- Produces: `GET /quote?amount=&chainId=&user=` and `GET /quote/status?requestId=`. `createServer` gains a `quoteService` dependency.

- [ ] **Step 1: Write the failing test**

Append to `d:\projects\ponsy\test\server.test.js`:

```js
const QUOTE = {
  amountIn: 0.02, amountOut: 287080.57, amountInUsd: 38.42, amountOutUsd: 36.46,
  rate: 14354028.5, priceImpact: -0.0512, minReceived: 281338.96, feeUsd: 0.73,
  timeEstimate: 3, route: 'Base to Robinhood Chain, one transaction',
  tx: { to: '0x4cd0', data: '0x49290c1c', value: '20000000000000000', chainId: 8453 },
  requestId: '0xreq', mock: false,
}

function quoteStub(overrides = {}) {
  return {
    getQuote: async () => QUOTE,
    getStatus: async () => ({ status: 'success' }),
    ...overrides,
  }
}

test('GET /quote returns the normalised quote', async () => {
  const app = createServer({
    config: CONFIG,
    statsService: { collect: async () => PAYLOAD },
    quoteService: quoteStub(),
    cache: createCache({ ttlMs: 0, staleMaxMs: 0 }),
    logger: silent,
  })
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const res = await fetch(
    `${base}/quote?amount=0.02&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E`,
  )
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(body.amountOut, 287080.57)
  assert.equal(body.tx.chainId, 8453)
  assert.equal(res.headers.get('cache-control'), 'no-store')

  await new Promise((r) => server.close(r))
})

test('GET /quote returns 400 with the reason when the service rejects', async () => {
  const app = createServer({
    config: CONFIG,
    statsService: { collect: async () => PAYLOAD },
    quoteService: quoteStub({
      getQuote: async () => { throw new Error('minimum trade is $25') },
    }),
    cache: createCache({ ttlMs: 0, staleMaxMs: 0 }),
    logger: silent,
  })
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const res = await fetch(`${base}/quote?amount=0.001&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E`)
  const body = await res.json()

  assert.equal(res.status, 400)
  assert.match(body.error, /minimum trade is \$25/)

  await new Promise((r) => server.close(r))
})

test('GET /quote/status proxies the intent status', async () => {
  const app = createServer({
    config: CONFIG,
    statsService: { collect: async () => PAYLOAD },
    quoteService: quoteStub(),
    cache: createCache({ ttlMs: 0, staleMaxMs: 0 }),
    logger: silent,
  })
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const res = await fetch(`${base}/quote/status?requestId=0xreq`)
  assert.equal((await res.json()).status, 'success')

  await new Promise((r) => server.close(r))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\projects\ponsy && npm test`
Expected: FAIL — `/quote` returns 404 `{"error":"not found"}`.

- [ ] **Step 3: Add the routes**

In `d:\projects\ponsy\src\server.js`, change the signature:

```js
export function createServer({ config, statsService, quoteService, cache, logger = console }) {
```

Then insert these two routes immediately before the final `app.use((_req, res) => ...)` 404 handler:

```js
  /* Never cached. A quote is a price with an expiry — serving a stale one from
     any layer is how a user signs a transaction for a number that no longer
     exists. Note this is the opposite of /stats, which is cached for 30s. */
  app.get('/quote', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const quote = await quoteService.getQuote({
        user: req.query.user,
        chainId: req.query.chainId,
        amount: req.query.amount,
      })
      res.json(quote)
    } catch (err) {
      /* 400, not 500: nearly everything that fails here is the request's fault
         — an unsupported chain, too small an amount, no route for that pair —
         and the message is written to be shown to the user as-is. */
      logger.warn?.('[quote]', err.message)
      res.status(400).json({ error: err.message })
    }
  })

  app.get('/quote/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.json(await quoteService.getStatus(req.query.requestId))
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })
```

- [ ] **Step 4: Wire it in the entry point**

In `d:\projects\ponsy\src\index.js`, add the import next to the others:

```js
import { createQuoteService } from './quote.js'
```

then construct it and pass it in, replacing the `createServer` call:

```js
const quoteService = createQuoteService({ config })

const app = createServer({ config, statsService, quoteService, cache })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd d:\projects\ponsy && npm test`
Expected: PASS — 3 new tests, all previous still green.

- [ ] **Step 6: Verify against the real Relay API**

```bash
cd d:/projects/ponsy
TOKEN_ADDRESS=0x2E84F2E0b88BD3FFB5D6738aE0e3C7c00137083E PORT=8799 node src/index.js &
sleep 3
curl -s "http://127.0.0.1:8799/quote?amount=0.02&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E"
curl -s "http://127.0.0.1:8799/quote?amount=0.0001&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E"
curl -s "http://127.0.0.1:8799/quote?amount=0.02&chainId=137&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E"
kill %1
```

Expected: a real quote with `tx` and `requestId`; then `{"error":"minimum trade is $25 ..."}`; then `{"error":"chain 137 is not supported"}`.

- [ ] **Step 7: Commit**

```bash
cd d:/projects/ponsy
git add src/server.js src/index.js test/server.test.js
git commit -m "feat: GET /quote and GET /quote/status"
```

---

### Task 4: Deploy the backend

**Files:** none changed — deployment only.

**Interfaces:**
- Produces: `https://api.ponsy.fun/quote` live.

- [ ] **Step 1: Push**

```bash
cd d:/projects/ponsy && git push origin main
```

- [ ] **Step 2: Deploy**

```bash
ssh root@152.42.239.56
cd /var/www/ponsy-stats
git pull
npm ci --omit=dev
pm2 restart ponsy-stats
pm2 logs ponsy-stats --lines 20
```

- [ ] **Step 3: Verify from outside**

```bash
curl -s "https://api.ponsy.fun/quote?amount=0.02&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E"
curl -s -I -H "Origin: https://ponsy.fun" "https://api.ponsy.fun/quote?amount=0.02&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E" | grep -i access-control
```

Expected: a quote with a `tx` object, and an `Access-Control-Allow-Origin: https://ponsy.fun` header. An empty CORS result means `CORS_ORIGIN` in the server's `.env` needs `https://ponsy.fun`.

- [ ] **Step 4: Confirm `/stats` still works**

```bash
curl -s https://api.ponsy.fun/stats
```

Expected: unchanged stats payload with `warnings: []`.

---

### Task 5: Frontend test setup and swap.js rewrite

**Files:**
- Modify: `D:\projects\Meme4\package.json`
- Create: `D:\projects\Meme4\vitest.config.js`
- Modify: `D:\projects\Meme4\src\lib\swap.js`
- Create: `D:\projects\Meme4\src\lib\swap.test.js`

**Interfaces:**
- Consumes: the backend `/quote` shape from Task 2.
- Produces: `fetchQuote({ amount, chain, account, signal }) -> Promise<object|null>`; `MIN_TRADE_USD`; `HIGH_IMPACT`; `QUOTE_ENDPOINT`; `STATUS_ENDPOINT`. `mockQuote` and `MOCK_RATE` no longer exist.

- [ ] **Step 1: Add Vitest**

In `D:\projects\Meme4\package.json`, add to `scripts`:

```json
    "test": "vitest run",
```

and to `devDependencies`:

```json
    "vitest": "^2.1.8",
```

Then create `D:\projects\Meme4\vitest.config.js`:

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.js'] },
})
```

Run: `cd D:\projects\Meme4 && npm install`

- [ ] **Step 2: Write the failing test**

Create `D:\projects\Meme4\src\lib\swap.test.js`:

```js
import { describe, expect, it, vi } from 'vitest'
import { fetchQuote, normaliseQuote, MIN_TRADE_USD, HIGH_IMPACT } from './swap'

const BACKEND = {
  amountIn: 0.02, amountOut: 287080.575613, amountInUsd: 38.427738,
  amountOutUsd: 36.462148, rate: 14354028.78, priceImpact: -0.0512,
  minReceived: 281338.9641, feeUsd: 0.730005, timeEstimate: 3,
  route: 'Base to Robinhood Chain, one transaction',
  tx: { to: '0x4cd0', data: '0x49290c1c', value: '20000000000000000', chainId: 8453 },
  requestId: '0xreq', mock: false,
}

describe('normaliseQuote', () => {
  it('passes the backend figures through unchanged', () => {
    const q = normaliseQuote(BACKEND)
    expect(q.amountOut).toBe(287080.575613)
    expect(q.priceImpact).toBe(-0.0512)
    expect(q.minReceived).toBe(281338.9641)
  })

  it('keeps the transaction and requestId needed to execute', () => {
    const q = normaliseQuote(BACKEND)
    expect(q.tx.chainId).toBe(8453)
    expect(q.requestId).toBe('0xreq')
  })

  it('never reports itself as mock', () => {
    expect(normaliseQuote(BACKEND).mock).toBe(false)
  })
})

describe('fetchQuote', () => {
  it('returns null for a zero amount without calling the network', async () => {
    const fetchImpl = vi.fn()
    expect(await fetchQuote({ amount: 0, chain: { id: 8453 }, fetchImpl })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends amount, chainId and account', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => BACKEND }))
    await fetchQuote({
      amount: 0.02, chain: { id: 8453 }, account: '0xabc', fetchImpl,
    })
    const url = fetchImpl.mock.calls[0][0]
    expect(url).toContain('amount=0.02')
    expect(url).toContain('chainId=8453')
    expect(url).toContain('user=0xabc')
  })

  it('surfaces the backend error message verbatim', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: 'minimum trade is $25' }),
    }))
    await expect(
      fetchQuote({ amount: 0.0001, chain: { id: 8453 }, account: '0xabc', fetchImpl }),
    ).rejects.toThrow('minimum trade is $25')
  })

  it('throws rather than inventing a price when there is no endpoint', async () => {
    await expect(
      fetchQuote({ amount: 1, chain: { id: 8453 }, account: '0xabc', endpoint: '' }),
    ).rejects.toThrow(/not configured/)
  })
})

describe('guard rails', () => {
  it('exposes a minimum trade and a high-impact threshold', () => {
    expect(MIN_TRADE_USD).toBe(25)
    expect(HIGH_IMPACT).toBe(0.08)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd D:\projects\Meme4 && npm test`
Expected: FAIL — `normaliseQuote` shape mismatch and `MIN_TRADE_USD` undefined.

- [ ] **Step 4: Rewrite swap.js**

In `D:\projects\Meme4\src\lib\swap.js`:

Replace the `QUOTE_ENDPOINT` line and add the new constants beneath it:

```js
/** Quote endpoint on our backend. Empty disables the widget's pricing. */
export const QUOTE_ENDPOINT = import.meta.env.VITE_QUOTE_URL ?? ''

/** Intent status endpoint, derived from the quote URL. */
export const STATUS_ENDPOINT = QUOTE_ENDPOINT ? `${QUOTE_ENDPOINT}/status` : ''

/**
 * Below this the fixed relayer and gas costs are a double-digit share of the
 * trade — a $5 buy measured 20.8% worse than spot. The backend enforces this
 * too; this copy exists only so the UI can say so before a request is made.
 */
export const MIN_TRADE_USD = 25

/** Price impact past which the UI warns rather than just displaying. */
export const HIGH_IMPACT = 0.08
```

Delete these lines entirely:

```js
const MOCK_RATE = 385_862_278.81 // PONSY per ETH
const MOCK_ETH_USD = 1864.1
```

Replace the whole `normaliseQuote` function with:

```js
/**
 * Maps the backend's quote onto what the widget renders.
 *
 * Thin on purpose. All the arithmetic — impact as a fraction, minimum received
 * in whole tokens, rate derived from the two amounts — happens once, in the
 * backend, where it is unit-tested. Duplicating it here would create two places
 * for the numbers to disagree, and the browser's copy is the one users see.
 */
export function normaliseQuote(raw) {
  return {
    amountIn: Number(raw?.amountIn ?? 0),
    amountOut: Number(raw?.amountOut ?? 0),
    amountInUsd: Number(raw?.amountInUsd ?? 0),
    amountOutUsd: Number(raw?.amountOutUsd ?? 0),
    rate: Number(raw?.rate ?? 0),
    priceImpact: Number(raw?.priceImpact ?? 0),
    minReceived: Number(raw?.minReceived ?? 0),
    feeUsd: Number(raw?.feeUsd ?? 0),
    timeEstimate: Number(raw?.timeEstimate ?? 0),
    route: raw?.route ?? 'One transaction',
    tx: raw?.tx ?? null,
    requestId: raw?.requestId ?? null,
    mock: false,
  }
}
```

Delete the entire `mockQuote` function.

Replace the whole `fetchQuote` function with:

```js
/**
 * Fetches a quote.
 *
 * Throws on any failure. There is deliberately no fallback: this widget used to
 * fall back to a hardcoded rate, and that rate drifted to roughly 24x the real
 * price — a trade UI that invents numbers is worse than one that says it is
 * broken.
 */
export async function fetchQuote({
  amount,
  chain,
  account,
  signal,
  endpoint = QUOTE_ENDPOINT,
  fetchImpl = fetch,
}) {
  if (!Number(amount)) return null
  if (!endpoint) throw new Error('Swap pricing is not configured yet.')
  if (!account) throw new Error('Connect a wallet to get a price.')

  const url =
    `${endpoint}?amount=${encodeURIComponent(amount)}` +
    `&chainId=${encodeURIComponent(chain?.id ?? '')}` +
    `&user=${encodeURIComponent(account)}`

  const res = await fetchImpl(url, { signal, headers: { Accept: 'application/json' } })
  const body = await res.json().catch(() => ({}))

  if (!res.ok) {
    /* The backend writes these to be read by a person — "minimum trade is $25",
       "chain 137 is not supported" — so show it rather than a status code. */
    throw new Error(body?.error || `Quote failed (${res.status})`)
  }
  return normaliseQuote(body)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd D:\projects\Meme4 && npm test`
Expected: PASS — 9 tests.

- [ ] **Step 6: Confirm the mock is gone**

Run: `cd D:\projects\Meme4 && grep -rn "MOCK_RATE\|mockQuote" src/ || echo "clean"`
Expected: `clean`

- [ ] **Step 7: Commit**

```bash
cd D:/projects/Meme4
git add package.json package-lock.json vitest.config.js src/lib/swap.js src/lib/swap.test.js
git commit -m "feat: real quotes from the backend, delete mock pricing"
```

---

### Task 6: Wallet execution hook

**Files:**
- Create: `D:\projects\Meme4\src\hooks\useSwapExecute.js`

**Interfaces:**
- Consumes: `STATUS_ENDPOINT` from `src/lib/swap.js`; the `quote.tx` and `quote.requestId` produced in Task 5.
- Produces: `useSwapExecute() -> { execute(quote), status, txHash, error, reset }` where `status` is one of `'idle' | 'switching' | 'signing' | 'pending' | 'success' | 'failed'`.

- [ ] **Step 1: Write the implementation**

Create `D:\projects\Meme4\src\hooks\useSwapExecute.js`:

```js
import { useCallback, useRef, useState } from 'react'
import { ROBINHOOD_CHAIN, STATUS_ENDPOINT } from '../lib/swap'

/** How often to ask whether the intent has settled. */
const POLL_MS = 2500

/** Give up polling after this long and tell the user to check the explorer. */
const POLL_TIMEOUT_MS = 180_000

/**
 * Executes a quote: switch chain, sign, then poll until the intent settles.
 *
 * The transaction is used exactly as the backend returned it — this hook never
 * builds calldata. That keeps a single source of truth for what gets signed and
 * means the browser cannot be talked into approving something the backend did
 * not authorise.
 */
export function useSwapExecute() {
  const [status, setStatus] = useState('idle')
  const [txHash, setTxHash] = useState(null)
  const [error, setError] = useState(null)
  const cancelled = useRef(false)

  const reset = useCallback(() => {
    cancelled.current = true
    setStatus('idle')
    setTxHash(null)
    setError(null)
  }, [])

  /** Asks the wallet to switch, adding the chain first if it is unknown. */
  const ensureChain = useCallback(async (chainId) => {
    const hex = '0x' + Number(chainId).toString(16)
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hex }],
      })
    } catch (e) {
      /* 4902 means the wallet has never heard of this chain. For Robinhood
         Chain we can add it ourselves; for anything else the user has to. */
      if (e?.code === 4902 && Number(chainId) === 4663) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [ROBINHOOD_CHAIN],
        })
        return
      }
      throw e
    }
  }, [])

  const execute = useCallback(
    async (quote) => {
      if (!quote?.tx) {
        setError(new Error('This quote has no transaction to sign.'))
        setStatus('failed')
        return
      }
      if (!window.ethereum) {
        setError(new Error('No wallet found.'))
        setStatus('failed')
        return
      }

      cancelled.current = false
      setError(null)
      setTxHash(null)

      try {
        setStatus('switching')
        await ensureChain(quote.tx.chainId)

        setStatus('signing')
        const hash = await window.ethereum.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: quote.tx.from ?? undefined,
              to: quote.tx.to,
              data: quote.tx.data,
              /* Wallets want a hex quantity; the backend carries the value as a
                 decimal string so it survives JSON without precision loss. */
              value: '0x' + BigInt(quote.tx.value || '0').toString(16),
            },
          ],
        })
        setTxHash(hash)
        setStatus('pending')

        if (!quote.requestId || !STATUS_ENDPOINT) {
          /* Signed and broadcast, but we cannot follow it. Saying "pending" for
             ever would be worse than admitting we lost sight of it. */
          setStatus('success')
          return
        }

        const deadline = Date.now() + POLL_TIMEOUT_MS
        while (!cancelled.current) {
          if (Date.now() > deadline) {
            setError(new Error('Still pending. Check the explorer for your transaction.'))
            setStatus('failed')
            return
          }
          await new Promise((r) => setTimeout(r, POLL_MS))
          if (cancelled.current) return

          let state
          try {
            const res = await fetch(
              `${STATUS_ENDPOINT}?requestId=${encodeURIComponent(quote.requestId)}`,
              { headers: { Accept: 'application/json' } },
            )
            state = await res.json()
          } catch {
            continue // a blip in polling is not a failed swap; keep trying
          }

          if (state?.status === 'success') return setStatus('success')
          if (state?.status === 'failure' || state?.status === 'refund') {
            setError(new Error(`Swap ${state.status}. Funds were returned if the deposit landed.`))
            setStatus('failed')
            return
          }
        }
      } catch (e) {
        // 4001 is the user declining in their wallet — back to idle, not an error.
        if (e?.code === 4001) {
          setStatus('idle')
          return
        }
        setError(new Error(e?.shortMessage || e?.message || 'Transaction failed.'))
        setStatus('failed')
      }
    },
    [ensureChain],
  )

  return { execute, status, txHash, error, reset }
}
```

- [ ] **Step 2: Verify it compiles and the dev server starts**

Run: `cd D:\projects\Meme4 && npx vite build`
Expected: build succeeds with no unresolved imports.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/Meme4
git add src/hooks/useSwapExecute.js
git commit -m "feat: wallet execution hook with chain switch and status polling"
```

---

### Task 7: Wire the widget

**Files:**
- Modify: `D:\projects\Meme4\src\components\SwapWidget.jsx`

**Interfaces:**
- Consumes: `useSwapExecute` from Task 6; `MIN_TRADE_USD`, `HIGH_IMPACT` from Task 5.
- Produces: no exports change — `SwapWidget({ token, scene })` is unchanged.

- [ ] **Step 1: Update the imports**

Replace the import block at the top of `SwapWidget.jsx`:

```jsx
import { useCallback, useState } from 'react'
import { useReveal } from '../hooks/useReveal'
import { useSwapQuote } from '../hooks/useSwapQuote'
import { useSwapExecute } from '../hooks/useSwapExecute'
import {
  CHAIN_DETAILS,
  HIGH_IMPACT,
  MIN_TRADE_USD,
  QUOTE_ENDPOINT,
  ROBINHOOD_CHAIN,
  SOURCE_CHAINS,
  SWAP_ENABLED,
  formatPct,
  formatToken,
  formatUsd,
} from '../lib/swap'
```

- [ ] **Step 2: Pass the account into quoting and add execution state**

Replace the `useSwapQuote` line:

```jsx
  const { quote, loading, error, retry } = useSwapQuote(amount, chain, account)
  const { execute, status, txHash, error: execError, reset } = useSwapExecute()
  const ticker = token?.ticker ?? 'PONSY'

  const busy = status === 'switching' || status === 'signing' || status === 'pending'
  const highImpact = quote && Math.abs(quote.priceImpact) >= HIGH_IMPACT
```

- [ ] **Step 3: Replace the inert action button**

Replace the whole `{account ? (...) : (...)}` block with:

```jsx
          {account ? (
            <button
              type="button"
              onClick={() => execute(quote)}
              disabled={!quote || loading || busy}
              className={
                quote && !loading && !busy
                  ? 'btn-comic mt-4 w-full text-lg sm:text-xl'
                  : 'mt-4 w-full cursor-not-allowed border-4 border-ink bg-ink/20 px-4 py-3 font-blast text-lg tracking-wide text-ink/50'
              }
              style={quote && !loading && !busy ? { backgroundColor: scene?.accent } : undefined}
            >
              {status === 'switching' && 'SWITCH NETWORK IN WALLET'}
              {status === 'signing' && 'CONFIRM IN WALLET'}
              {status === 'pending' && 'BRIDGING…'}
              {status === 'success' && 'DONE — BUY MORE'}
              {(status === 'idle' || status === 'failed') &&
                (loading ? 'PRICING…' : quote ? `BUY $${ticker}` : 'ENTER AN AMOUNT')}
            </button>
          ) : (
            <button
              type="button"
              onClick={connect}
              className="btn-comic mt-4 w-full text-lg sm:text-xl"
              style={{ backgroundColor: scene?.accent }}
            >
              CONNECT WALLET
            </button>
          )}
```

- [ ] **Step 4: Add the minimum-trade hint, impact warning and result panel**

Insert immediately after the `{account && (<p ...>CONNECTED ...</p>)}` block:

```jsx
          {/* Said before the request rather than after, so a user typing a tiny
              amount is not made to wait for a rejection they could have seen. */}
          {account && !quote && !loading && !error && (
            <p className="mt-2 text-center font-code text-[10px] font-bold tracking-wider text-ink/45">
              MINIMUM ${MIN_TRADE_USD}
            </p>
          )}

          {/* A shallow pool moves hard on size. Showing the number is not enough
              — at this level it needs to read as a warning. */}
          {highImpact && (
            <div className="mt-3 border-[3px] border-ink bg-ink/[.08] p-2.5">
              <p className="font-body text-xs font-bold text-ink">
                High price impact: {formatPct(quote.priceImpact)}
              </p>
              <p className="mt-0.5 font-body text-[11px] font-bold text-ink/60">
                You would receive noticeably less than the market rate. Try a
                smaller amount.
              </p>
            </div>
          )}

          {status === 'success' && (
            <div className="mt-3 border-[3px] border-ink bg-ink/[.06] p-2.5">
              <p className="font-body text-xs font-bold text-ink">
                Done. ${ticker} is on its way to your wallet.
              </p>
              {txHash && (
                <a
                  href={`${ROBINHOOD_CHAIN.blockExplorerUrls[0]}/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block font-code text-[10px] font-bold text-ink/60 underline"
                >
                  VIEW TRANSACTION
                </a>
              )}
            </div>
          )}

          {execError && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-[3px] border-ink bg-ink/[.06] p-2.5">
              <p className="min-w-0 font-body text-xs font-bold text-ink/75">
                {execError.message}
              </p>
              <button
                type="button"
                onClick={reset}
                className="btn-comic shrink-0 !px-3 !py-1.5 text-sm"
                style={{ backgroundColor: scene?.accent }}
              >
                DISMISS
              </button>
            </div>
          )}
```

- [ ] **Step 5: Remove the stale gas row and add estimated time**

In the breakdown `dl`, replace the `'Gas delivered to you'` row — Relay does not deliver gas on this route, so the row would state something untrue — with the time estimate:

```jsx
                ['Estimated time', `${quote.timeEstimate || 3}s`],
```

- [ ] **Step 6: Update `useSwapQuote` to accept the account**

In `D:\projects\Meme4\src\hooks\useSwapQuote.js`, change the signature and the fetch call and dependency list:

```js
export function useSwapQuote(amount, chain, account) {
```

```js
      fetchQuote({ amount: n, chain, account, signal: ac.signal })
```

```js
  }, [amount, chain, attempt, account])
```

Also change the early return so no request is made without a wallet:

```js
    const n = Number(amount)
    if (!n || n <= 0 || !account) {
```

- [ ] **Step 7: Build and check by hand**

Run: `cd D:\projects\Meme4 && npm test && npx vite build`
Expected: tests pass, build succeeds.

Then create `D:\projects\Meme4\.env` with:

```ini
VITE_STATS_URL=https://api.ponsy.fun/stats
VITE_QUOTE_URL=https://api.ponsy.fun/quote
```

Run `npm run dev`, then in the browser:
1. The swap section renders and `PREVIEW PRICING` is gone.
2. `CONNECT WALLET` connects.
3. Typing `0.0001` shows the `MINIMUM $25` hint or a minimum error.
4. Typing `0.02` shows a real quote — roughly 280,000–290,000 PONSY, impact around −5%.
5. `BUY $PONSY` prompts a network switch then a signature. **Reject it** — the button must return to `BUY $PONSY` with no error shown.

- [ ] **Step 8: Commit**

```bash
cd D:/projects/Meme4
git add src/components/SwapWidget.jsx src/hooks/useSwapQuote.js
git commit -m "feat: wire swap execution, minimum and impact warning"
```

---

### Task 8: Ship it

**Files:**
- Modify: `D:\projects\Meme4\.env.example`

**Interfaces:** none.

- [ ] **Step 1: Document the new variable**

In `D:\projects\Meme4\.env.example`, replace the `VITE_QUOTE_URL` block:

```ini
# Swap quote endpoint on the Ponsy backend. Leave unset and the widget refuses
# to price rather than inventing a rate.
VITE_QUOTE_URL=https://api.ponsy.fun/quote
```

- [ ] **Step 2: Execute one real swap for the smallest allowed amount**

This is the only step that proves the whole path. Using a wallet holding ETH on Base, buy the minimum ($25). Confirm:
- the wallet switches to Base
- the transaction is signed and broadcast
- the button moves to `BRIDGING…` then `DONE`
- PONSY arrives at the wallet on Robinhood Chain within ~30 seconds
- `https://robinhoodchain.blockscout.com/address/<your wallet>` shows the token

If it fails, stop and diagnose before deploying. `pm2 logs ponsy-stats` on the server shows what `/quote` returned.

- [ ] **Step 3: Push and deploy the frontend**

```bash
cd D:/projects/Meme4
git add .env.example
git commit -m "docs: VITE_QUOTE_URL"
git push
```

In Netlify, add the environment variable:

```
VITE_QUOTE_URL = https://api.ponsy.fun/quote
```

Then **Deploys → Trigger deploy → Clear cache and deploy site**. The rebuild is mandatory: Vite inlines `import.meta.env` at build time.

- [ ] **Step 4: Verify the live bundle**

```bash
B=$(curl -s https://ponsy.fun/ | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1)
curl -s "https://ponsy.fun$B" > /tmp/live.js
grep -c "api.ponsy.fun/quote" /tmp/live.js   # expect 1
grep -c "385862278" /tmp/live.js             # expect 0 — the mock must be gone
grep -c "PREVIEW PRICING" /tmp/live.js       # expect 0
```

The second check is the important one. A non-zero result means the mock rate shipped and the widget can quote roughly 24x the real amount.

---

## Out of Scope

- **Solana.** Needs `@solana/wallet-adapter`, a second signing path, and a different Relay chain id (`792703809`). Also note Relay returned `NO_SWAP_ROUTES_FOUND` for SPL-token origins such as Solana USDC — only native SOL routes. Separate spec, separate plan.
- **Selling PONSY back out.** The reverse direction quotes fine but needs an ERC-20 approval step before the deposit, which is a second signature and a different UI state machine.
- **ERC-20 source assets** (USDC on Ethereum/BNB). Same approval problem. Native ETH only in v1.
- **User-selectable slippage.** The PDF offers 0.5% / 1% / 2% / custom. v1 uses Relay's default destination tolerance (2%), which is what `minReceived` already reflects — so the protection exists, it just is not adjustable. Adding the control means threading a `slippageTolerance` parameter through `/quote`.
- **App fees.** `fetchRelayQuote` already accepts `appFees` and the backend returns `fees.app` in `feeUsd`; wiring a revenue share is a follow-up.
