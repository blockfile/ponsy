import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/config.js'
import { createQuoteService, toWei, toLamports } from '../src/quote.js'
import {
  RELAY_QUOTE, RELAY_STATUS_SUCCESS, PONSY_ADDRESS, stubFetch,
  RELAY_SOLANA_QUOTE, SOL_PAYER, EVM_RECIPIENT, SOL_BLOCKHASH,
  RELAY_APPROVE_QUOTE,
} from './fixtures.js'

const USER = '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E'
const config = buildConfig({ TOKEN_ADDRESS: PONSY_ADDRESS })
const ok = () => stubFetch([
  ['/quote', async () => RELAY_QUOTE],
  ['/intents/status', async () => RELAY_STATUS_SUCCESS],
])

/**
 * A blockhash provider that never touches the network.
 *
 * Required by every createQuoteService() call below, EVM-included:
 * construction now fails fast without one (see 'refuses to construct
 * without a Solana blockhash provider' below), so even a test that never
 * touches the Solana path needs a well-formed one to build the service at
 * all.
 */
const stubBlockhash = {
  get: async () => ({ blockhash: SOL_BLOCKHASH, lastValidBlockHeight: 280000000 }),
}

/** RELAY_QUOTE with steps[0].items[0].data.gas replaced by an arbitrary value. */
const withGas = (gasValue) => ({
  ...RELAY_QUOTE,
  steps: [
    {
      ...RELAY_QUOTE.steps[0],
      items: [{
        ...RELAY_QUOTE.steps[0].items[0],
        data: { ...RELAY_QUOTE.steps[0].items[0].data, gas: gasValue },
      }],
    },
  ],
})

test('normalises a Relay quote into the shape the widget renders', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })

  assert.equal(q.amountIn, 0.02)
  assert.equal(q.amountInUsd, 38.427738)
  assert.ok(Math.abs(q.amountOut - 287080.5756130577) < 0.001)
  assert.equal(q.amountOutUsd, 36.462148)
  assert.equal(q.mock, false)
})

test('converts price impact to a fraction, because formatPct multiplies by 100', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
  /* Relay says "-5.12" meaning -5.12%. The widget's formatPct renders n*100,
     so passing -5.12 through unchanged would display "-512.00%". */
  assert.ok(Math.abs(q.priceImpact - -0.0512) < 1e-9)
})

test('carries minimum received as whole tokens', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
  assert.ok(Math.abs(q.minReceived - 281338.9641007965) < 0.001)
  assert.ok(q.minReceived < q.amountOut, 'minimum must be below expected')
})

test('exposes fee, rate, time estimate and route alongside the amounts', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })

  // relayer (0.730005) + app (0) — deliberately excludes fees.gas, which the
  // user's own wallet already shows separately. See the comment in quote.js.
  assert.equal(q.feeUsd, 0.730005)
  // Tokens per 1 ETH, derived from amountOut / amountIn.
  assert.ok(Math.abs(q.rate - 14354028.780652884) < 0.001)
  assert.equal(q.timeEstimate, 3)
  assert.equal(q.route, 'Base to Robinhood Chain, one transaction')
})

test('exposes the transaction to sign and the requestId to poll', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })

  // Full object, including `data` — that's the calldata the wallet actually
  // signs; a regression that drops or corrupts it must fail this test.
  assert.deepEqual(q.tx, {
    from: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
    to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
    data: '0x49290c1c0000000000000000000000002dfec17b1d8dce43cb5b1111352fd58be01d389e',
    value: '20000000000000000',
    chainId: 8453,
    gas: 32713,
  })
  assert.match(q.requestId, /^0x/)
  /* The other half of the mutual-exclusivity invariant pinned on the Solana
     side (see 'accepts a base58 payer for a Solana origin' below): an EVM
     quote must never carry the Solana signing payload either. */
  assert.equal(q.solanaTx, undefined, 'an EVM quote must NOT carry solanaTx')
})

test('forwards gas as a number, never a string or hex, when Relay sends a bare number', async () => {
  // This is the field a dropped copy of which sent a real MetaMask-on-Base
  // user to a 140,000,000-gas fallback estimate and an Infura rejection —
  // see the fixture's steps[0].items[0].data.gas (32713, captured live).
  // The frontend's toHexQuantityLoose does the hex-encoding; this layer
  // must pass a genuine number through, untouched in value.
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
  assert.equal(q.tx.gas, 32713)
  assert.equal(typeof q.tx.gas, 'number')
})

test('forwards gas as a number even when Relay sends it as a numeric string', async () => {
  // Live evidence, not a hypothetical: two independent POSTs to the real
  // https://api.relay.link/quote (2026-08-09, different amounts/requestIds)
  // both returned "gas":"32713" — a JSON string — even though the fixture
  // above (and the original bug report) assumed a bare number. A strict
  // `typeof === 'number'` check silently drops gas on every real quote
  // while still passing against the fixture. Pin the coercion so this
  // regresses loudly if "simplified" back to a strict typeof check.
  const withStringGas = withGas('32713')
  const svc = createQuoteService({
    config,
    fetchImpl: stubFetch([['/quote', async () => withStringGas]]),
    blockhash: stubBlockhash,
  })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
  assert.equal(q.tx.gas, 32713)
  assert.equal(typeof q.tx.gas, 'number')
})

test('omits gas entirely, never null, when Relay does not supply it', async () => {
  // A missing key lets the wallet fall back to its own estimation — correct
  // on chains where estimation works. A null or 0 limit would be strictly
  // worse everywhere, so absence must stay absence, not become a null field.
  const { gas, ...dataWithoutGas } = RELAY_QUOTE.steps[0].items[0].data
  const noGas = {
    ...RELAY_QUOTE,
    steps: [
      {
        ...RELAY_QUOTE.steps[0],
        items: [{ ...RELAY_QUOTE.steps[0].items[0], data: dataWithoutGas }],
      },
    ],
  }
  const svc = createQuoteService({
    config,
    fetchImpl: stubFetch([['/quote', async () => noGas]]),
    blockhash: stubBlockhash,
  })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
  assert.ok(!('gas' in q.tx), 'gas key must be entirely absent, not null/undefined, when Relay omits it')
})

test('omits gas for any value that is not a positive whole number', async () => {
  // A zero or garbled limit is strictly worse than none — it must fall back
  // to omission (wallet estimates) exactly like a genuinely missing field,
  // not be forwarded as a bogus limit.
  const cases = { zero: 0, 'zero string': '0', negative: -5, 'non-numeric': 'abc', fractional: '32713.5' }
  for (const [label, value] of Object.entries(cases)) {
    const svc = createQuoteService({
      config,
      fetchImpl: stubFetch([['/quote', async () => withGas(value)]]),
      blockhash: stubBlockhash,
    })
    const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
    assert.ok(!('gas' in q.tx), label)
  }
})

test('rejects a Relay response with no sending account for the transaction', async () => {
  // Both the wallet's own account check and the frontend's `if (from && ...)`
  // guard depend on this field existing — a missing `from` must fail here,
  // not silently reach either of those and pass them by omission.
  const { from, ...dataWithoutFrom } = RELAY_QUOTE.steps[0].items[0].data
  const noFrom = {
    ...RELAY_QUOTE,
    steps: [
      {
        ...RELAY_QUOTE.steps[0],
        items: [{ ...RELAY_QUOTE.steps[0].items[0], data: dataWithoutFrom }],
      },
    ],
  }
  const svc = createQuoteService({
    config,
    fetchImpl: stubFetch([['/quote', async () => noFrom]]),
    blockhash: stubBlockhash,
  })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' }),
    /no sending account/,
  )
})

test('sends the hardcoded PONSY address, never one from the caller', async () => {
  const fetchImpl = ok()
  const svc = createQuoteService({ config, fetchImpl, blockhash: stubBlockhash })
  await svc.getQuote({
    user: USER, chainId: 8453, amount: '0.02',
    destinationCurrency: '0xd314ee5350570e57c8e2e5bb6b3920cd1a16083e', // impostor
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.destinationCurrency, PONSY_ADDRESS.toLowerCase())
  assert.equal(body.destinationChainId, 4663)
})

test('rejects a chain that is not allowlisted', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 137, amount: '0.02' }),
    /chain 137 is not supported/,
  )
})

test('accepts chain 56 (BNB Chain) as an allowed source', async () => {
  // Same fixture as the Base-origin tests above — this test's only concern is
  // that 56 clears the allowlist gate and reaches Relay, not the fixture's
  // own (Base-shaped) numbers. originChainId is asserted separately below so
  // a regression that silently drops or overwrites the caller's chain id
  // still fails here even though the response body wouldn't show it.
  const fetchImpl = ok()
  const svc = createQuoteService({ config, fetchImpl, blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 56, amount: '0.02' })
  assert.equal(q.mock, false)
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.originChainId, 56)
  // route is built from CHAIN_NAMES[origin], not the fixture — this is the
  // direct regression test for the "56: 'BNB Chain'" entry.
  assert.equal(q.route, 'BNB Chain to Robinhood Chain, one transaction')
})

test('rejects a malformed user address', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  await assert.rejects(
    () => svc.getQuote({ user: 'nope', chainId: 8453, amount: '0.02' }),
    /user must be/,
  )
})

test('rejects a non-positive amount', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
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
    blockhash: stubBlockhash,
  })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '0.0026' }),
    /minimum trade is \$25/,
  )
})

test('rejects an unverifiable trade value, distinctly from the minimum message', async () => {
  const mutations = {
    'amountUsd missing': (c) => { delete c.amountUsd },
    'amountUsd is "0"': (c) => { c.amountUsd = '0' },
    'amountUsd is non-numeric': (c) => { c.amountUsd = 'not-a-number' },
  }
  for (const [label, mutate] of Object.entries(mutations)) {
    const currencyIn = { ...RELAY_QUOTE.details.currencyIn }
    mutate(currencyIn)
    const bad = { ...RELAY_QUOTE, details: { ...RELAY_QUOTE.details, currencyIn } }
    const svc = createQuoteService({
      config,
      fetchImpl: stubFetch([['/quote', async () => bad]]),
      blockhash: stubBlockhash,
    })
    await assert.rejects(
      () => svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' }),
      /could not verify/,
      label,
    )
  }
})

test('refuses to run when TOKEN_ADDRESS is unset', async () => {
  const svc = createQuoteService({ config: buildConfig({}), fetchImpl: ok(), blockhash: stubBlockhash })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' }),
    /TOKEN_ADDRESS is not set/,
  )
})

test('passes status through', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const s = await svc.getStatus('0xabc')
  assert.equal(s.status, 'success')
})

test('refuses to construct without a Solana blockhash provider — fail at boot, not mid-request', () => {
  // Before this guard, an omitted provider surfaced only when a Solana
  // request actually hit blockhash.get() — deep inside a request handler,
  // after a live Relay round trip, as a raw "Cannot read properties of
  // undefined (reading 'get')" TypeError turned into an opaque HTTP 400.
  // index.js constructs this service exactly once, at startup, so a wiring
  // bug here belongs at that one call site, not at the first unlucky
  // request.
  assert.throws(
    () => createQuoteService({ config, fetchImpl: ok() }),
    /blockhash/i,
  )
  assert.throws(
    () => createQuoteService({ config, fetchImpl: ok(), blockhash: {} }),
    /blockhash/i,
    'an object with no get() method must be rejected the same as a missing one',
  )
})

test('toWei converts a decimal ETH string to integer wei', () => {
  assert.equal(toWei('0.02'), '20000000000000000')
  assert.equal(toWei('.5'), '500000000000000000')
  assert.equal(toWei('1.'), '1000000000000000000')
})

test('toWei rejects malformed input with its own message, distinct from non-positive', () => {
  // Well-formed but zero magnitude: the "positive number" message applies.
  assert.throws(() => toWei('0'), /amount must be a positive number/)
  // Not a valid decimal representation at all: a different message applies,
  // because reporting these as "must be a positive number" is inaccurate —
  // toWei never got far enough to evaluate a sign or magnitude.
  assert.throws(() => toWei('-1'), /amount must be a valid decimal number/)
  assert.throws(() => toWei('abc'), /amount must be a valid decimal number/)
  assert.throws(() => toWei(''), /amount must be a valid decimal number/)
  assert.throws(() => toWei('1e-3'), /amount must be a valid decimal number/)
  // Well-formed and positive, but more precision than 18 decimals supports:
  // its own distinct message, unchanged by this fix round.
  assert.throws(() => toWei('0.' + '1'.repeat(19)), /more than 18 decimal places/)
})

const SOLANA_CHAIN = 792703809

/**
 * Same token as the shared `config` above, but with the $25 USD minimum
 * lowered to $1.
 *
 * The captured Solana fixture (RELAY_SOLANA_QUOTE) is a genuine live quote
 * for a real 0.25 SOL trade — about $19, below the $25 production default.
 * These tests exist to pin Solana-specific behaviour (currency selection,
 * VM-aware validation, transaction assembly), which is orthogonal to the USD
 * gate; that gate already has its own dedicated tests above, against the EVM
 * fixture. Reusing the shared $25 `config` here would fail every
 * success-path Solana test on a check unrelated to what each test verifies.
 */
function solanaTestConfig() {
  return buildConfig({ TOKEN_ADDRESS: PONSY_ADDRESS, MIN_TRADE_USD: '1' })
}

function solanaService(overrides = {}) {
  return createQuoteService({
    config: solanaTestConfig(),
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
  /* steps and solanaTx are the two VM-specific signing payloads the frontend
     dispatches on — mutually exclusive by construction (quote.js builds
     exactly one via its isSolana if/else), but nothing asserted that here
     before. A regression that started attaching `steps` alongside solanaTx
     in this branch (eg. a stray fall-through, or a "just in case" default)
     would stay green without this line. */
  assert.equal(q.steps, undefined, 'a Solana quote must NOT carry EVM-shaped steps')
  assert.equal(q.vm, 'svm', 'a positive discriminator, not inferred from which tx field is absent')
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
  await createQuoteService({ config: solanaTestConfig(), fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)

  assert.equal(body.originCurrency, '11111111111111111111111111111111')
  assert.equal(body.originChainId, SOLANA_CHAIN)
  assert.equal(body.user, SOL_PAYER)
  assert.equal(body.recipient, EVM_RECIPIENT, 'the EVM wallet receives, not the payer')
  assert.equal(body.destinationCurrency, PONSY_ADDRESS.toLowerCase())
  // Mutating quote.js's amount line to toWei(amount) (18 decimals) instead
  // of toLamports(amount) (9) leaves every other assertion in this file
  // untouched — this is the one line that decides how much money moves.
  assert.equal(body.amount, '250000000', 'SOL has 9 decimals — wei scaling here is a 10^9 error')
})

test('rejects a Solana origin with no recipient — never guess a destination', async () => {
  await assert.rejects(
    () => solanaService().getQuote({ user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25' }),
    /recipient/i,
  )
})

test('rejects the zero address as a Solana recipient — unrecoverable, not just unusual', async () => {
  // Unreachable on EVM (the recipient there is always the connected
  // wallet), but a Solana recipient is free-form: a frontend bug or a
  // crafted link could otherwise produce a signable transaction that
  // delivers PONSY to the burn address, and it would round-trip as an
  // ordinary-looking HTTP 200 today.
  await assert.rejects(
    () => solanaService().getQuote({
      user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25',
      recipient: '0x0000000000000000000000000000000000000000',
    }),
    /zero address/i,
  )
})

test('rejects an EVM address as the payer on a Solana origin', async () => {
  await assert.rejects(
    () => solanaService().getQuote({
      user: EVM_RECIPIENT, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
    }),
    // Deliberately the exact message, not the looser /base58|Solana/i this
    // started as: that pattern also matches @solana/web3.js's own incidental
    // "Non-base58 character" error, so it kept passing even with the
    // BASE58_RE guard in quote.js deleted entirely.
    /user must be a base58 Solana address/,
  )
})

test('rejects a base58 payer on an EVM origin', async () => {
  await assert.rejects(
    () => solanaService().getQuote({ user: SOL_PAYER, chainId: 8453, amount: '0.02' }),
    /user must be/,
  )
})

test('an EVM origin ignores a supplied recipient — the payer always receives', async () => {
  // Not just "defaults when absent": recipient became reachable from the
  // query string in 58f48cc (src/server.js's /quote route), so a mutation
  // that let a caller override the EVM receiver — e.g. `receiver = recipient
  // ?? user`, or `isSolana = origin === SOLANA_CHAIN_ID || !!recipient` —
  // would let ?chainId=8453&user=0xVictim&recipient=0xAttacker redirect the
  // swap output while the victim's wallet shows only an ordinary deposit to
  // Relay. A test that never supplies a recipient cannot distinguish
  // "defaults to the payer" from "ignores whatever it's given" — this one
  // supplies an adversarial one and asserts it never reaches the request.
  const fetchImpl = ok()
  await createQuoteService({ config, fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 8453, amount: '0.02',
    recipient: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.recipient, USER, 'the payer receives — a caller-supplied recipient must be ignored on EVM')
  assert.equal(body.amount, '20000000000000000')
})

test('coerces array-wrapped query params (?user[0]=...) to plain strings before forwarding', async () => {
  // Express turns ?user[0]=<value> into a one-element array. String() of a
  // one-element array equals its bare element, so the BASE58_RE/ADDRESS_RE
  // checks in quote.js are fooled into passing — this test is not about
  // validation, which already tolerates this input, but about what
  // happens to it AFTER validation. Before forwarding was fixed to
  // re-stringify, the raw array reached both the Relay request body and
  // buildSolanaTransaction's feePayer unchanged: new PublicKey([SOL_PAYER])
  // does not throw, it silently yields the all-zeros system-program key
  // (confirmed directly against @solana/web3.js). That this fixture's
  // instructions happen not to declare that bogus key a signer is the only
  // reason the old code threw instead of silently signing with the wrong
  // fee payer — incidental protection, not a guarantee.
  const fetchImpl = stubFetch([['/quote', async () => RELAY_SOLANA_QUOTE]])
  const q = await createQuoteService({
    config: solanaTestConfig(), fetchImpl, blockhash: stubBlockhash,
  }).getQuote({
    user: [SOL_PAYER], chainId: SOLANA_CHAIN, amount: '0.25', recipient: [EVM_RECIPIENT],
  })

  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.user, SOL_PAYER)
  assert.equal(typeof body.user, 'string')
  assert.equal(body.recipient, EVM_RECIPIENT)
  assert.equal(typeof body.recipient, 'string')
  assert.ok(q.solanaTx, 'feePayer must resolve to the real payer, not a bogus PublicKey built from an array')
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

test('the $25 minimum is not bypassed for a Solana origin', async () => {
  // Uses the shared, real `config` (the $25 production default) rather than
  // solanaTestConfig() — this is the one test in this file that must NOT
  // lower the minimum, because its entire point is to prove the gate still
  // fires on this path. RELAY_SOLANA_QUOTE is a genuine captured trade
  // (~$19: see currencyIn.amountUsd in fixtures.js) that is honestly below
  // $25, not a fixture altered to dodge the check.
  const svc = createQuoteService({
    config,
    fetchImpl: stubFetch([['/quote', async () => RELAY_SOLANA_QUOTE]]),
    blockhash: stubBlockhash,
  })
  await assert.rejects(
    () => svc.getQuote({
      user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
    }),
    /minimum trade is \$25/,
  )
})

test('toLamports converts a decimal SOL string to integer lamports, at 9 decimals', () => {
  // Mirrors toWei's own pinning test, at SOL's 9 decimals instead of 18 —
  // 0.25 SOL is exactly the 250000000 lamports the live fixture captures.
  assert.equal(toLamports('0.25'), '250000000')
  assert.equal(toLamports('1'), '1000000000')
})

test('defaults to the native asset when no token is named', async () => {
  const fetchImpl = ok()
  await createQuoteService({ config, fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 8453, amount: '0.02',
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.originCurrency, '0x0000000000000000000000000000000000000000')
})

test('sends the allowlisted address for a named token', async () => {
  const fetchImpl = ok()
  await createQuoteService({ config, fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 8453, amount: '40', token: 'usdc',
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.originCurrency, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
})

test('scales by the token decimals, not by 18', async () => {
  /* USDC is 6 decimals. Scaling 40 by 18 would send 4e19 instead of 4e7 —
     a 10^12 error. */
  const fetchImpl = ok()
  await createQuoteService({ config, fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 8453, amount: '40', token: 'usdc',
  })
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).amount, '40000000')
})

test('uses 18 decimals for USDC on BNB Chain, where it is a BEP-20 re-issue', async () => {
  const fetchImpl = ok()
  await createQuoteService({ config, fetchImpl, blockhash: stubBlockhash }).getQuote({
    user: USER, chainId: 56, amount: '40', token: 'usdc',
  })
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).amount, '40000000000000000000')
})

test('refuses a token address supplied by the caller', async () => {
  await assert.rejects(
    () => createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash }).getQuote({
      user: USER, chainId: 8453, amount: '40',
      token: '0xd314ee5350570e57c8e2e5bb6b3920cd1a16083e',
    }),
    /not available/,
  )
})

test('refuses an SPL token on Solana before calling Relay', async () => {
  const fetchImpl = ok()
  await assert.rejects(
    () => createQuoteService({ config, fetchImpl, blockhash: stubBlockhash }).getQuote({
      user: SOL_PAYER, chainId: 792703809, amount: '1',
      recipient: EVM_RECIPIENT, token: 'usdc',
    }),
    /not available/,
  )
  assert.equal(fetchImpl.calls.length, 0, 'must not reach Relay')
})

test('returns every step for a two-step quote, in order', async () => {
  const svc = createQuoteService({
    config,
    fetchImpl: stubFetch([['/quote', async () => RELAY_APPROVE_QUOTE]]),
    blockhash: stubBlockhash,
  })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '40', token: 'usdc' })

  assert.equal(q.steps.length, 2)
  assert.deepEqual(q.steps.map((s) => s.id), ['approve', 'deposit'])
  assert.equal(q.steps[0].tx.to, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  assert.equal(q.steps[1].tx.to, '0x4cd00e387622c35bddb9b4c962c136462338bc31')
  // The other half of the single-step ternary (`{ steps, tx: ... }` vs
  // `{ steps }`) — a client that predates the steps array must fail loudly
  // on a two-step quote rather than sign the approval and stop.
  assert.ok(!('tx' in q), 'tx must be entirely absent on a multi-step quote, not undefined')
  // A hardcoded "one transaction" here would tell the user to expect one
  // signature on the exact path that requires two.
  assert.equal(q.route, 'Base to Robinhood Chain, 2 transactions')
})

test('validates every step, not just the first — a missing `to` on a later step fails on that step', async () => {
  // The only prior guard test used the single-step fixture, so it could not
  // tell "every step" from "the first step". This deletes `to` from the
  // SECOND step of a two-step fixture — restricting the check to steps[0],
  // or deleting it outright, stays green without this.
  const { to, ...dataWithoutTo } = RELAY_APPROVE_QUOTE.steps[1].items[0].data
  const badDeposit = {
    ...RELAY_APPROVE_QUOTE,
    steps: [
      RELAY_APPROVE_QUOTE.steps[0],
      { ...RELAY_APPROVE_QUOTE.steps[1], items: [{ ...RELAY_APPROVE_QUOTE.steps[1].items[0], data: dataWithoutTo }] },
    ],
  }
  const svc = createQuoteService({
    config,
    fetchImpl: stubFetch([['/quote', async () => badDeposit]]),
    blockhash: stubBlockhash,
  })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '40', token: 'usdc' }),
    /Relay step "deposit" has no transaction to sign/,
  )
})

test('validates every step, not just the first — a missing `from` on a later step fails on that step', async () => {
  const { from, ...dataWithoutFrom } = RELAY_APPROVE_QUOTE.steps[1].items[0].data
  const badDeposit = {
    ...RELAY_APPROVE_QUOTE,
    steps: [
      RELAY_APPROVE_QUOTE.steps[0],
      { ...RELAY_APPROVE_QUOTE.steps[1], items: [{ ...RELAY_APPROVE_QUOTE.steps[1].items[0], data: dataWithoutFrom }] },
    ],
  }
  const svc = createQuoteService({
    config,
    fetchImpl: stubFetch([['/quote', async () => badDeposit]]),
    blockhash: stubBlockhash,
  })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '40', token: 'usdc' }),
    /Relay step "deposit" has no sending account/,
  )
})

test('the $25 minimum is not bypassed for a named token', async () => {
  // Same shape as 'the $25 minimum is not bypassed for a Solana origin' —
  // `token` is a new input to the one control this layer exists to enforce,
  // and gating the minimum on originToken.key === 'native' would stay green
  // everywhere else while quietly skipping the check for every named token.
  const tiny = {
    ...RELAY_APPROVE_QUOTE,
    details: {
      ...RELAY_APPROVE_QUOTE.details,
      currencyIn: { ...RELAY_APPROVE_QUOTE.details.currencyIn, amountUsd: '5.00' },
    },
  }
  const svc = createQuoteService({
    config,
    fetchImpl: stubFetch([['/quote', async () => tiny]]),
    blockhash: stubBlockhash,
  })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '40', token: 'usdc' }),
    /minimum trade is \$25/,
  )
})

test('a single-step quote still carries tx, so existing clients keep working', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })

  assert.equal(q.steps.length, 1)
  assert.equal(q.steps[0].id, 'deposit')
  assert.ok(q.tx, 'tx must remain for single-step quotes')
  assert.equal(q.tx.to, q.steps[0].tx.to)
})

test('reports the resolved token so the UI can label the amount', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '40', token: 'usdc' })
  assert.equal(q.token.symbol, 'USDC')
  assert.equal(q.token.decimals, 6)
})

test('reports vm: "evm" for an EVM origin — a field an executor can always branch on', async () => {
  // The defensive `quote.steps ?? []` idiom silently iterates zero steps and
  // reports success on a Solana quote, having signed nothing. `vm` gives
  // Task 4 a field that is always present and always meaningful, instead of
  // inferring the VM from which of tx/steps/solanaTx happens to be missing.
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: stubBlockhash })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
  assert.equal(q.vm, 'evm')
})

test('the EVM path never calls the blockhash provider', async () => {
  // The blockhash fetch is Solana-only. A regression that started the
  // blockhash promise unconditionally (eg. hoisting `blockhash.get()` above
  // the isSolana check to "simplify" the concurrency fix) would waste a
  // Solana RPC call on every EVM quote and, worse, would throw here — this
  // stub fails loudly if it is ever invoked.
  let called = false
  const neverCalled = {
    get: async () => {
      called = true
      throw new Error('blockhash.get() must not be called on the EVM path')
    },
  }
  const svc = createQuoteService({ config, fetchImpl: ok(), blockhash: neverCalled })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })
  assert.equal(called, false, 'an EVM quote must never fetch a Solana blockhash')
  assert.equal(q.vm, 'evm')
})

test('the Solana path starts the Relay quote and the blockhash fetch concurrently, not sequentially', async () => {
  /* Timing-independent by construction, per the review's own warning: a test
     that waits on a clock (eg. asserting elapsed time < 16s) would pass on
     both the old sequential code and the new concurrent code on a fast
     enough machine, and flake under CI load either way. Instead this proves
     overlap directly — both calls must have been STARTED before either is
     allowed to finish.

     Under the old code, blockhash.get() is only called after `raw = await
     fetchRelayQuote(...)` has already resolved. Since fetchImpl below never
     resolves until releaseRelay() is called, the assertions below run while
     that first await is still pending — so under the old sequential code,
     blockhashCalled would still be false at that point, and this test fails
     exactly as intended. */
  let relayCalled = false
  let blockhashCalled = false
  let releaseRelay
  const relayGate = new Promise((resolve) => { releaseRelay = resolve })

  const fetchImpl = async () => {
    relayCalled = true
    await relayGate
    return { ok: true, status: 200, json: async () => RELAY_SOLANA_QUOTE }
  }
  const blockhash = {
    get: async () => {
      blockhashCalled = true
      return { blockhash: SOL_BLOCKHASH, lastValidBlockHeight: 280000000 }
    },
  }

  const svc = createQuoteService({ config: solanaTestConfig(), fetchImpl, blockhash })
  const pending = svc.getQuote({
    user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
  })

  // Both calls have already been issued at this point — synchronously, in
  // program order, before getQuote's first `await` on the (still-gated)
  // Relay response yields control back here.
  assert.equal(relayCalled, true, 'the Relay quote request must have started')
  assert.equal(
    blockhashCalled, true,
    'the blockhash fetch must already be in flight, not waiting on the Relay quote to resolve first',
  )

  releaseRelay()
  const q = await pending
  assert.ok(q.solanaTx, 'the quote must still complete correctly once both calls resolve')
})

test('a Relay failure on the Solana path does not produce an unhandled rejection', async () => {
  /* Models the exact trap the concurrency fix has to avoid: the Relay call
     fails first (a very ordinary outcome), while the blockhash fetch — kicked
     off concurrently, per the test above — is still in flight and rejects
     only afterwards. If nothing has attached a handler to that promise by
     then, Node considers it an unhandled rejection and (under the default
     --unhandled-rejections=throw) crashes the process — worse than the
     timeout bug this whole change fixes. This test fails if the no-op
     `.catch(() => {})` in quote.js is removed: with it removed, the delayed
     rejection below is observed by nothing (the `isSolana` branch that would
     `await pendingBlockhash` is never reached, because fetchRelayQuote threw
     first), so Node emits 'unhandledRejection' and the listener installed
     below records it, failing the final assertion. */
  let unhandled = null
  const onUnhandledRejection = (err) => { unhandled = err }
  process.on('unhandledRejection', onUnhandledRejection)

  try {
    const fetchImpl = async () => {
      throw new Error('Relay is down')
    }
    const blockhash = {
      get: async () => {
        // Rejects on a later tick, after the Relay failure has already been
        // thrown and caught below — reproducing "the blockhash promise
        // nobody has awaited yet rejects with no handler."
        await new Promise((resolve) => setImmediate(resolve))
        throw new Error('blockhash RPC failed')
      },
    }
    const svc = createQuoteService({ config: solanaTestConfig(), fetchImpl, blockhash })

    await assert.rejects(
      () => svc.getQuote({
        user: SOL_PAYER, chainId: SOLANA_CHAIN, amount: '0.25', recipient: EVM_RECIPIENT,
      }),
      /Relay is down/,
    )

    // Give the event loop several turns so the blockhash promise's delayed
    // rejection — and, if unhandled, Node's 'unhandledRejection' event for
    // it — has every opportunity to fire before this test finishes.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    assert.equal(
      unhandled, null,
      'the still-pending blockhash promise must not surface as an unhandled rejection',
    )
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
  }
})
