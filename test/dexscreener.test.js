import test from 'node:test'
import assert from 'node:assert/strict'

import { selectPair, fetchPrice } from '../src/sources/dexscreener.js'
import { TOKEN_ADDRESS, WETH_ADDRESS, DEXSCREENER_TOKENS, stubFetch } from './fixtures.js'

test('selects the live PONSY/WETH pair', () => {
  const pair = selectPair(DEXSCREENER_TOKENS.pairs, TOKEN_ADDRESS)
  assert.equal(pair.priceUsd, '0.000003858')
})

test('matches the token case-insensitively', () => {
  const pair = selectPair(
    DEXSCREENER_TOKENS.pairs,
    '0x0c5B5eF209dd8c9C84B6EF2e19c46a48fCa0e33E',
  )
  assert.ok(pair)
})

test('ignores pairs on other chains', () => {
  /* The same address can be deployed on another chain. Pricing our token off a
     namesake elsewhere is worse than having no price. */
  const pairs = [{ ...DEXSCREENER_TOKENS.pairs[0], chainId: 'base' }]
  assert.equal(selectPair(pairs, TOKEN_ADDRESS), null)
})

test('ignores pairs where our token is the quote side', () => {
  /* Dexscreener's priceUsd is always the price of baseToken. If our token is
     the quote, that number belongs to something else entirely. */
  const pairs = [
    {
      ...DEXSCREENER_TOKENS.pairs[0],
      baseToken: { address: WETH_ADDRESS },
      quoteToken: { address: TOKEN_ADDRESS },
    },
  ]
  assert.equal(selectPair(pairs, TOKEN_ADDRESS), null)
})

test('prefers the deepest pool when several exist', () => {
  const shallow = {
    ...DEXSCREENER_TOKENS.pairs[0],
    priceUsd: '0.000009999',
    liquidity: { usd: 12 },
  }
  const deep = {
    ...DEXSCREENER_TOKENS.pairs[0],
    priceUsd: '0.000003858',
    liquidity: { usd: 3753.81 },
  }

  assert.equal(selectPair([shallow, deep], TOKEN_ADDRESS).priceUsd, '0.000003858')
  assert.equal(selectPair([deep, shallow], TOKEN_ADDRESS).priceUsd, '0.000003858')
})

test('skips pairs with an unusable priceUsd', () => {
  const pairs = [{ ...DEXSCREENER_TOKENS.pairs[0], priceUsd: null }]
  assert.equal(selectPair(pairs, TOKEN_ADDRESS), null)
})

test('returns null for a missing or malformed pairs array', () => {
  assert.equal(selectPair(undefined, TOKEN_ADDRESS), null)
  assert.equal(selectPair([], TOKEN_ADDRESS), null)
})

test('fetchPrice returns price and liquidity', async () => {
  const result = await fetchPrice(
    'https://api.dexscreener.com',
    TOKEN_ADDRESS,
    { fetchImpl: stubFetch([['/latest/dex/tokens/', async () => DEXSCREENER_TOKENS]]) },
  )

  assert.equal(result.priceUsd, 0.000003858)
  assert.equal(result.liquidityUsd, 3753.81)
})

test('fetchPrice throws when the token is not indexed', async () => {
  await assert.rejects(
    () =>
      fetchPrice('https://api.dexscreener.com', TOKEN_ADDRESS, {
        fetchImpl: stubFetch([['/latest/dex/tokens/', async () => ({ pairs: [] })]]),
      }),
    /no indexed pair/,
  )
})
