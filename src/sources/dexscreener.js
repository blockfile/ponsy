/**
 * DEXSCREENER — fallback price source
 * -----------------------------------------------------------------------------
 * Used when the on-chain pool read fails, or when POOL_ADDRESS is not
 * configured. Dexscreener indexes Robinhood Chain under the chain id
 * "robinhood" (verified 2026-08-08).
 *
 * This is the fallback rather than the primary because it can lag a freshly
 * created pair by hours, whereas the pool read is correct the moment the pool
 * has liquidity.
 */

import { getJson, toNumber } from '../http.js'

/** Dexscreener's identifier for Robinhood Chain. */
export const DEX_CHAIN_ID = 'robinhood'

/**
 * Picks the pair a price should be read from.
 *
 * Two filters matter:
 *
 *   chainId    — the same address can exist on another chain, and pricing our
 *                token off a namesake elsewhere is worse than no price at all.
 *
 *   baseToken  — Dexscreener's `priceUsd` is always the price of `baseToken`.
 *                When our token is the *quote* side of a pair, that figure is
 *                the price of something else entirely.
 *
 * Of what survives, the deepest pool wins: a thin pair's price moves on dust.
 */
export function selectPair(pairs, tokenAddress, chainId = DEX_CHAIN_ID) {
  if (!Array.isArray(pairs)) return null
  const wanted = tokenAddress.toLowerCase()

  const eligible = pairs.filter(
    (p) =>
      p?.chainId === chainId &&
      p?.baseToken?.address?.toLowerCase() === wanted &&
      toNumber(p?.priceUsd) != null,
  )
  if (eligible.length === 0) return null

  return eligible.reduce((best, p) =>
    (toNumber(p?.liquidity?.usd) ?? 0) > (toNumber(best?.liquidity?.usd) ?? 0) ? p : best,
  )
}

/**
 * USD price for a token.
 *
 * @returns {Promise<{priceUsd: number, liquidityUsd: number|null, pairAddress: string|null}>}
 */
export async function fetchPrice(baseUrl, tokenAddress, opts = {}) {
  const url = `${baseUrl}/latest/dex/tokens/${tokenAddress}`
  const json = await getJson(url, opts)

  const pair = selectPair(json?.pairs, tokenAddress, opts.chainId ?? DEX_CHAIN_ID)
  if (!pair) {
    throw new Error(`Dexscreener has no indexed pair for ${tokenAddress}`)
  }

  const priceUsd = toNumber(pair.priceUsd)
  if (priceUsd == null || priceUsd <= 0) {
    throw new Error(`Dexscreener returned no usable priceUsd for ${tokenAddress}`)
  }

  return {
    priceUsd,
    liquidityUsd: toNumber(pair?.liquidity?.usd),
    pairAddress: pair?.pairAddress ?? null,
  }
}
