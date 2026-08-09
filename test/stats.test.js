import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/config.js'
import { createStatsService } from '../src/stats.js'
import { SELECTORS } from '../src/chain/abi.js'
import {
  TOKEN_ADDRESS,
  POOL_ADDRESS,
  WETH_ADDRESS,
  SLOT0_RETURNDATA,
  TOKEN0_RETURNDATA,
  TOKEN1_RETURNDATA,
  TOTAL_SUPPLY_RETURNDATA,
  DECIMALS_18_RETURNDATA,
  BLOCKSCOUT_COUNTERS,
  BLOCKSCOUT_STATS,
  DEXSCREENER_TOKENS,
  stubFetch,
} from './fixtures.js'

/** Live figures at the captured block, for asserting against. */
const ETH_USD = 1919.5
const EXPECTED_PRICE = 2.0126382886740487e-9 * ETH_USD
const EXPECTED_MCAP = EXPECTED_PRICE * 1_000_000_000

function config(overrides = {}) {
  return buildConfig({
    TOKEN_ADDRESS,
    POOL_ADDRESS,
    WETH_ADDRESS,
    ...overrides,
  })
}

/**
 * RPC stub that answers by (to, selector) rather than by position, so a change
 * in batching order does not quietly invalidate the test.
 */
function stubRpc({ fail = null, overrides = {} } = {}) {
  return {
    async ethCallBatch(calls) {
      if (fail) throw new Error(fail)
      return calls.map(({ to, data }) => {
        const key = `${to.toLowerCase()}:${data}`
        if (key in overrides) {
          const v = overrides[key]
          if (v instanceof Error) throw v
          return v
        }
        if (data === SELECTORS.totalSupply) return TOTAL_SUPPLY_RETURNDATA
        if (data === SELECTORS.decimals) return DECIMALS_18_RETURNDATA
        if (data === SELECTORS.slot0) return SLOT0_RETURNDATA
        if (data === SELECTORS.token0) return TOKEN0_RETURNDATA
        if (data === SELECTORS.token1) return TOKEN1_RETURNDATA
        throw new Error(`unexpected call ${key}`)
      })
    },
  }
}

const HAPPY_ROUTES = [
  ['/api/v2/tokens/', async () => BLOCKSCOUT_COUNTERS],
  ['/api/v2/stats', async () => BLOCKSCOUT_STATS],
  ['/latest/dex/tokens/', async () => DEXSCREENER_TOKENS],
]

test('prices from the pool when everything is healthy', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
  })

  const stats = await svc.collect()

  assert.equal(stats.source.price, 'pool')
  assert.equal(stats.source.holders, 'blockscout')
  assert.equal(stats.holders, 126)
  assert.equal(stats.totalSupply, 1_000_000_000)
  assert.ok(Math.abs(stats.marketCap - EXPECTED_MCAP) < 0.01)
  assert.equal(stats.placeholder, false)
  assert.deepEqual(stats.warnings, [])
})

test('emits the exact field names the frontend normalise() reads', async () => {
  /* src/lib/stats.js in the frontend reads raw.marketCap and raw.holders. This
     is the contract that lets the site go live without a code change, so it is
     asserted directly rather than left implicit. */
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
  })

  const stats = await svc.collect()

  assert.ok('marketCap' in stats, 'payload must carry marketCap')
  assert.ok('holders' in stats, 'payload must carry holders')
  assert.equal(typeof stats.marketCap, 'number')
  assert.equal(typeof stats.holders, 'number')
})

test('falls back to Dexscreener when the chain read fails', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc({ fail: 'rpc unreachable' }),
    fetchImpl: stubFetch(HAPPY_ROUTES),
  })

  const stats = await svc.collect()

  assert.equal(stats.source.price, 'dexscreener')
  assert.equal(stats.priceUsd, 0.000003858)
  assert.equal(stats.holders, 126, 'holders should survive an RPC outage')
  /* Supply comes from the RPC, so with the chain down the market cap cannot be
     derived. Reporting null beats multiplying by a guessed supply. */
  assert.equal(stats.totalSupply, null)
  assert.equal(stats.marketCap, null)
  assert.ok(stats.warnings.some((w) => w.includes('rpc unreachable')))
})

test('runs the Dexscreener fallback concurrently with the rest, not after it', async () => {
  /* Regression test for the production 504 incident. Previously, collect()
     ran holders/chain/ETH-price in Promise.allSettled and THEN, only on
     failure, awaited Dexscreener sequentially afterwards. With
     POOL_ADDRESS unset (chain.priceInWeth always null — the production
     configuration, because the live pool is Uniswap v4 and this reader only
     prices v3) that "fallback" ran on every request, back to back with the
     settle group: worst case upstreamTimeoutMs x2 (16s at the 8s default),
     past nginx's 15s proxy_read_timeout.
     Each upstream here carries the same artificial delay. If they still ran
     sequentially, this would take roughly 2x as long as it does. */
  const DELAY_MS = 200
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))

  const baseRpc = stubRpc()
  const rpc = {
    async ethCallBatch(calls, opts) {
      await delay(DELAY_MS)
      return baseRpc.ethCallBatch(calls, opts)
    },
  }

  const baseFetch = stubFetch(HAPPY_ROUTES)
  const fetchImpl = async (url, init) => {
    await delay(DELAY_MS)
    return baseFetch(url, init)
  }

  const svc = createStatsService({
    config: config({ POOL_ADDRESS: '' }), // forces the Dexscreener path, as in production
    rpc,
    fetchImpl,
  })

  const startedAt = Date.now()
  const stats = await svc.collect()
  const elapsedMs = Date.now() - startedAt

  assert.equal(stats.source.price, 'dexscreener')
  assert.ok(
    elapsedMs < DELAY_MS * 1.75,
    `expected concurrent upstream calls (~${DELAY_MS}ms), took ${elapsedMs}ms — looks sequential`,
  )
})

test('falls back to Dexscreener when no pool is configured', async () => {
  const svc = createStatsService({
    config: config({ POOL_ADDRESS: '' }),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
  })

  const stats = await svc.collect()

  assert.equal(stats.source.price, 'dexscreener')
  /* Supply still comes off-chain from the RPC, so the market cap is real. */
  assert.equal(stats.totalSupply, 1_000_000_000)
  assert.ok(Math.abs(stats.marketCap - 0.000003858 * 1e9) < 0.01)
})

test('refuses on-chain pricing when the pool is not a WETH pair', async () => {
  /* A USDC pair would be priced ~1900x too high by the ETH multiplication, and
     the result would still look like a plausible market cap. The guard must
     reject and fall back rather than publish it. */
  const usdc = '0x' + '11'.repeat(20)
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc({
      overrides: {
        [`${POOL_ADDRESS}:${SELECTORS.token0}`]:
          '0x000000000000000000000000' + '11'.repeat(20),
      },
    }),
    fetchImpl: stubFetch(HAPPY_ROUTES),
  })

  const stats = await svc.collect()

  assert.equal(stats.source.price, 'dexscreener')
  assert.ok(
    stats.warnings.some((w) => w.includes('is not WETH')),
    `expected a WETH-pair warning, got ${JSON.stringify(stats.warnings)}`,
  )
  assert.ok(usdc)
})

test('rejects a pool that does not hold the token at all', async () => {
  const other = '0x000000000000000000000000' + '22'.repeat(20)
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc({
      overrides: {
        [`${POOL_ADDRESS}:${SELECTORS.token0}`]: other,
        [`${POOL_ADDRESS}:${SELECTORS.token1}`]: other,
      },
    }),
    fetchImpl: stubFetch(HAPPY_ROUTES),
  })

  const stats = await svc.collect()
  assert.ok(stats.warnings.some((w) => w.includes('does not hold TOKEN_ADDRESS')))
})

test('returns holders as null but keeps the market cap when the explorer fails', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch([
      ['/api/v2/tokens/', async () => new Error('explorer down')],
      ['/api/v2/stats', async () => BLOCKSCOUT_STATS],
      ['/latest/dex/tokens/', async () => DEXSCREENER_TOKENS],
    ]),
  })

  const stats = await svc.collect()

  assert.equal(stats.holders, null)
  assert.equal(stats.source.holders, 'none')
  assert.ok(Math.abs(stats.marketCap - EXPECTED_MCAP) < 0.01, 'mcap should survive')
})

test('falls back to Dexscreener when ETH/USD is unavailable', async () => {
  /* A pool price is denominated in WETH. Without an ETH price it cannot become
     a dollar figure, so the pool path is unusable even though it succeeded. */
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc(),
    fetchImpl: stubFetch([
      ['/api/v2/tokens/', async () => BLOCKSCOUT_COUNTERS],
      ['/api/v2/stats', async () => new Error('stats endpoint down')],
      ['/latest/dex/tokens/', async () => DEXSCREENER_TOKENS],
    ]),
  })

  const stats = await svc.collect()
  assert.equal(stats.source.price, 'dexscreener')
  assert.equal(stats.holders, 126)
})

test('reports nulls, not an error, when every source is down', async () => {
  const svc = createStatsService({
    config: config(),
    rpc: stubRpc({ fail: 'rpc unreachable' }),
    fetchImpl: stubFetch([
      ['/api/v2/tokens/', async () => new Error('down')],
      ['/api/v2/stats', async () => new Error('down')],
      ['/latest/dex/tokens/', async () => new Error('down')],
    ]),
  })

  const stats = await svc.collect()

  assert.equal(stats.marketCap, null)
  assert.equal(stats.holders, null)
  assert.equal(stats.priceUsd, null)
  assert.ok(stats.warnings.length >= 4)
})

test('returns the pre-launch placeholder when TOKEN_ADDRESS is unset', async () => {
  const svc = createStatsService({
    config: buildConfig({}),
    rpc: stubRpc(),
    fetchImpl: stubFetch(HAPPY_ROUTES),
  })

  const stats = await svc.collect()

  assert.equal(stats.placeholder, true)
  assert.equal(stats.marketCap, null)
  assert.equal(stats.holders, null)
  assert.deepEqual(stats.warnings, ['TOKEN_ADDRESS is not set'])
})

test('touches no upstream at all before launch', async () => {
  const fetchImpl = stubFetch(HAPPY_ROUTES)
  const svc = createStatsService({ config: buildConfig({}), rpc: stubRpc(), fetchImpl })

  await svc.collect()

  assert.equal(fetchImpl.calls.length, 0)
})
