import test from 'node:test'
import assert from 'node:assert/strict'

import { priceFromSqrtX96, toWholeTokens } from '../src/chain/uniswapV3.js'
import { SQRT_PRICE_X96 } from './fixtures.js'

test('prices PONSY as token1 against the live pool', () => {
  /* The real pool has WETH as token0 and PONSY as token1, so this exercises the
     inverted branch. Dexscreener independently reported priceNative
     0.000000002012 for the same block range; agreeing with a source that
     derived it separately is what makes this a real check and not a
     restatement of our own arithmetic. */
  const price = priceFromSqrtX96({
    sqrtPriceX96: SQRT_PRICE_X96,
    token0Decimals: 18,
    token1Decimals: 18,
    baseIsToken0: false,
  })

  assert.ok(
    Math.abs(price - 2.012e-9) / 2.012e-9 < 0.001,
    `expected ~2.012e-9, got ${price}`,
  )
})

test('the two orderings are reciprocals', () => {
  const asToken1 = priceFromSqrtX96({
    sqrtPriceX96: SQRT_PRICE_X96,
    token0Decimals: 18,
    token1Decimals: 18,
    baseIsToken0: false,
  })
  const asToken0 = priceFromSqrtX96({
    sqrtPriceX96: SQRT_PRICE_X96,
    token0Decimals: 18,
    token1Decimals: 18,
    baseIsToken0: true,
  })

  assert.ok(
    Math.abs(asToken0 * asToken1 - 1) < 1e-9,
    `reciprocal check failed: ${asToken0} * ${asToken1}`,
  )
})

test('price is 1.0 when sqrtPriceX96 is exactly 2^96 and decimals match', () => {
  const price = priceFromSqrtX96({
    sqrtPriceX96: 1n << 96n,
    token0Decimals: 18,
    token1Decimals: 18,
    baseIsToken0: true,
  })
  assert.equal(price, 1)
})

test('mismatched decimals shift the price by the decimal difference', () => {
  /* A 1:1 raw ratio between an 18-decimal token0 and a 6-decimal token1 means
     one whole token0 buys 10^12 whole token1. Getting this backwards is the
     classic Uniswap pricing bug, so it is pinned explicitly. */
  const price = priceFromSqrtX96({
    sqrtPriceX96: 1n << 96n,
    token0Decimals: 18,
    token1Decimals: 6,
    baseIsToken0: true,
  })
  assert.equal(price, 1e12)
})

test('retains resolution on very small prices', () => {
  /* At 10^18 scaling this would truncate toward zero and render as a $0 market
     cap. The 10^36 factor is what stops that, so it is worth a test. */
  const tiny = priceFromSqrtX96({
    sqrtPriceX96: 1n << 60n,
    token0Decimals: 18,
    token1Decimals: 18,
    baseIsToken0: true,
  })
  assert.ok(tiny > 0, 'tiny price floored to zero')
  const expected = Number(2n ** 120n) / Number(2n ** 192n)
  assert.ok(Math.abs(tiny - expected) / expected < 1e-9)
})

test('rejects an uninitialised pool rather than dividing by zero', () => {
  assert.throws(
    () =>
      priceFromSqrtX96({
        sqrtPriceX96: 0n,
        token0Decimals: 18,
        token1Decimals: 18,
        baseIsToken0: true,
      }),
    /uninitialised/,
  )
})

test('rejects a non-bigint sqrtPriceX96', () => {
  assert.throws(
    () =>
      priceFromSqrtX96({
        sqrtPriceX96: 1.5,
        token0Decimals: 18,
        token1Decimals: 18,
        baseIsToken0: true,
      }),
    TypeError,
  )
})

test('rejects out-of-range decimals', () => {
  assert.throws(
    () =>
      priceFromSqrtX96({
        sqrtPriceX96: 1n << 96n,
        token0Decimals: 99,
        token1Decimals: 18,
        baseIsToken0: true,
      }),
    /token0Decimals/,
  )
})

test('toWholeTokens converts a 1e27 raw supply exactly', () => {
  assert.equal(toWholeTokens(10n ** 27n, 18), 1_000_000_000)
})

test('toWholeTokens keeps the fractional part', () => {
  assert.equal(toWholeTokens(1_500_000n, 6), 1.5)
})

test('toWholeTokens handles zero decimals', () => {
  assert.equal(toWholeTokens(42n, 0), 42)
})

test('toWholeTokens rejects a non-bigint amount', () => {
  assert.throws(() => toWholeTokens(1e27, 18), TypeError)
})
