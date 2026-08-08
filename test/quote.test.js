import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/config.js'
import { createQuoteService } from '../src/quote.js'
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
