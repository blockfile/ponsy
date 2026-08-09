# Network + Token Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a buyer pick a network, then a token on that network — adding USDC and USDT alongside the native assets — and execute the resulting multi-step (approve, then deposit) swap safely.

**Architecture:** The backend gains a server-side token allowlist keyed by network and returns Relay's full `steps` array instead of a single transaction. The frontend gains a second selector and executes steps in sequence through the existing signing code, with `approve` explicitly exempt from the fund-movement guards because it moves no funds.

**Tech Stack:** Node 20+ ESM, Express, `node:test` (backend); React 18 + Vite, Vitest (frontend). No new dependencies.

**Design:** `docs/superpowers/specs/2026-08-09-token-selection-design.md`

## Global Constraints

- **PONSY is exactly `0x2E84F2E0b88BD3FFB5D6738aE0e3C7c00137083E` on chain `4663`.** The destination is fixed server-side and never client-supplied, on every path.
- **The origin token is also chosen server-side, from an allowlist.** A client-supplied token address is a route into an impostor, exactly like a client-supplied destination. The request names a token by **key** (`"usdc"`), never by address.
- **`approve` moves no funds.** It must NOT set `maybeSentRef` and must NOT mark the swap `unresolved`. The exemption keys on the step id being exactly `approve`; every other step id gets the strict fund-movement treatment.
- **Solana is native SOL only.** SPL tokens return `NO_SWAP_ROUTES_FOUND` from Relay for every destination. Reject them before calling Relay.
- **Relay approves the exact trade amount**, not `uint256` max. Do not modify the approval calldata.
- **Both step shapes are identical** to what the EVM path already signs: `from, to, data, value, chainId, gas, maxFeePerGas, maxPriorityFeePerGas`. Reuse `buildTxParams`; do not write a second builder.
- Token decimals differ: USDC/USDT are **6** on Ethereum/Base/Arbitrum/Optimism, **18** on BNB Chain. Getting this wrong is a 10¹² error.
- Add no npm dependencies.

---

## File Structure

**Backend — `d:\projects\ponsy`** (branch `swap-quote-api`)

| File | Responsibility |
| --- | --- |
| `src/tokens.js` | CREATE. The allowlist: per-network token key → address, decimals, symbol. |
| `src/quote.js` | MODIFY. Accept a `token` key, resolve it, scale by its decimals, return `steps`. |
| `test/tokens.test.js` | CREATE. |
| `test/quote.test.js` | MODIFY. |

**Frontend — `D:\projects\Meme4`** (branch `swap`)

| File | Responsibility |
| --- | --- |
| `src/lib/swap.js` | MODIFY. `TOKENS_BY_CHAIN`, `tokensFor(chainId)`; forward `token`; carry `steps`. |
| `src/hooks/useSwapExecute.js` | MODIFY. Execute steps in sequence; exempt `approve`. |
| `src/hooks/useSwapQuote.js` | MODIFY. `token` as a parameter and dependency. |
| `src/components/SwapWidget.jsx` | MODIFY. Network selector + token selector; two-transaction warning. |
| `src/lib/swap.test.js` | MODIFY. |

---

### Task 1: The token allowlist (backend)

**Files:**
- Create: `d:\projects\ponsy\src\tokens.js`
- Create: `d:\projects\ponsy\test\tokens.test.js`

**Interfaces:**
- Produces: `TOKENS_BY_CHAIN` (object keyed by chain id); `resolveToken(chainId, key) -> { key, symbol, address, decimals }` which **throws** on an unknown chain or key; `tokensFor(chainId) -> array`.

- [ ] **Step 1: Write the failing test**

Create `d:\projects\ponsy\test\tokens.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveToken, tokensFor, TOKENS_BY_CHAIN } from '../src/tokens.js'

const NATIVE = '0x0000000000000000000000000000000000000000'

test('every network offers its native asset first', () => {
  for (const [chainId, list] of Object.entries(TOKENS_BY_CHAIN)) {
    assert.equal(list[0].key, 'native', `chain ${chainId} must list native first`)
    assert.ok(list[0].symbol, `chain ${chainId} native needs a symbol`)
  }
})

test('resolves native to the zero address on EVM chains', () => {
  assert.equal(resolveToken(8453, 'native').address, NATIVE)
  assert.equal(resolveToken(8453, 'native').decimals, 18)
  assert.equal(resolveToken(56, 'native').symbol, 'BNB')
})

test('resolves SOL to its mint, with 9 decimals', () => {
  const sol = resolveToken(792703809, 'native')
  assert.equal(sol.address, '11111111111111111111111111111111')
  assert.equal(sol.decimals, 9)
  assert.equal(sol.symbol, 'SOL')
})

test('USDC is 6 decimals on Base but 18 on BNB Chain', () => {
  /* Getting this backwards is a 10^12 error in the amount sent to Relay —
     the single most expensive mistake available in this file. */
  assert.equal(resolveToken(8453, 'usdc').decimals, 6)
  assert.equal(resolveToken(56, 'usdc').decimals, 18)
})

test('Solana offers native only — SPL tokens do not route', () => {
  assert.deepEqual(tokensFor(792703809).map((t) => t.key), ['native'])
  assert.throws(() => resolveToken(792703809, 'usdc'), /not available/)
})

test('rejects an unknown token key rather than falling back to native', () => {
  assert.throws(() => resolveToken(8453, 'ponzi'), /not available/)
  assert.throws(() => resolveToken(8453, ''), /not available/)
  assert.throws(() => resolveToken(8453, undefined), /not available/)
})

test('rejects an unknown chain', () => {
  assert.throws(() => resolveToken(137, 'native'), /not supported/)
})

test('a caller cannot inject an address — only keys are accepted', () => {
  assert.throws(
    () => resolveToken(8453, '0xd314ee5350570e57c8e2e5bb6b3920cd1a16083e'),
    /not available/,
  )
})

test('every listed address is a plausible identifier for its VM', () => {
  const EVM_RE = /^0x[0-9a-fA-F]{40}$/
  const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
  for (const [chainId, list] of Object.entries(TOKENS_BY_CHAIN)) {
    for (const t of list) {
      const ok = Number(chainId) === 792703809 ? B58_RE.test(t.address) : EVM_RE.test(t.address)
      assert.ok(ok, `chain ${chainId} token ${t.key} has a malformed address: ${t.address}`)
      assert.ok(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 18)
    }
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\projects\ponsy && npm test`
Expected: FAIL — `Cannot find module '../src/tokens.js'`

- [ ] **Step 3: Write the implementation**

Create `d:\projects\ponsy\src\tokens.js`:

```js
/**
 * ORIGIN TOKEN ALLOWLIST
 * -----------------------------------------------------------------------------
 * Which tokens a visitor may pay with, per network.
 *
 * Requests name a token by KEY ("usdc"), never by address. The same reasoning
 * that fixes the destination token server-side applies here: an address taken
 * from the request is a way to route someone's money through a token we never
 * vetted. Keys are a closed set; addresses are not.
 *
 * Every address below was confirmed to route to PONSY against the live Relay
 * API on 2026-08-09. Solana lists native SOL alone — SPL tokens return
 * NO_SWAP_ROUTES_FOUND for every destination, so offering them would be a
 * false choice rather than a limitation of this file.
 */

const NATIVE = '0x0000000000000000000000000000000000000000'
const SOL_MINT = '11111111111111111111111111111111'

/**
 * Note the decimals. USDC and USDT are 6 decimals on the Ethereum-family
 * chains but 18 on BNB Chain, where they are BEP-20 re-issues rather than
 * bridged originals. Using the wrong one scales the amount by 10^12.
 */
export const TOKENS_BY_CHAIN = {
  8453: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  ],
  1: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { key: 'usdt', symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  ],
  42161: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    { key: 'usdt', symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  ],
  10: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    { key: 'usdt', symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
  ],
  56: [
    { key: 'native', symbol: 'BNB', address: NATIVE, decimals: 18 },
    { key: 'usdt', symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  ],
  4663: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
  ],
  792703809: [
    { key: 'native', symbol: 'SOL', address: SOL_MINT, decimals: 9 },
  ],
}

/** The tokens offered on a network, native first. Empty for an unknown chain. */
export function tokensFor(chainId) {
  return TOKENS_BY_CHAIN[Number(chainId)] ?? []
}

/**
 * Resolves a token key on a network.
 *
 * Throws rather than defaulting to native: a caller asking for a token we do
 * not offer has a bug or is probing, and silently swapping in a different
 * asset than they named is the worst possible answer to either.
 */
export function resolveToken(chainId, key) {
  const list = tokensFor(chainId)
  if (list.length === 0) throw new Error(`chain ${chainId} is not supported`)

  const found = list.find((t) => t.key === key)
  if (!found) {
    const offered = list.map((t) => t.key).join(', ')
    throw new Error(`token "${key}" is not available on chain ${chainId} (offered: ${offered})`)
  }
  return found
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd d:\projects\ponsy && npm test`
Expected: PASS — 9 new tests; all 153 existing still passing.

- [ ] **Step 5: Verify every address routes, against the real Relay API**

```bash
cd d:/projects/ponsy
node -e "
import('./src/tokens.js').then(async ({TOKENS_BY_CHAIN}) => {
  for (const [chainId, list] of Object.entries(TOKENS_BY_CHAIN)) {
    for (const t of list) {
      const user = Number(chainId) === 792703809
        ? 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'
        : '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E'
      const amount = (10n ** BigInt(t.decimals) * 40n / (t.key === 'native' ? 2000n : 1n)).toString()
      const r = await fetch('https://api.relay.link/quote', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          user, recipient: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
          originChainId: Number(chainId), destinationChainId: 4663,
          originCurrency: t.address,
          destinationCurrency: '0x2E84F2E0b88BD3FFB5D6738aE0e3C7c00137083E',
          amount, tradeType: 'EXACT_INPUT',
        }), signal: AbortSignal.timeout(60000),
      })
      const j = await r.json()
      const steps = (j.steps||[]).map(s=>s.id).join('+')
      console.log(\`  \${chainId} \${t.key.padEnd(7)} \${j.errorCode ?? steps}\`)
    }
  }
})
"
```

Every row must show `deposit`, `approve+deposit`, or `swap` — **no `NO_SWAP_ROUTES_FOUND`**. If any address fails, correct it before committing; a wrong address here is a token nobody can buy with.

- [ ] **Step 6: Commit**

```bash
cd d:/projects/ponsy
git add src/tokens.js test/tokens.test.js
git commit -m "feat: allowlist the tokens a visitor may pay with, per network"
```

---

### Task 2: Token-aware quotes and multi-step responses (backend)

**Files:**
- Modify: `d:\projects\ponsy\src\quote.js`
- Modify: `d:\projects\ponsy\src\server.js`
- Modify: `d:\projects\ponsy\test\quote.test.js`

**Interfaces:**
- Consumes: `resolveToken` from Task 1.
- Produces: `getQuote({ user, chainId, amount, recipient, token })` where `token` defaults to `'native'`. The response gains `steps: [{ id, tx }]` and `token: { key, symbol, decimals }`. `tx`/`solanaTx` remain for single-step quotes so nothing already working breaks.

- [ ] **Step 1: Write the failing test**

Append to `d:\projects\ponsy\test\quote.test.js`:

```js
import { RELAY_APPROVE_QUOTE } from './fixtures.js'

test('defaults to the native asset when no token is named', async () => {
  const fetchImpl = ok()
  await createQuoteService({ config: config(), fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 8453, amount: '0.02',
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.originCurrency, '0x0000000000000000000000000000000000000000')
})

test('sends the allowlisted address for a named token', async () => {
  const fetchImpl = ok()
  await createQuoteService({ config: config(), fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 8453, amount: '40', token: 'usdc',
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.originCurrency, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
})

test('scales by the token decimals, not by 18', async () => {
  /* USDC is 6 decimals. Scaling 40 by 18 would send 4e19 instead of 4e7 —
     a 10^12 error. */
  const fetchImpl = ok()
  await createQuoteService({ config: config(), fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 8453, amount: '40', token: 'usdc',
  })
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).amount, '40000000')
})

test('uses 18 decimals for USDC on BNB Chain, where it is a BEP-20 re-issue', async () => {
  const fetchImpl = ok()
  await createQuoteService({ config: config(), fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 56, amount: '40', token: 'usdc',
  })
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).amount, '40000000000000000000')
})

test('refuses a token address supplied by the caller', async () => {
  await assert.rejects(
    () => createQuoteService({ config: config(), fetchImpl: ok(), blockhash: stubBlockhash }).getQuote({
      user: USER, chainId: 8453, amount: '40',
      token: '0xd314ee5350570e57c8e2e5bb6b3920cd1a16083e',
    }),
    /not available/,
  )
})

test('refuses an SPL token on Solana before calling Relay', async () => {
  const fetchImpl = ok()
  await assert.rejects(
    () => createQuoteService({ config: config(), fetchImpl, blockhash: stubBlockhash }).getQuote({
      user: SOL_PAYER, chainId: 792703809, amount: '1',
      recipient: EVM_RECIPIENT, token: 'usdc',
    }),
    /not available/,
  )
  assert.equal(fetchImpl.calls.length, 0, 'must not reach Relay')
})

test('returns every step for a two-step quote, in order', async () => {
  const svc = createQuoteService({
    config: config(),
    fetchImpl: stubFetch([['/quote', async () => RELAY_APPROVE_QUOTE]]),
    blockhash: stubBlockhash,
  })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '40', token: 'usdc' })

  assert.equal(q.steps.length, 2)
  assert.deepEqual(q.steps.map((s) => s.id), ['approve', 'deposit'])
  assert.equal(q.steps[0].tx.to, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  assert.equal(q.steps[1].tx.to, '0x4cd00e387622c35bddb9b4c962c136462338bc31')
})

test('a single-step quote still carries tx, so existing clients keep working', async () => {
  const svc = createQuoteService({ config: config(), fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })

  assert.equal(q.steps.length, 1)
  assert.equal(q.steps[0].id, 'deposit')
  assert.ok(q.tx, 'tx must remain for single-step quotes')
  assert.equal(q.tx.to, q.steps[0].tx.to)
})

test('reports the resolved token so the UI can label the amount', async () => {
  const svc = createQuoteService({ config: config(), fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '40', token: 'usdc' })
  assert.equal(q.token.symbol, 'USDC')
  assert.equal(q.token.decimals, 6)
})
```

Add the two-step fixture to `d:\projects\ponsy\test\fixtures.js`:

```js
/**
 * POST /quote — 40 USDC on Base -> PONSY. Captured 2026-08-09.
 *
 * Note both steps are `kind: "transaction"`: the approval is an on-chain
 * transaction, not a signature, and it approves the exact trade amount
 * (40000000) rather than uint256 max.
 */
export const RELAY_APPROVE_QUOTE = {
  steps: [
    {
      id: 'approve',
      kind: 'transaction',
      requestId: '0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899',
      items: [{
        status: 'incomplete',
        data: {
          from: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
          to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          data: '0x095ea7b30000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc310000000000000000000000000000000000000000000000000000000002625a00',
          value: '0', chainId: 8453, gas: 60000,
        },
        check: { endpoint: '/intents/status?requestId=0xaa11bb22', method: 'GET' },
      }],
    },
    {
      id: 'deposit',
      kind: 'transaction',
      requestId: '0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899',
      items: [{
        status: 'incomplete',
        data: {
          from: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
          to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
          data: '0xe80179520000000000000000000000002dfec17b1d8dce43cb5b1111352fd58be01d389e',
          value: '0', chainId: 8453, gas: 180000,
        },
        check: { endpoint: '/intents/status?requestId=0xaa11bb22', method: 'GET' },
      }],
    },
  ],
  fees: { gas: { amountUsd: '0.02' }, relayer: { amountUsd: '0.35' }, app: { amountUsd: '0' } },
  details: {
    operation: 'swap',
    currencyIn: {
      currency: { chainId: 8453, symbol: 'USDC', decimals: 6 },
      amount: '40000000', amountFormatted: '40', amountUsd: '39.99',
    },
    currencyOut: {
      currency: { chainId: 4663, address: '0x2e84f2e0b88bd3ffb5d6738ae0e3c7c00137083e', symbol: 'PONSY', decimals: 18 },
      amount: '300000000000000000000000', amountFormatted: '300000', amountUsd: '34.61',
      minimumAmount: '294000000000000000000000',
    },
    totalImpact: { usd: '-5.38', percent: '-13.45' },
    swapImpact: { usd: '-5.00', percent: '-12.50' },
    timeEstimate: 4,
  },
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\projects\ponsy && npm test`
Expected: FAIL — `token` is ignored, so the USDC address assertion fails.

- [ ] **Step 3: Write the implementation**

In `d:\projects\ponsy\src\quote.js`, import the resolver:

```js
import { resolveToken } from './tokens.js'
```

Replace `originCurrencyFor(origin)` and the amount scaling. After the chain allowlist check, resolve the token once:

```js
    /* Resolved from a closed set of keys, never from an address in the
       request. See src/tokens.js for why. */
    const originToken = resolveToken(origin, token ?? 'native')
```

Then use it in the Relay request:

```js
        originCurrency: originToken.address,
        amount: toUnits(amount, originToken.decimals),
```

where `toUnits` is the existing exact-integer parser generalised — `toWei` already takes a `decimals` parameter, so:

```js
/** Decimal string -> smallest units for a token of the given decimals. */
function toUnits(amount, decimals) {
  return toWei(amount, decimals)
}
```

Delete `originCurrencyFor`, `NATIVE` and `SOL_CURRENCY` from `quote.js` — they now live in `tokens.js`. Keep `SOLANA_CHAIN_ID`, which is still used for VM branching.

Replace the single-`txField` construction with a steps array. Where the EVM branch currently builds `txField`, build every step:

```js
      const rawSteps = raw?.steps ?? []
      if (rawSteps.length === 0) throw new Error('Relay returned no steps to sign')

      const steps = rawSteps.map((s) => {
        const d = s?.items?.[0]?.data
        if (!d?.to) throw new Error(`Relay step "${s?.id}" has no transaction to sign`)
        if (!d?.from) throw new Error(`Relay step "${s?.id}" has no sending account`)
        return {
          id: s.id,
          tx: {
            from: d.from,
            to: d.to,
            data: d.data,
            value: String(d.value ?? '0'),
            chainId: d.chainId,
            ...(parseGasLimit(d.gas) !== undefined ? { gas: parseGasLimit(d.gas) } : {}),
          },
        }
      })

      /* `tx` is retained for single-step quotes so a client that predates the
         steps array keeps working. A multi-step quote deliberately omits it:
         such a client must fail loudly rather than sign the approval and stop,
         leaving the user having paid gas for nothing. */
      txField = steps.length === 1 ? { steps, tx: steps[0].tx } : { steps }
```

Add the resolved token to the returned object:

```js
      token: { key: originToken.key, symbol: originToken.symbol, decimals: originToken.decimals },
```

- [ ] **Step 4: Forward the parameter**

In `d:\projects\ponsy\src\server.js`'s `/quote` route, add `token` alongside the existing four:

```js
        token: req.query.token,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd d:\projects\ponsy && npm test`
Expected: PASS — 9 new tests; all previous still passing.

- [ ] **Step 6: Verify against the real Relay API over HTTP**

```bash
cd d:/projects/ponsy
TOKEN_ADDRESS=0x2E84F2E0b88BD3FFB5D6738aE0e3C7c00137083E PORT=8821 node src/index.js &
sleep 4
echo "--- native, one step ---"
curl -s "http://127.0.0.1:8821/quote?amount=0.02&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E"
echo; echo "--- USDC, two steps ---"
curl -s "http://127.0.0.1:8821/quote?amount=40&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E&token=usdc"
echo; echo "--- SPL on Solana, must refuse ---"
curl -s "http://127.0.0.1:8821/quote?amount=1&chainId=792703809&user=GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ&recipient=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E&token=usdc"
```

Expect: one step with `tx` present; two steps (`approve`, `deposit`) with `tx` **absent**; and a 400 naming the unavailable token. Kill the server — check `Get-NetTCPConnection -LocalPort 8821` and stop the owning process, since a backgrounded node survives a shell `kill` on Windows.

- [ ] **Step 7: Commit**

```bash
cd d:/projects/ponsy
git add src/quote.js src/server.js test/quote.test.js test/fixtures.js
git commit -m "feat: quote any allowlisted origin token, returning every step"
```

---

### Task 3: Token list and quote plumbing (frontend)

**Files:**
- Modify: `D:\projects\Meme4\src\lib\swap.js`
- Modify: `D:\projects\Meme4\src\hooks\useSwapQuote.js`
- Modify: `D:\projects\Meme4\src\lib\swap.test.js`

**Interfaces:**
- Produces: `TOKENS_BY_CHAIN`, `tokensFor(chainId) -> array`; `fetchQuote` gains a `token` option; `normaliseQuote` carries `steps` and `token`; `useSwapQuote(amount, chain, account, recipient, token)`.

- [ ] **Step 1: Write the failing test**

Append to `D:\projects\Meme4\src\lib\swap.test.js`:

```js
import { tokensFor, TOKENS_BY_CHAIN, SOLANA_CHAIN_ID } from './swap'

describe('token lists', () => {
  it('offers native first on every network', () => {
    for (const [chainId, list] of Object.entries(TOKENS_BY_CHAIN)) {
      expect(list[0].key, `chain ${chainId}`).toBe('native')
    }
  })

  it('mirrors the backend: USDC on Base, none on Solana', () => {
    expect(tokensFor(8453).map((t) => t.key)).toContain('usdc')
    expect(tokensFor(SOLANA_CHAIN_ID).map((t) => t.key)).toEqual(['native'])
  })

  it('returns an empty list for an unknown chain rather than throwing', () => {
    expect(tokensFor(137)).toEqual([])
  })

  it('every source chain has at least one token', () => {
    for (const c of SOURCE_CHAINS) {
      expect(tokensFor(c.id).length, `chain ${c.id}`).toBeGreaterThan(0)
    }
  })
})

describe('fetchQuote token', () => {
  it('sends the token key when it is not native', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    await fetchQuote({
      amount: 40, chain: { id: 8453 }, account: '0xabc', token: 'usdc',
      endpoint: 'https://q.test', fetchImpl,
    })
    expect(fetchImpl.mock.calls[0][0]).toContain('token=usdc')
  })

  it('omits the token entirely when it is native', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    await fetchQuote({
      amount: 0.02, chain: { id: 8453 }, account: '0xabc', token: 'native',
      endpoint: 'https://q.test', fetchImpl,
    })
    expect(fetchImpl.mock.calls[0][0]).not.toContain('token=')
  })
})

describe('normaliseQuote steps', () => {
  it('carries the steps array and the resolved token', () => {
    const q = normaliseQuote({
      ...BACKEND,
      steps: [{ id: 'approve', tx: { to: '0xA' } }, { id: 'deposit', tx: { to: '0xB' } }],
      token: { key: 'usdc', symbol: 'USDC', decimals: 6 },
    })
    expect(q.steps.map((s) => s.id)).toEqual(['approve', 'deposit'])
    expect(q.token.symbol).toBe('USDC')
  })

  it('defaults steps to an empty array rather than undefined', () => {
    expect(normaliseQuote({}).steps).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:\projects\Meme4 && npm test`
Expected: FAIL — `tokensFor` is not exported.

- [ ] **Step 3: Write the implementation**

In `D:\projects\Meme4\src\lib\swap.js`, add the list. It mirrors the backend's allowlist for **labels only** — the backend resolves the address, so a drift here shows a wrong symbol, never a wrong token:

```js
/**
 * Tokens offered per network, for labelling the selector.
 *
 * The backend resolves the actual address from its own allowlist, so this list
 * is presentational: a drift here mislabels a dropdown, it cannot route a
 * payment through the wrong token. Keys must match the backend's.
 */
export const TOKENS_BY_CHAIN = {
  8453: [{ key: 'native', symbol: 'ETH' }, { key: 'usdc', symbol: 'USDC' }],
  1: [{ key: 'native', symbol: 'ETH' }, { key: 'usdc', symbol: 'USDC' }, { key: 'usdt', symbol: 'USDT' }],
  42161: [{ key: 'native', symbol: 'ETH' }, { key: 'usdc', symbol: 'USDC' }, { key: 'usdt', symbol: 'USDT' }],
  10: [{ key: 'native', symbol: 'ETH' }, { key: 'usdc', symbol: 'USDC' }, { key: 'usdt', symbol: 'USDT' }],
  56: [{ key: 'native', symbol: 'BNB' }, { key: 'usdt', symbol: 'USDT' }, { key: 'usdc', symbol: 'USDC' }],
  4663: [{ key: 'native', symbol: 'ETH' }],
  [SOLANA_CHAIN_ID]: [{ key: 'native', symbol: 'SOL' }],
}

/** Tokens on a network, native first. Empty for an unknown chain. */
export function tokensFor(chainId) {
  return TOKENS_BY_CHAIN[Number(chainId)] ?? []
}
```

Extend `fetchQuote`'s destructuring with `token`, and append it only when it is a non-native key:

```js
    (token && token !== 'native' ? `&token=${encodeURIComponent(token)}` : '')
```

Add to `normaliseQuote`:

```js
    steps: Array.isArray(raw?.steps) ? raw.steps : [],
    token: raw?.token ?? null,
```

In `D:\projects\Meme4\src\hooks\useSwapQuote.js`, add `token` as the fifth parameter, pass it to `fetchQuote`, and add it to the effect's dependency array so changing the token re-quotes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd D:\projects\Meme4 && npm test && npm run build`
Expected: PASS — 8 new tests; all 62 existing still passing; build clean.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/Meme4
git add src/lib/swap.js src/hooks/useSwapQuote.js src/lib/swap.test.js
git commit -m "feat: offer a token list per network and forward the choice"
```

---

### Task 4: Multi-step execution (frontend)

**Files:**
- Modify: `D:\projects\Meme4\src\hooks\useSwapExecute.js`

**Interfaces:**
- Consumes: `quote.steps` from Task 3.
- Produces: no signature change — `execute(quote)` handles one or many steps.

**This is the task the whole plan exists to get right.** Every guard in this file was added because review found a specific defect; four of them were Critical. Read the file before changing it.

- [ ] **Step 1: Execute steps in sequence**

Replace the single EVM send with a loop over `quote.steps`, falling back to a one-element array built from `quote.tx` when `steps` is absent, so an older quote shape still works.

For each step, in order:

1. `buildTxParams(step.tx)` — the **existing** builder. Do not write a second one.
2. Verify the chain, exactly as today, before the first step only — all steps share a chain.
3. Re-check the run token before each step, as the existing resumption-point discipline requires.
4. Send via `eth_sendTransaction`.
5. **Wait for the receipt before starting the next step.** An approval that has not been mined yet will make the deposit revert. Poll `eth_getTransactionReceipt` until it returns a receipt with `status: '0x1'`, and abort the sequence on `status: '0x0'`.

- [ ] **Step 2: Exempt `approve` from the fund-movement guards**

```js
        /* `approve` grants permission for exactly the trade amount and moves
           nothing. Setting maybeSentRef here would report a failed *deposit*
           as "may already have been sent" when the only thing that happened
           was an approval; marking it unresolved would lock the buy button
           after a SUCCESSFUL approval, before the deposit ever ran.
           The test keys on the id being exactly `approve`, so any other step
           shape from Relay gets the strict treatment by default. */
        const movesFunds = step.id !== 'approve'
        if (movesFunds) maybeSentRef.current = true
        const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [params] })
        if (movesFunds) maybeSentRef.current = false
```

Only a fund-moving step sets `txHash`. An approval's hash must not populate the transaction panel, or an approved-but-not-deposited swap would render as an in-flight deposit.

- [ ] **Step 3: Report progress across steps**

While a multi-step sequence runs, the status must say which step is in flight — the existing `signing` status is reused, but the widget needs to know it is on step 1 of 2. Expose `stepIndex` and `stepCount` from the hook alongside `status`, defaulting to `0`/`1` for single-step quotes.

- [ ] **Step 4: Verify**

Run: `cd D:\projects\Meme4 && npm test && npm run build`

Then re-read the diff and confirm each of these, which prior reviews established as load-bearing:
- `running` is still set synchronously before the first `await`.
- The run token is still checked at every resumption point — there are now more of them.
- `setTxHash` is still unconditional for the fund-moving step.
- A failure on the deposit leaves the button **recoverable**, not locked as possibly-sent, because nothing was deposited.
- All seven statuses still render a non-empty label and every terminal status still has an exit.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/Meme4
git add src/hooks/useSwapExecute.js
git commit -m "feat: execute multi-step swaps, exempting approve from the fund guards"
```

---

### Task 5: The two-level selector (frontend)

**Files:**
- Modify: `D:\projects\Meme4\src\components\SwapWidget.jsx`

**Interfaces:**
- Consumes: `tokensFor` (Task 3); `stepIndex`/`stepCount` (Task 4).

- [ ] **Step 1: Add the token selector**

The existing chain `<select>` at `SwapWidget.jsx:449` stays as the **network** selector. Add a second `<select>` for the token, populated from `tokensFor(chain.id)`, replacing the static native-symbol chip beside the amount input.

Disable the token selector when `tokensFor(chain.id).length === 1` — on Solana and Robinhood Chain it holds a single entry, and a dropdown that cannot change is worse than a label.

Reset the token to `'native'` whenever the network changes. A user on Base with USDC selected who switches to Solana must not be left holding a token that network does not offer.

- [ ] **Step 2: Warn before the first prompt**

When the selected token is not native, show — **above** the buy button, before anything is signed:

> This takes 2 transactions: approve, then swap.

Two unexplained wallet popups is how people abandon a swap halfway, having already paid approval gas. The warning must be visible before the first prompt, not between them.

- [ ] **Step 3: Show step progress**

While `stepCount > 1` and a swap is in flight, the button label must name the step — for example `APPROVING (1 OF 2)` then `SWAPPING (2 OF 2)`. Keep every existing label for single-step swaps exactly as it is.

- [ ] **Step 4: Verify**

Run: `cd D:\projects\Meme4 && npm test && npm run build`

Then, with the backend running locally, check by hand:
- Selecting Base shows ETH and USDC; selecting Solana shows SOL alone, disabled.
- Switching from Base/USDC to Solana resets the token to SOL.
- Choosing USDC shows the two-transaction warning before any prompt.
- A native swap is unchanged — one prompt, existing labels.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/Meme4
git add src/components/SwapWidget.jsx
git commit -m "feat: choose a network, then a token on it"
```

---

### Task 6: Live verification

**Files:** none — verification only.

- [ ] **Step 1: Quote every allowlisted token over HTTP**

With the backend running locally, request a quote for every token on every network. Record for each: HTTP status, `amountInUsd`, the step ids, and whether `tx` is present. Native tokens must return one step with `tx`; USDC/USDT must return `approve` + `deposit` with `tx` absent.

- [ ] **Step 2: Confirm the decimals are right on the wire**

For each non-native token, assert the `amount` sent to Relay matches the token's decimals — `40` USDC on Base must appear as `40000000`, and on BNB Chain as `40000000000000000000`. This is the 10¹² error; a quote that returns successfully with the wrong scaling looks entirely normal.

- [ ] **Step 3: Record what remains unproven**

State explicitly that no multi-step swap has been executed, and that the approve-then-deposit sequence — including the receipt wait between steps — is confirmed only by a real token swap. Do not describe the feature as working end to end on the strength of quote-level verification.

---

## Out of Scope

- **Selling PONSY into other assets** — the multi-destination direction. Needs an approval on Robinhood Chain and a destination selector; a separate feature.
- **SPL tokens on Solana** — the route does not exist upstream.
- **Free-form token entry** — the allowlist is deliberate; arbitrary addresses reintroduce the impostor risk the destination lock exists to prevent.
- **Permit / EIP-2612 signatures** in place of an approval transaction — Relay returns a transaction, and second-guessing that is a larger change than this feature warrants.
