import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/config.js'
import { createQuoteService, toWei } from '../src/quote.js'
import { RELAY_QUOTE, RELAY_STATUS_SUCCESS, PONSY_ADDRESS, stubFetch } from './fixtures.js'

const USER = '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E'
const config = buildConfig({ TOKEN_ADDRESS: PONSY_ADDRESS })
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

test('exposes fee, rate, time estimate and route alongside the amounts', async () => {
  const svc = createQuoteService({ config, fetchImpl: ok() })
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
  const svc = createQuoteService({ config, fetchImpl: ok() })
  const q = await svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' })

  // Full object, including `data` — that's the calldata the wallet actually
  // signs; a regression that drops or corrupts it must fail this test.
  assert.deepEqual(q.tx, {
    from: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
    to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
    data: '0x49290c1c0000000000000000000000002dfec17b1d8dce43cb5b1111352fd58be01d389e',
    value: '20000000000000000',
    chainId: 8453,
  })
  assert.match(q.requestId, /^0x/)
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
  })
  await assert.rejects(
    () => svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' }),
    /no sending account/,
  )
})

test('sends the hardcoded PONSY address, never one from the caller', async () => {
  const fetchImpl = ok()
  const svc = createQuoteService({ config, fetchImpl })
  await svc.getQuote({
    user: USER, chainId: 8453, amount: '0.02',
    destinationCurrency: '0xd314ee5350570e57c8e2e5bb6b3920cd1a16083e', // impostor
  })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.destinationCurrency, PONSY_ADDRESS.toLowerCase())
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
    })
    await assert.rejects(
      () => svc.getQuote({ user: USER, chainId: 8453, amount: '0.02' }),
      /could not verify/,
      label,
    )
  }
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
