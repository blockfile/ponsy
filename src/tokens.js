/**
 * ORIGIN TOKEN ALLOWLIST
 * -----------------------------------------------------------------------------
 * Which tokens a visitor may pay with, per network.
 *
 * Requests name a token by KEY ("usdc"), never by address. The same reasoning
 * that fixes the destination token server-side applies here: an address taken
 * from the request is a way to route someone's money through a token we never
 * vetted. Keys are a closed set; addresses are not.
 *
 * Every address below was confirmed to route to PONSY against the live Relay
 * API on 2026-08-09. Solana lists native SOL alone — SPL tokens return
 * NO_SWAP_ROUTES_FOUND for every destination, so offering them would be a
 * false choice rather than a limitation of this file.
 */

const NATIVE = '0x0000000000000000000000000000000000000000'
const SOL_MINT = '11111111111111111111111111111111'

/**
 * Note the decimals. USDC and USDT are 6 decimals on the Ethereum-family
 * chains but 18 on BNB Chain, where they are BEP-20 re-issues rather than
 * bridged originals. Using the wrong one scales the amount by 10^12.
 */
export const TOKENS_BY_CHAIN = {
  8453: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  ],
  1: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    { key: 'usdt', symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  ],
  42161: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    { key: 'usdt', symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  ],
  10: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    { key: 'usdt', symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
  ],
  56: [
    { key: 'native', symbol: 'BNB', address: NATIVE, decimals: 18 },
    { key: 'usdt', symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    { key: 'usdc', symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  ],
  4663: [
    { key: 'native', symbol: 'ETH', address: NATIVE, decimals: 18 },
  ],
  792703809: [
    { key: 'native', symbol: 'SOL', address: SOL_MINT, decimals: 9 },
  ],
}

/** The tokens offered on a network, native first. Empty for an unknown chain. */
export function tokensFor(chainId) {
  return TOKENS_BY_CHAIN[Number(chainId)] ?? []
}

/**
 * Resolves a token key on a network.
 *
 * Throws rather than defaulting to native: a caller asking for a token we do
 * not offer has a bug or is probing, and silently swapping in a different
 * asset than they named is the worst possible answer to either.
 */
export function resolveToken(chainId, key) {
  const list = tokensFor(chainId)
  if (list.length === 0) throw new Error(`chain ${chainId} is not supported`)

  const found = list.find((t) => t.key === key)
  if (!found) {
    const offered = list.map((t) => t.key).join(', ')
    throw new Error(`token "${key}" is not available on chain ${chainId} (offered: ${offered})`)
  }
  return found
}
