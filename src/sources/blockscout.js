/**
 * BLOCKSCOUT
 * -----------------------------------------------------------------------------
 * Two things only Blockscout can tell us:
 *
 *   holders  — there is no way to ask a plain RPC node "how many addresses hold
 *              this token". Answering it means replaying every Transfer log
 *              since deployment and tracking balances, which is precisely the
 *              indexing work the explorer already does. Reimplementing it here
 *              would mean a database and a backfill for one integer.
 *
 *   ETH/USD  — the explorer already publishes a coin price, so pricing the
 *              chain's native asset costs us no extra dependency and no API key.
 */

import { getJson, toNumber } from '../http.js'

/**
 * Holder count for an ERC-20.
 *
 * Uses /counters rather than the fuller /tokens/{addr} payload: it returns the
 * same figure from a cheaper query, and we need none of the other fields.
 */
export async function fetchHolders(baseUrl, tokenAddress, opts = {}) {
  const url = `${baseUrl}/api/v2/tokens/${tokenAddress}/counters`
  const json = await getJson(url, opts)

  const holders = toNumber(json?.token_holders_count)
  if (holders == null) {
    throw new Error(`Blockscout returned no token_holders_count for ${tokenAddress}`)
  }
  return holders
}

/**
 * USD price of the chain's native coin (ETH on Robinhood Chain).
 *
 * @returns {Promise<number>}
 */
export async function fetchNativeUsd(baseUrl, opts = {}) {
  const json = await getJson(`${baseUrl}/api/v2/stats`, opts)

  const price = toNumber(json?.coin_price)
  if (price == null || price <= 0) {
    throw new Error('Blockscout returned no usable coin_price')
  }
  return price
}

/**
 * Token metadata, used only as a fallback for supply and decimals when the RPC
 * is unreachable. The RPC is the authority — this is second-hand, and can lag.
 */
export async function fetchToken(baseUrl, tokenAddress, opts = {}) {
  const url = `${baseUrl}/api/v2/tokens/${tokenAddress}`
  const json = await getJson(url, opts)

  return {
    symbol: json?.symbol ?? null,
    name: json?.name ?? null,
    decimals: toNumber(json?.decimals),
    totalSupplyRaw: json?.total_supply ?? null,
  }
}
