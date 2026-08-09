# Solana Swap Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone holding SOL on Solana buy $PONSY on Robinhood Chain in one signature, paying from Phantom/Solflare and receiving at their already-connected MetaMask address.

**Architecture:** The backend accepts a Solana origin, takes Relay's instruction, assembles a complete legacy Solana transaction with a fresh blockhash, and returns it base64-encoded as `solanaTx` instead of the EVM `tx`. The frontend deserializes it and hands it to the injected Solana wallet. Quote rendering, the minimum, the impact warning, the execution guards and the status-polling loop are all reused unchanged.

**Tech Stack:** Node 20+ ESM, Express, `node:test` (backend); React 18 + Vite, Vitest (frontend); `@solana/web3.js`; Relay REST API; raw injected wallet providers.

**Design:** `docs/superpowers/specs/2026-08-09-solana-source-design.md`

## Global Constraints

- **PONSY is exactly `0x2E84F2E0b88BD3FFB5D6738aE0e3C7c00137083E` on chain `4663`.** Never accepted from the client, on any path.
- **Solana chain id is `792703809`; SOL's currency identifier is `11111111111111111111111111111111`.** Relay's numbering, verified live.
- **Native SOL only.** SPL-token origins return `NO_SWAP_ROUTES_FOUND` from Relay for every destination. Reject them before calling Relay.
- **Relay's instruction `data` is hex with no `0x` prefix** — 48 bytes for a deposit. Verified: `0d9e0ddf5fd51c0680b2e60e00000000…`, with `80b2e60e` at byte offset 8 being 250,000,000 lamports little-endian.
- **Payer and recipient are different addresses by necessity.** A Solana keypair has no EVM address. `user` is base58, `recipient` is `0x`. Neither is ever derived from the other.
- **Build a LEGACY transaction, not v0.** All six accounts are explicit, so the lookup table is a size optimisation. This is a deliberate, documented simplification.
- **`@solana/web3.js` is permitted on the backend.** This is an approved departure from the no-dependencies rule; see the design.
- **The frontend dependency is UNRESOLVED and must be established empirically in Task 5, not assumed** either way.
- Minimum trade is `$25` USD equivalent, enforced after quoting.
- The response carries `solanaTx` **or** `tx`, never both.

---

## File Structure

**Backend — `d:\projects\ponsy`** (branch `swap-quote-api`)

| File | Responsibility |
| --- | --- |
| `src/chain/solana.js` | CREATE. Pure transaction assembly + a cached blockhash provider. |
| `src/quote.js` | MODIFY. VM-aware validation, currency selection, `recipient`, Solana branch. |
| `src/config.js` | MODIFY. `SOLANA_RPC_URL`; `792703809` in the allowlist. |
| `test/solana.test.js` | CREATE. |
| `test/quote.test.js` | MODIFY. |
| `test/fixtures.js` | MODIFY. Captured Solana quote. |

**Frontend — `D:\projects\Meme4`** (branch `swap`)

| File | Responsibility |
| --- | --- |
| `src/lib/swap.js` | MODIFY. Solana source entry, explorer, `isSolana` helper. |
| `src/hooks/useSolanaWallet.js` | CREATE. Injected-provider connection. |
| `src/hooks/useSwapExecute.js` | MODIFY. Branch on `solanaTx`. EVM path untouched. |
| `src/components/SwapWidget.jsx` | MODIFY. Second connect control, recipient wiring. |
| `src/lib/swap.test.js` | MODIFY. |

---

### Task 1: Solana transaction assembly (backend)

**Files:**
- Create: `d:\projects\ponsy\src\chain\solana.js`
- Create: `d:\projects\ponsy\test\solana.test.js`
- Modify: `d:\projects\ponsy\package.json`

**Interfaces:**
- Produces: `buildSolanaTransaction({ instructions, feePayer, blockhash }) -> string` (base64); `createBlockhashProvider({ rpcUrl, ttlMs, now, fetchImpl }) -> { get(opts) }`.

- [ ] **Step 1: Add the dependency**

```bash
cd d:/projects/ponsy
npm install @solana/web3.js@^1.95.0
```

- [ ] **Step 2: Add the captured Solana fixture**

Append to `d:\projects\ponsy\test\fixtures.js`:

```js
/** The Solana payer and the EVM receiver — different addresses by necessity. */
export const SOL_PAYER = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'
export const EVM_RECIPIENT = '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E'

/** A real blockhash, for deterministic serialisation tests. */
export const SOL_BLOCKHASH = '5VERd3ffZBLbSUqXtkGxRWjGqzrGZP5nBs7SMDvvBGvS'

/**
 * POST /quote — 0.25 SOL -> PONSY. Captured 2026-08-09.
 *
 * Note `data` is hex with no 0x prefix (48 bytes), and `80b2e60e` at byte
 * offset 8 is 250000000 lamports little-endian. There are no EVM fields at all.
 */
export const RELAY_SOLANA_QUOTE = {
  steps: [
    {
      id: 'deposit',
      kind: 'transaction',
      requestId: '0xc43948b87065dbbbeb1f2a9c4d6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9012',
      items: [
        {
          status: 'incomplete',
          data: {
            instructions: [
              {
                programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
                keys: [
                  { pubkey: 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc', isSigner: false, isWritable: false },
                  { pubkey: SOL_PAYER, isSigner: true, isWritable: true },
                  { pubkey: SOL_PAYER, isSigner: false, isWritable: false },
                  { pubkey: '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ', isSigner: false, isWritable: true },
                  { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
                ],
                data: '0d9e0ddf5fd51c0680b2e60e000000005820f2655113737636cb60db5eef7d385b48b1e17a629db5f8cbdf203fde6c2d',
              },
            ],
            addressLookupTableAddresses: ['Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP'],
          },
          check: { endpoint: '/intents/status?requestId=0xc43948b8', method: 'GET' },
        },
      ],
    },
  ],
  fees: { gas: { amountUsd: '0.000005' }, relayer: { amountUsd: '0.31' }, app: { amountUsd: '0' } },
  details: {
    operation: 'swap',
    currencyIn: {
      currency: { chainId: 792703809, symbol: 'SOL', decimals: 9 },
      amount: '250000000', amountFormatted: '0.25', amountUsd: '19.094335',
    },
    currencyOut: {
      currency: { chainId: 4663, address: '0x2e84f2e0b88bd3ffb5d6738ae0e3c7c00137083e', symbol: 'PONSY', decimals: 18 },
      amount: '86623618000000000000000', amountFormatted: '86623.618', amountUsd: '19.125422',
      minimumAmount: '84891145640000000000000',
    },
    totalImpact: { usd: '0.031087', percent: '0.16' },
    swapImpact: { usd: '0.02', percent: '0.10' },
    timeEstimate: 3,
  },
}

/** getLatestBlockhash JSON-RPC reply. */
export const SOL_BLOCKHASH_REPLY = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    context: { slot: 300000000 },
    value: { blockhash: SOL_BLOCKHASH, lastValidBlockHeight: 280000000 },
  },
}
```

- [ ] **Step 3: Write the failing test**

Create `d:\projects\ponsy\test\solana.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSolanaTransaction, createBlockhashProvider } from '../src/chain/solana.js'
import {
  RELAY_SOLANA_QUOTE,
  SOL_PAYER,
  SOL_BLOCKHASH,
  SOL_BLOCKHASH_REPLY,
  stubFetch,
} from './fixtures.js'

const INSTRUCTIONS = RELAY_SOLANA_QUOTE.steps[0].items[0].data.instructions

test('serialises to base64 that round-trips back to the same instruction', async () => {
  const { Transaction } = await import('@solana/web3.js')

  const b64 = buildSolanaTransaction({
    instructions: INSTRUCTIONS,
    feePayer: SOL_PAYER,
    blockhash: SOL_BLOCKHASH,
  })

  const tx = Transaction.from(Buffer.from(b64, 'base64'))

  assert.equal(tx.instructions.length, 1)
  assert.equal(tx.instructions[0].programId.toBase58(), INSTRUCTIONS[0].programId)
  assert.equal(tx.recentBlockhash, SOL_BLOCKHASH)
  assert.equal(tx.feePayer.toBase58(), SOL_PAYER)
})

test('preserves account order, signer and writable flags exactly', async () => {
  const { Transaction } = await import('@solana/web3.js')
  const b64 = buildSolanaTransaction({
    instructions: INSTRUCTIONS, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH,
  })
  const keys = Transaction.from(Buffer.from(b64, 'base64')).instructions[0].keys

  /* Account ORDER is consensus-critical: the program indexes into this array
     positionally, so a reorder silently sends funds to the wrong account. */
  assert.equal(keys.length, INSTRUCTIONS[0].keys.length)
  keys.forEach((k, i) => {
    assert.equal(k.pubkey.toBase58(), INSTRUCTIONS[0].keys[i].pubkey, `key ${i} pubkey`)
    assert.equal(k.isSigner, INSTRUCTIONS[0].keys[i].isSigner, `key ${i} isSigner`)
    assert.equal(k.isWritable, INSTRUCTIONS[0].keys[i].isWritable, `key ${i} isWritable`)
  })
})

test('decodes the hex data unchanged — the amount must survive byte for byte', async () => {
  const { Transaction } = await import('@solana/web3.js')
  const b64 = buildSolanaTransaction({
    instructions: INSTRUCTIONS, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH,
  })
  const data = Transaction.from(Buffer.from(b64, 'base64')).instructions[0].data

  assert.equal(data.toString('hex'), INSTRUCTIONS[0].data)
  assert.equal(data.length, 48)
  /* Bytes 8..12 are the lamport amount, little-endian. 0x0ee6b280 = 250000000.
     If this drifts, the user sends a different amount than they were quoted. */
  assert.equal(data.readUInt32LE(8), 250_000_000)
})

test('rejects data that is not clean hex rather than silently truncating', () => {
  const bad = [{ ...INSTRUCTIONS[0], data: '0xzz' }]
  assert.throws(
    () => buildSolanaTransaction({ instructions: bad, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }),
    /hex/i,
  )
})

test('rejects a malformed base58 pubkey', () => {
  const bad = [{ ...INSTRUCTIONS[0], programId: 'not-a-real-pubkey!!!' }]
  assert.throws(() =>
    buildSolanaTransaction({ instructions: bad, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }))
})

test('requires at least one instruction', () => {
  assert.throws(
    () => buildSolanaTransaction({ instructions: [], feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }),
    /instruction/i,
  )
})

/* ---- blockhash provider ---- */

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

test('fetches a blockhash and reports its expiry height', async () => {
  const fetchImpl = stubFetch([['solana', async () => SOL_BLOCKHASH_REPLY]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl })

  const got = await p.get()
  assert.equal(got.blockhash, SOL_BLOCKHASH)
  assert.equal(got.lastValidBlockHeight, 280000000)
})

test('caches across callers so one RPC serves everyone', async () => {
  const c = clock()
  let calls = 0
  const fetchImpl = stubFetch([['solana', async () => { calls++; return SOL_BLOCKHASH_REPLY }]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl, ttlMs: 10_000, now: c.now })

  await Promise.all([p.get(), p.get(), p.get()])
  c.advance(9_000)
  await p.get()

  assert.equal(calls, 1, 'a blockhash is shared; it is not per-user state')
})

test('refetches once the cache window passes', async () => {
  const c = clock()
  let calls = 0
  const fetchImpl = stubFetch([['solana', async () => { calls++; return SOL_BLOCKHASH_REPLY }]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl, ttlMs: 10_000, now: c.now })

  await p.get()
  c.advance(10_001)
  await p.get()

  assert.equal(calls, 2)
})

test('surfaces an RPC error rather than returning a stale-looking null', async () => {
  const fetchImpl = stubFetch([['solana', async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'node behind' } })]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl })
  await assert.rejects(() => p.get(), /node behind/)
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd d:\projects\ponsy && npm test`
Expected: FAIL — `Cannot find module '../src/chain/solana.js'`

- [ ] **Step 5: Write the implementation**

Create `d:\projects\ponsy\src\chain\solana.js`:

```js
/**
 * SOLANA TRANSACTION ASSEMBLY
 * -----------------------------------------------------------------------------
 * Turns Relay's instruction description into a signable transaction.
 *
 * This is the one place in the codebase with a real dependency, and the reason
 * is specific. The EVM side hand-rolls its ABI work because every call takes
 * zero arguments — calldata is a constant selector and decoding is hex slicing,
 * about forty lines. Solana serialisation is a message header, a compact-u16
 * account array, per-instruction account indexing and base64: roughly 150 lines
 * of exact binary work in which one off-by-one produces a malformed transaction
 * over real funds. The trade that justified hand-rolling there argues the
 * opposite here.
 *
 * A LEGACY transaction is built deliberately, not a v0 one. Relay returns a v0
 * shape carrying an address lookup table, but every account in the instruction
 * is named explicitly, so the table is a size optimisation rather than a
 * correctness requirement — and skipping it removes an RPC round trip per
 * quote. If Relay's solver ever turns out to care about the format, building v0
 * is a change contained entirely within this file.
 */

import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'

const HEX_RE = /^[0-9a-fA-F]*$/

/** Relay sends instruction data as hex with no 0x prefix. */
function decodeData(hex) {
  const s = String(hex ?? '')
  if (!HEX_RE.test(s) || s.length % 2 !== 0) {
    throw new Error(`instruction data must be even-length hex, got: ${s.slice(0, 24)}`)
  }
  return Buffer.from(s, 'hex')
}

/**
 * Builds an unsigned legacy transaction and returns it base64-encoded.
 *
 * Account order is preserved exactly as Relay gave it. That ordering is
 * consensus-critical — the program indexes into the array positionally, so a
 * reorder does not fail loudly, it moves funds somewhere else.
 */
export function buildSolanaTransaction({ instructions, feePayer, blockhash }) {
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new Error('at least one instruction is required')
  }
  if (!blockhash) throw new Error('a recent blockhash is required')

  const tx = new Transaction()
  for (const raw of instructions) {
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(raw.programId),
        keys: (raw.keys ?? []).map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: Boolean(k.isSigner),
          isWritable: Boolean(k.isWritable),
        })),
        data: decodeData(raw.data),
      }),
    )
  }

  tx.feePayer = new PublicKey(feePayer)
  tx.recentBlockhash = blockhash

  /* Unsigned by construction — the wallet signs. Serialising without that
     assertion is the whole point: the backend must never hold a key. */
  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64')
}

/**
 * A shared, briefly-cached blockhash.
 *
 * A blockhash is not per-user state — every transaction in the same few seconds
 * can carry the same one. Caching it means a public Solana RPC is sufficient
 * even under load: this is one cheap call every ttlMs, not one per visitor.
 */
export function createBlockhashProvider({
  rpcUrl,
  ttlMs = 10_000,
  timeoutMs = 8_000,
  now = Date.now,
  fetchImpl = fetch,
}) {
  let cached = null
  let storedAt = 0
  let inFlight = null

  async function fetchOne(signal) {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)

    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'confirmed' }],
      }),
      signal: AbortSignal.any(signals),
    })
    if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`)

    const json = await res.json()
    if (json?.error) throw new Error(`Solana RPC: ${json.error.message ?? 'unknown'}`)

    const value = json?.result?.value
    if (!value?.blockhash) throw new Error('Solana RPC returned no blockhash')

    return {
      blockhash: value.blockhash,
      lastValidBlockHeight: value.lastValidBlockHeight ?? null,
    }
  }

  async function get({ signal } = {}) {
    if (cached && now() - storedAt < ttlMs) return cached

    if (!inFlight) {
      inFlight = (async () => {
        try {
          cached = await fetchOne(signal)
          storedAt = now()
          return cached
        } finally {
          inFlight = null
        }
      })()
    }
    return inFlight
  }

  return { get }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd d:\projects\ponsy && npm test`
Expected: PASS — 11 new tests, all 113 existing still passing.

- [ ] **Step 7: Commit**

```bash
cd d:/projects/ponsy
git add package.json package-lock.json src/chain/solana.js test/solana.test.js test/fixtures.js
git commit -m "feat: assemble a signable Solana transaction from Relay's instruction"
```

---

### Task 2: Solana origin in the quote service (backend)

**Files:**
- Modify: `d:\projects\ponsy\src\quote.js`
- Modify: `d:\projects\ponsy\src\config.js`
- Modify: `d:\projects\ponsy\.env.example`
- Modify: `d:\projects\ponsy\test\quote.test.js`

**Interfaces:**
- Consumes: `buildSolanaTransaction`, `createBlockhashProvider` from Task 1.
- Produces: `createQuoteService({ config, fetchImpl, blockhash })` — `getQuote({ user, chainId, amount, recipient })` now resolves to a payload carrying either `tx` (EVM) or `solanaTx` (Solana), never both.

- [ ] **Step 1: Add config**

In `d:\projects\ponsy\src\config.js`, inside `buildConfig`:

```js
    solanaRpcUrl: parseUrl(
      env.SOLANA_RPC_URL,
      'https://api.mainnet-beta.solana.com',
      'SOLANA_RPC_URL',
    ),
```

and extend the allowlist default to include Solana:

```js
    allowedChainIds: (env.ALLOWED_CHAIN_IDS ?? '8453,1,42161,10,4663,56,792703809')
```

Append to `.env.example`:

```ini
# Solana RPC, used only for a shared getLatestBlockhash. The result is cached
# across all users for a few seconds, so the public endpoint is sufficient —
# this is one cheap call every cache window, not one per visitor.
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

- [ ] **Step 2: Write the failing test**

Append to `d:\projects\ponsy\test\quote.test.js`:

```js
import { RELAY_SOLANA_QUOTE, SOL_PAYER, EVM_RECIPIENT, SOL_BLOCKHASH } from './fixtures.js'

const SOLANA_CHAIN = 792703809

/** A blockhash provider that never touches the network. */
const stubBlockhash = {
  get: async () => ({ blockhash: SOL_BLOCKHASH, lastValidBlockHeight: 280000000 }),
}

function solanaService(overrides = {}) {
  return createQuoteService({
    config: config(),
    fetchImpl: stubFetch([['/quote', async () => RELAY_SOLANA_QUOTE]]),
    blockhash: stubBlockhash,
    ...overrides,
  })
}

test('accepts a base58 payer for a Solana origin', async () => {
  const q = await solanaService().getQuote({
    user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
  })
  assert.ok(q.solanaTx, 'a Solana quote must carry solanaTx')
  assert.equal(q.tx, undefined, 'and must NOT carry an EVM tx')
})

test('returns a base64 transaction and the blockhash expiry', async () => {
  const q = await solanaService().getQuote({
    user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
  })
  assert.match(q.solanaTx.base64, /^[A-Za-z0-9+/]+=*$/)
  assert.equal(q.solanaTx.lastValidBlockHeight, 280000000)
})

test('sends SOL as the origin currency and the EVM address as the recipient', async () => {
  const fetchImpl = stubFetch([['/quote', async () => RELAY_SOLANA_QUOTE]])
  await createQuoteService({ config: config(), fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)

  assert.equal(body.originCurrency, '11111111111111111111111111111111')
  assert.equal(body.originChainId, SOLANA_CHAIN)
  assert.equal(body.user, SOL_PAYER)
  assert.equal(body.recipient, EVM_RECIPIENT, 'the EVM wallet receives, not the payer')
  assert.equal(body.destinationCurrency, PONSY_ADDRESS.toLowerCase())
})

test('rejects a Solana origin with no recipient — never guess a destination', async () => {
  await assert.rejects(
    () => solanaService().getQuote({ user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25' }),
    /recipient/i,
  )
})

test('rejects an EVM address as the payer on a Solana origin', async () => {
  await assert.rejects(
    () => solanaService().getQuote({
      user: EVM_RECIPIENT, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
    }),
    /base58|Solana/i,
  )
})

test('rejects a base58 payer on an EVM origin', async () => {
  await assert.rejects(
    () => solanaService().getQuote({ user: SOL_PAYER, chainId: 8453, amount: '0.02' }),
    /user must be/,
  )
})

test('EVM quotes still default the recipient to the payer', async () => {
  const fetchImpl = ok()
  await createQuoteService({ config: config(), fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 8453, amount: '0.02',
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.recipient, USER, 'unchanged EVM behaviour')
})

test('still emits marketCap-style shared fields for a Solana quote', async () => {
  const q = await solanaService().getQuote({
    user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
  })
  assert.equal(q.amountIn, 0.25)
  assert.ok(Math.abs(q.amountOut - 86623.618) < 0.001)
  assert.ok(Math.abs(q.priceImpact - 0.0016) < 1e-9)
  assert.equal(q.timeEstimate, 3)
  assert.match(q.requestId, /^0x/)
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd d:\projects\ponsy && npm test`
Expected: FAIL — Solana quotes are rejected by the `0x` address check.

- [ ] **Step 4: Write the implementation**

In `d:\projects\ponsy\src\quote.js`, add near the existing constants:

```js
/** Relay's id for Solana, and SOL's currency identifier. Verified live. */
export const SOLANA_CHAIN_ID = 792703809
const SOL_CURRENCY = '11111111111111111111111111111111'

/* Base58 excludes 0, O, I and l precisely so addresses cannot be misread.
   Length is 32-44 characters for a 32-byte key. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Solana pays in SOL; every EVM source chain pays in its own native asset. */
function originCurrencyFor(chainId) {
  return chainId === SOLANA_CHAIN_ID ? SOL_CURRENCY : NATIVE
}
```

Replace the `user` validation block with VM-aware validation, and add the recipient:

```js
    const origin = Number(chainId)
    if (!config.allowedChainIds.includes(origin)) {
      throw new Error(`chain ${chainId} is not supported`)
    }

    const isSolana = origin === SOLANA_CHAIN_ID

    if (isSolana) {
      if (!BASE58_RE.test(String(user ?? ''))) {
        throw new Error('user must be a base58 Solana address for a Solana origin')
      }
      /* A Solana keypair has no EVM address, so the destination cannot be
         derived — it has to be supplied. Guessing one would send PONSY
         somewhere unrecoverable. */
      if (!ADDRESS_RE.test(String(recipient ?? ''))) {
        throw new Error('recipient must be a 0x address when paying from Solana')
      }
    } else if (!ADDRESS_RE.test(String(user ?? ''))) {
      throw new Error('user must be a 0x-prefixed 40-hex-character address')
    }

    /* On EVM the payer receives, exactly as before. */
    const receiver = isSolana ? recipient : user
```

Pass both through to Relay, and build the Solana transaction after the quote returns:

```js
    const raw = await fetchRelayQuote(
      config.relayUrl,
      {
        user,
        recipient: receiver,
        originChainId: origin,
        destinationChainId: 4663,
        originCurrency: originCurrencyFor(origin),
        destinationCurrency: config.tokenAddress,
        amount: isSolana ? toLamports(amount) : toWei(amount),
      },
      { fetchImpl, timeoutMs: config.upstreamTimeoutMs },
    )
```

where `toLamports` mirrors `toWei` at 9 decimals:

```js
/** SOL has 9 decimals, not 18. Same exact-integer path as toWei. */
export function toLamports(amount) {
  return toWei(amount, 9)
}
```

(Note: `toWei` must gain an optional `decimals` parameter defaulting to 18. Its existing tests call it with one argument and must keep passing.)

Then, where the EVM path builds `tx`, branch:

```js
    const item = raw?.steps?.[0]?.items?.[0]

    let txField
    if (isSolana) {
      const ixs = item?.data?.instructions
      if (!Array.isArray(ixs) || ixs.length === 0) {
        throw new Error('Relay returned no Solana instructions to sign')
      }
      const { blockhash: hash, lastValidBlockHeight } = await blockhash.get({ signal })
      txField = {
        solanaTx: {
          base64: buildSolanaTransaction({
            instructions: ixs,
            feePayer: user,
            blockhash: hash,
          }),
          lastValidBlockHeight,
        },
      }
    } else {
      if (!item?.data?.to) throw new Error('Relay returned no transaction to sign')
      if (!item?.data?.from) throw new Error('Relay returned no sender for the transaction')
      txField = {
        tx: {
          from: item.data.from,
          to: item.data.to,
          data: item.data.data,
          value: String(item.data.value ?? '0'),
          chainId: item.data.chainId,
          ...(parseGasLimit(item.data.gas) !== undefined
            ? { gas: parseGasLimit(item.data.gas) }
            : {}),
        },
      }
    }
```

and spread `...txField` into the returned object in place of the current `tx:` key.

Update the service factory signature:

```js
export function createQuoteService({ config, fetchImpl = fetch, blockhash }) {
```

and add `792703809: 'Solana'` to `CHAIN_NAMES`.

- [ ] **Step 5: Wire it in the entry point**

In `d:\projects\ponsy\src\index.js`:

```js
import { createBlockhashProvider } from './chain/solana.js'

const blockhash = createBlockhashProvider({ rpcUrl: config.solanaRpcUrl })
const quoteService = createQuoteService({ config, blockhash })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd d:\projects\ponsy && npm test`
Expected: PASS — 8 new tests; all previous still passing.

- [ ] **Step 7: Verify against the real Relay API**

```bash
cd d:/projects/ponsy
TOKEN_ADDRESS=0x2E84F2E0b88BD3FFB5D6738aE0e3C7c00137083E PORT=8813 node src/index.js &
sleep 4
echo "--- Solana ---"
curl -s "http://127.0.0.1:8813/quote?amount=0.25&chainId=792703809&user=GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ&recipient=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E"
echo; echo "--- BNB (must be unchanged) ---"
curl -s "http://127.0.0.1:8813/quote?amount=0.06&chainId=56&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E"
echo; echo "--- Base (must be unchanged) ---"
curl -s "http://127.0.0.1:8813/quote?amount=0.02&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E"
```

Expected: the Solana response carries `solanaTx.base64` and no `tx`; BNB and Base carry `tx` with `gas` and no `solanaTx`. Kill the server afterwards — check `Get-NetTCPConnection -LocalPort 8813` and stop the owning process, since a backgrounded node survives a shell `kill` on Windows.

- [ ] **Step 8: Commit**

```bash
cd d:/projects/ponsy
git add src/quote.js src/config.js src/index.js .env.example test/quote.test.js
git commit -m "feat: accept a Solana origin, returning a signable transaction"
```

---

### Task 3: Solana source in the frontend library

**Files:**
- Modify: `D:\projects\Meme4\src\lib\swap.js`
- Modify: `D:\projects\Meme4\src\lib\swap.test.js`

**Interfaces:**
- Produces: `SOLANA_CHAIN_ID`; `isSolanaChain(id)`; a Solana entry in `SOURCE_CHAINS` carrying `vm: 'svm'` and `native: 'SOL'`; `fetchQuote` gains a `recipient` parameter.

- [ ] **Step 1: Write the failing test**

Append to `D:\projects\Meme4\src\lib\swap.test.js`:

```js
import { SOURCE_CHAINS, SOLANA_CHAIN_ID, isSolanaChain, explorerTxUrl } from './swap'

describe('Solana as a source', () => {
  it('is offered with SOL as its native asset and an svm marker', () => {
    const sol = SOURCE_CHAINS.find((c) => c.id === SOLANA_CHAIN_ID)
    expect(sol).toBeTruthy()
    expect(sol.native).toBe('SOL')
    expect(sol.vm).toBe('svm')
  })

  it('every other source chain is explicitly evm', () => {
    for (const c of SOURCE_CHAINS.filter((c) => c.id !== SOLANA_CHAIN_ID)) {
      expect(c.vm ?? 'evm').toBe('evm')
    }
  })

  it('identifies the Solana chain id', () => {
    expect(isSolanaChain(SOLANA_CHAIN_ID)).toBe(true)
    expect(isSolanaChain(8453)).toBe(false)
    expect(isSolanaChain(undefined)).toBe(false)
  })

  it('links a Solana signature to Solscan', () => {
    expect(explorerTxUrl(SOLANA_CHAIN_ID, '5xY')).toBe('https://solscan.io/tx/5xY')
  })
})

describe('fetchQuote recipient', () => {
  it('sends the recipient when one is given', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    await fetchQuote({
      amount: 0.25, chain: { id: SOLANA_CHAIN_ID }, account: 'GThUX', recipient: '0xabc',
      endpoint: 'https://q.test', fetchImpl,
    })
    expect(fetchImpl.mock.calls[0][0]).toContain('recipient=0xabc')
  })

  it('omits the recipient entirely when there is none', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    await fetchQuote({
      amount: 0.02, chain: { id: 8453 }, account: '0xabc',
      endpoint: 'https://q.test', fetchImpl,
    })
    expect(fetchImpl.mock.calls[0][0]).not.toContain('recipient=')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:\projects\Meme4 && npm test`
Expected: FAIL — `SOLANA_CHAIN_ID` is not exported.

- [ ] **Step 3: Write the implementation**

In `D:\projects\Meme4\src\lib\swap.js`:

```js
/** Relay's id for Solana. Not an EVM chain id — it does not collide with one. */
export const SOLANA_CHAIN_ID = 792703809

/** True for the one non-EVM source. Used to pick a wallet and a signing path. */
export function isSolanaChain(id) {
  return Number(id) === SOLANA_CHAIN_ID
}
```

Add to `SOURCE_CHAINS`, after the EVM entries:

```js
  { id: SOLANA_CHAIN_ID, key: 'solana', label: 'Solana', native: 'SOL', vm: 'svm' },
```

and mark the existing entries `vm: 'evm'`.

Add to `EXPLORER_BY_CHAIN_ID`:

```js
  [SOLANA_CHAIN_ID]: 'https://solscan.io',
```

Extend `fetchQuote` to forward a recipient when present:

```js
  const url =
    `${endpoint}?amount=${encodeURIComponent(amount)}` +
    `&chainId=${encodeURIComponent(chain?.id ?? '')}` +
    `&user=${encodeURIComponent(account)}` +
    (recipient ? `&recipient=${encodeURIComponent(recipient)}` : '')
```

adding `recipient` to its destructured parameters.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd D:\projects\Meme4 && npm test && npm run build`
Expected: PASS — 6 new tests; all 49 existing still passing; build clean.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/Meme4
git add src/lib/swap.js src/lib/swap.test.js
git commit -m "feat: offer Solana as a swap source"
```

---

### Task 4: Solana wallet connection (frontend)

**Files:**
- Create: `D:\projects\Meme4\src\hooks\useSolanaWallet.js`

**Interfaces:**
- Produces: `useSolanaWallet() -> { address, connect, disconnect, connecting, error, provider }`.

- [ ] **Step 1: Establish what the wallet actually accepts**

Before writing the signing code in Task 5, determine empirically whether Phantom can accept a pre-serialized transaction without `@solana/web3.js` in the browser. In a browser console with Phantom installed:

```js
// Does the provider expose a raw request path?
console.log(typeof window.solana?.request, typeof window.solana?.signAndSendTransaction)
```

Record the answer in the task report. **Do not add `@solana/web3.js` to the frontend unless this establishes it is required, and do not omit it on the assumption that it is not.** If it is required, add it in Task 5 with the finding written down.

- [ ] **Step 2: Write the implementation**

Create `D:\projects\Meme4\src\hooks\useSolanaWallet.js`:

```js
import { useCallback, useEffect, useState } from 'react'

/**
 * Connection to an injected Solana wallet.
 *
 * Uses the raw injected provider rather than a wallet library, matching how the
 * EVM side uses window.ethereum directly. Phantom and Solflare between them
 * cover the large majority of Solana users, and a library would introduce a
 * provider pattern nothing else in this app uses.
 */
function findProvider() {
  if (typeof window === 'undefined') return null
  // Phantom sets window.phantom.solana; Solflare sets window.solflare.
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana
  if (window.solana?.isPhantom) return window.solana
  if (window.solflare?.isSolflare) return window.solflare
  return window.solana ?? null
}

export function useSolanaWallet() {
  const [address, setAddress] = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState(null)

  const connect = useCallback(async () => {
    setError(null)
    const provider = findProvider()
    if (!provider) {
      setError(new Error('No Solana wallet found. Install Phantom or Solflare.'))
      return null
    }
    setConnecting(true)
    try {
      const res = await provider.connect()
      const key = (res?.publicKey ?? provider.publicKey)?.toString?.()
      setAddress(key ?? null)
      return key ?? null
    } catch (e) {
      /* 4001 is the EVM convention; Phantom uses the same code for a user
         rejection, so a decline is silence here exactly as it is on the EVM
         side rather than an error worth shouting about. */
      if (e?.code !== 4001) {
        setError(new Error(e?.message ?? 'Could not connect to your Solana wallet.'))
      }
      return null
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    const provider = findProvider()
    try { await provider?.disconnect?.() } catch { /* nothing actionable */ }
    setAddress(null)
  }, [])

  /* A wallet-side account switch must not leave a stale address on screen —
     the address it names is the one that will be debited. */
  useEffect(() => {
    const provider = findProvider()
    if (!provider?.on) return
    const onAccountChanged = (key) => setAddress(key?.toString?.() ?? null)
    const onDisconnect = () => setAddress(null)
    provider.on('accountChanged', onAccountChanged)
    provider.on('disconnect', onDisconnect)
    return () => {
      provider.off?.('accountChanged', onAccountChanged)
      provider.off?.('disconnect', onDisconnect)
    }
  }, [])

  return { address, connect, disconnect, connecting, error, provider: findProvider() }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd D:\projects\Meme4 && npm test && npm run build`
Expected: 55 tests pass, build clean.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/Meme4
git add src/hooks/useSolanaWallet.js
git commit -m "feat: connect an injected Solana wallet"
```

---

### Task 5: Execute a Solana swap (frontend)

**Files:**
- Modify: `D:\projects\Meme4\src\hooks\useSwapExecute.js`
- Modify: `D:\projects\Meme4\src\components\SwapWidget.jsx`

**Interfaces:**
- Consumes: `useSolanaWallet` (Task 4); `isSolanaChain`, `SOLANA_CHAIN_ID` (Task 3); `quote.solanaTx` (Task 2).
- Produces: no signature change to `useSwapExecute()` — `execute(quote)` handles both shapes.

- [ ] **Step 1: Branch the execution hook**

In `D:\projects\Meme4\src\hooks\useSwapExecute.js`, inside `execute`, before the existing EVM validation:

```js
      /* Solana and EVM quotes are mutually exclusive by construction — the
         backend emits solanaTx or tx, never both — so branching on which is
         present is the whole dispatch. A quote carrying neither is a contract
         violation, not a user error. */
      if (quote.solanaTx) {
        await executeSolana(quote)
        return
      }
```

Add the Solana path as a sibling function inside the hook, preserving every guard the EVM path established — the `running` re-entry ref, the `runRef` token checked at each resumption point, `maybeSentRef` set immediately before the send, unconditional `setTxHash`, and the same status vocabulary:

```js
  const executeSolana = useCallback(async (quote) => {
    const provider = findSolanaProvider()
    if (!provider) throw new Error('No Solana wallet found. Install Phantom or Solflare.')

    setStatus('signing')

    const tx = await deserializeSolanaTransaction(quote.solanaTx.base64)

    /* Set immediately before the send, with no await in between, for the same
       reason as the EVM path: a throw after this point may still have
       broadcast, and retrying would deposit twice. */
    maybeSentRef.current = true
    const { signature } = await provider.signAndSendTransaction(tx)
    maybeSentRef.current = false

    setTxHash(signature)
    setStatus('pending')
  }, [])
```

Polling is unchanged — `requestId` and `check.endpoint` are identical for both VMs, so the existing loop is reused verbatim. Do not duplicate it.

- [ ] **Step 2: Add the second connect control**

In `D:\projects\Meme4\src\components\SwapWidget.jsx`:

```jsx
  const solana = useSolanaWallet()
  const payingFromSolana = isSolanaChain(chain?.id)

  /* On Solana the payer and the receiver are different addresses: SOL leaves a
     base58 wallet and PONSY arrives at an EVM one. Everywhere else they are the
     same account. */
  const payer = payingFromSolana ? solana.address : account
  const recipient = payingFromSolana ? account : undefined
```

Pass both into quoting:

```jsx
  const { quote, loading, error, retry } = useSwapQuote(amount, chain, payer, recipient)
```

(`useSwapQuote` gains `recipient` as a parameter and a dependency, forwarding it to `fetchQuote`.)

Render the second connect button only when Solana is selected, and gate the buy button on both connections:

```jsx
          {payingFromSolana && !solana.address && (
            <button
              type="button"
              onClick={solana.connect}
              disabled={solana.connecting}
              className="btn-comic mt-3 w-full text-base sm:text-lg"
              style={{ backgroundColor: scene?.accent }}
            >
              {solana.connecting ? 'CONNECTING…' : 'CONNECT SOLANA WALLET'}
            </button>
          )}

          {payingFromSolana && solana.address && (
            <p className="mt-2 text-center font-code text-[10px] font-bold tracking-wider text-ink/55">
              PAYING FROM {solana.address.slice(0, 4)}…{solana.address.slice(-4)}
              {account && <> · RECEIVING AT {account.slice(0, 6)}…{account.slice(-4)}</>}
            </p>
          )}
```

The existing `actionDisabled` gains one term: when paying from Solana, both wallets must be connected.

- [ ] **Step 3: Verify**

Run: `cd D:\projects\Meme4 && npm test && npm run build`
Expected: all tests pass, build clean.

Then, with the backend running locally and Solana selected in the widget, confirm: the pay-side chip reads **SOL**, the CONNECT SOLANA WALLET button appears, connecting shows both addresses, and a quote returns without either wallet being asked to sign.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/Meme4
git add src/hooks/useSwapExecute.js src/hooks/useSwapQuote.js src/components/SwapWidget.jsx
git commit -m "feat: execute a Solana swap, paying from Phantom and receiving on EVM"
```

---

### Task 6: Live verification of every source chain

**Files:** none — verification only.

- [ ] **Step 1: Quote every source chain against the real Relay API**

With the backend running locally and `TOKEN_ADDRESS` set, request one quote per source chain: Base (8453), Ethereum (1), Arbitrum (42161), Optimism (10), Robinhood (4663), BNB (56) and Solana (792703809).

For each, record: HTTP status, `amountInUsd`, `amountOutUsd`, `priceImpact`, and which transaction field came back. Every EVM chain must carry `tx` with a `gas` field and no `solanaTx`; Solana must carry `solanaTx.base64` and no `tx`.

- [ ] **Step 2: Confirm the Solana transaction deserialises**

Round-trip the returned base64 through `Transaction.from(Buffer.from(base64, 'base64'))` and assert the instruction, account order and 48-byte data survive, and that `recentBlockhash` is set. This is the same assertion Task 1 makes against a fixture, now against a live quote.

- [ ] **Step 3: Record what remains unproven**

Write down explicitly that no Solana transaction has been signed or broadcast, and that the legacy-vs-v0 equivalence is confirmed only by a real swap. Do not describe the feature as working end to end on the strength of quote-level verification.

---

## Out of Scope

- **SPL tokens as the source** (Solana USDC/USDT) — Relay returns `NO_SWAP_ROUTES_FOUND` for SPL origins to every destination. The route does not exist.
- **Selling PONSY back to SOL** — needs an ERC-20 approval on Robinhood Chain first, which the execution hook does not implement for any chain.
- **v0 transactions with address lookup tables** — the fallback if legacy proves insufficient; contained to `src/chain/solana.js`.
- **Additional EVM networks** (Polygon, Avalanche, Unichain, Sonic, Abstract) — verified working, deliberately excluded.
