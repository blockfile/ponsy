/**
 * MINIMAL ABI ENCODING / DECODING
 * -----------------------------------------------------------------------------
 * Enough ABI handling for this service and no more.
 *
 * Every contract call we make takes zero arguments, so "encoding" is a constant
 * 4-byte selector and there is no argument packing to get wrong. Decoding is
 * fixed-width slicing of 32-byte words. That is the whole surface area — which
 * is why this file exists instead of a dependency on ethers or viem. Neither of
 * them would do the Uniswap price math for us either (see uniswapV3.js), so the
 * megabytes would buy nothing we need.
 *
 * Selectors are the first 4 bytes of keccak256 of the signature. These five are
 * long-standing published constants of ERC-20 and the Uniswap v3 pool, so they
 * are written down rather than computed — hashing them at runtime would mean
 * shipping a keccak implementation to derive values that cannot change.
 */

export const SELECTORS = Object.freeze({
  /** ERC-20 totalSupply() -> uint256 */
  totalSupply: '0x18160ddd',
  /** ERC-20 decimals() -> uint8 */
  decimals: '0x313ce567',
  /** UniswapV3Pool slot0() -> (uint160 sqrtPriceX96, int24 tick, ...) */
  slot0: '0x3850c7bd',
  /** UniswapV3Pool token0() -> address */
  token0: '0x0dfe1681',
  /** UniswapV3Pool token1() -> address */
  token1: '0xd21220a7',
  /** ERC-20 balanceOf(address) -> uint256 */
  balanceOf: '0x70a08231',
})

/** Strips the 0x prefix, if present. */
function body(hex) {
  const s = String(hex ?? '')
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s
}

/**
 * Returns the nth 32-byte word of returndata as a 64-char hex string.
 *
 * Throws rather than returning a partial word: a short response means the call
 * hit a non-contract address or a contract without that function, and a zero
 * silently substituted here becomes a $0 market cap on the site.
 */
export function word(hex, index = 0) {
  const raw = body(hex)
  const start = index * 64
  const end = start + 64
  if (raw.length < end) {
    throw new Error(
      `expected at least ${end / 2} bytes of returndata, got ${raw.length / 2}`,
    )
  }
  return raw.slice(start, end)
}

/** Decodes a uint of any width from the nth word. */
export function decodeUint(hex, index = 0) {
  return BigInt('0x' + word(hex, index))
}

/**
 * Decodes a uint8 from the nth word, rejecting anything that will not fit.
 *
 * An out-of-range value here means we are not talking to the contract we think
 * we are, and 10 ** garbage would poison every figure downstream.
 */
export function decodeUint8(hex, index = 0) {
  const value = decodeUint(hex, index)
  if (value > 255n) {
    throw new Error(`expected a uint8, got ${value}`)
  }
  return Number(value)
}

/**
 * Decodes an address from the nth word — the low 20 bytes, lowercased.
 *
 * Lowercased so it can be compared with a configured address directly; see the
 * note in config.parseAddress about the three upstreams disagreeing on case.
 */
export function decodeAddress(hex, index = 0) {
  return '0x' + word(hex, index).slice(24).toLowerCase()
}

/**
 * Encodes balanceOf(address) calldata: the selector followed by the address
 * left-padded to a full 32-byte word. Lowercased because the padding is
 * positional, not checksum-sensitive, and a mixed-case tail reads like it
 * might matter.
 */
export function encodeBalanceOf(address) {
  return SELECTORS.balanceOf + '000000000000000000000000' + address.slice(2).toLowerCase()
}
