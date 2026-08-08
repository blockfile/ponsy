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
