/**
 * STATS ORCHESTRATION
 * -----------------------------------------------------------------------------
 * Composes the /stats payload from three upstreams, and decides what to do when
 * any of them is unavailable.
 *
 * The governing rule throughout: never invent a number. Every field is either a
 * figure we actually derived or null, and `source` always records where it came
 * from. A wrong market cap on a token site is worse than a missing one — people
 * make buying decisions on it.
 */

import { SELECTORS, decodeUint, decodeUint8, decodeAddress } from './chain/abi.js'
import { priceFromSqrtX96, toWholeTokens } from './chain/uniswapV3.js'
import * as blockscout from './sources/blockscout.js'
import * as dexscreener from './sources/dexscreener.js'

/**
 * Reads supply, decimals and — when a pool is configured — the pool price, in
 * as few round trips as possible.
 *
 * @returns {Promise<{supply: number, decimals: number, priceInWeth: number|null}>}
 */
async function readChain({ rpc, config, signal }) {
  const { tokenAddress, poolAddress, wethAddress } = config

  const calls = [
    { to: tokenAddress, data: SELECTORS.totalSupply },
    { to: tokenAddress, data: SELECTORS.decimals },
  ]
  if (poolAddress) {
    calls.push(
      { to: poolAddress, data: SELECTORS.slot0 },
      { to: poolAddress, data: SELECTORS.token0 },
      { to: poolAddress, data: SELECTORS.token1 },
    )
  }

  const results = await rpc.ethCallBatch(calls, { signal })

  const rawSupply = decodeUint(results[0])
  const decimals = decodeUint8(results[1])
  const supply = toWholeTokens(rawSupply, decimals)

  if (!poolAddress) {
    return { supply, decimals, priceInWeth: null }
  }

  /* slot0 packs sqrtPriceX96 into the first word; the rest (tick, observation
     cardinalities, feeProtocol, unlocked) is not needed. */
  const sqrtPriceX96 = decodeUint(results[2])
  const token0 = decodeAddress(results[3])
  const token1 = decodeAddress(results[4])

  const baseIsToken0 = token0 === tokenAddress
  if (!baseIsToken0 && token1 !== tokenAddress) {
    throw new Error(
      `POOL_ADDRESS ${poolAddress} does not hold TOKEN_ADDRESS ${tokenAddress}`,
    )
  }

  /* The counter side must be WETH, because the USD conversion below multiplies
     by the *native coin* price. Against a USDC pool that multiplication would
     be off by the whole ETH price — a ~1900x error that still looks like a
     plausible market cap, which is exactly the kind of wrong number that goes
     unnoticed. Refuse, and let the caller fall back. */
  const counter = baseIsToken0 ? token1 : token0
  if (wethAddress && counter !== wethAddress) {
    throw new Error(
      `pool counter token ${counter} is not WETH (${wethAddress}); ` +
        'on-chain pricing assumes a WETH pair',
    )
  }

  const counterDecimals = decodeUint8(
    (await rpc.ethCallBatch([{ to: counter, data: SELECTORS.decimals }], { signal }))[0],
  )

  const priceInWeth = priceFromSqrtX96({
    sqrtPriceX96,
    token0Decimals: baseIsToken0 ? decimals : counterDecimals,
    token1Decimals: baseIsToken0 ? counterDecimals : decimals,
    baseIsToken0,
  })

  return { supply, decimals, priceInWeth }
}

/**
 * Builds the stats service.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.rpc        createRpcClient instance
 * @param {Function} [deps.fetchImpl]
 */
export function createStatsService({ config, rpc, fetchImpl = fetch }) {
  const httpOpts = { timeoutMs: config.upstreamTimeoutMs, fetchImpl }

  /**
   * Produces one complete stats payload. Throws only if nothing at all could be
   * determined — partial results are returned with nulls in the gaps.
   */
  async function collect({ signal } = {}) {
    if (!config.tokenAddress) {
      /* Pre-launch. Deliberately a successful response with null figures rather
         than an error: the frontend renders null as an em dash, whereas an
         error trips its RETRY panel and tells visitors the site is broken when
         it is merely early. */
      return {
        marketCap: null,
        holders: null,
        priceUsd: null,
        totalSupply: null,
        placeholder: true,
        source: { price: 'none', holders: 'none' },
        warnings: ['TOKEN_ADDRESS is not set'],
      }
    }

    const opts = { ...httpOpts, signal }
    const warnings = []

    /* All four fetched together and settled independently.
       -----------------------------------------------------------------------
       The Dexscreener fallback used to run *after* this group, only when the
       pool path came up empty — sequential by construction: up to
       upstreamTimeoutMs for the group, then up to another upstreamTimeoutMs
       for the fallback, worst case 2x. With POOL_ADDRESS unset (the
       production configuration, because the pool is Uniswap v4 and this
       reader only prices v3), chain.priceInWeth is null on every single
       request, so that "fallback" was not a rare path — it ran every time,
       making the 2x worst case the *typical* case. At the default 8s
       upstreamTimeoutMs that is 16s, past nginx's 15s proxy_read_timeout: a
       guaranteed 504.

       Dexscreener has no data dependency on the chain read — supply and
       decimals come from the RPC, price comes from Dexscreener, and nothing
       here needs the other's output to start — so there was never a reason
       to sequence them. Running it concurrently caps collect()'s worst case
       at one upstreamTimeoutMs (~8s) instead of two, comfortably inside both
       the 10s target and nginx's 15s ceiling. See stats-latency-fix-report.md
       for the full arithmetic. When the pool path succeeds, this result is
       simply discarded (see below) — one extra concurrent request is a fair
       trade for never blocking on it. */
    const [holdersRes, chainRes, ethUsdRes, dexRes] = await Promise.allSettled([
      blockscout.fetchHolders(config.blockscoutUrl, config.tokenAddress, opts),
      readChain({ rpc, config, signal }),
      blockscout.fetchNativeUsd(config.blockscoutUrl, opts),
      dexscreener.fetchPrice(config.dexscreenerUrl, config.tokenAddress, opts),
    ])

    let holders = null
    let holdersSource = 'none'
    if (holdersRes.status === 'fulfilled') {
      holders = holdersRes.value
      holdersSource = 'blockscout'
    } else {
      warnings.push(`holders unavailable: ${holdersRes.reason?.message}`)
    }

    const chain = chainRes.status === 'fulfilled' ? chainRes.value : null
    if (!chain) warnings.push(`chain read failed: ${chainRes.reason?.message}`)

    const ethUsd = ethUsdRes.status === 'fulfilled' ? ethUsdRes.value : null
    if (!ethUsd) warnings.push(`ETH/USD unavailable: ${ethUsdRes.reason?.message}`)

    let priceUsd = null
    let priceSource = 'none'

    /* Preferred path: pool price from the configured RPC, converted with the
       explorer's ETH price. Needs both halves — a price in WETH is not a price
       in dollars. */
    if (chain?.priceInWeth != null && ethUsd != null) {
      priceUsd = chain.priceInWeth * ethUsd
      priceSource = 'pool'
    } else if (dexRes.status === 'fulfilled') {
      priceUsd = dexRes.value.priceUsd
      priceSource = 'dexscreener'
    } else {
      /* Only surfaced when the fallback was actually needed and it also
         failed — not when the pool path succeeded and this concurrent result
         simply went unused, which is not a warning-worthy event. */
      warnings.push(`dexscreener fallback failed: ${dexRes.reason?.message}`)
    }

    const totalSupply = chain?.supply ?? null
    const marketCap =
      priceUsd != null && totalSupply != null ? priceUsd * totalSupply : null

    if (marketCap == null) warnings.push('market cap could not be derived')

    return {
      marketCap,
      holders,
      priceUsd,
      totalSupply,
      placeholder: false,
      source: { price: priceSource, holders: holdersSource },
      warnings,
    }
  }

  return { collect }
}
