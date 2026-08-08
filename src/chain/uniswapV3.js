/**
 * UNISWAP V3 PRICE MATH
 * -----------------------------------------------------------------------------
 * Converts a pool's `sqrtPriceX96` into a human-readable price.
 *
 * All arithmetic is BigInt. `sqrtPriceX96` is a uint160 and reaches ~1.4e48, so
 * squaring it as a JS number overflows the 53-bit mantissa long before the
 * result is used — the conversion to Number happens once, at the very end,
 * after the value has been scaled down into a range doubles represent well.
 */

/** 2^192, the denominator of sqrtPriceX96 squared. */
const Q192 = 1n << 192n

/**
 * Fixed-point scale used to carry the result out of BigInt.
 *
 * 10^36 rather than the more usual 10^18 because meme tokens price in the 1e-9
 * range and below: at 10^18 scaling, a price of 1e-9 leaves only 9 significant
 * digits before integer division truncates, and a low enough price floors to
 * zero outright — which would render as a $0 market cap rather than an error.
 */
const PRECISION = 10n ** 36n
const PRECISION_NUM = 1e36

/**
 * Price of one whole `base` token expressed in whole units of the other token.
 *
 * @param {object}  args
 * @param {bigint}  args.sqrtPriceX96    from slot0()
 * @param {number}  args.token0Decimals
 * @param {number}  args.token1Decimals
 * @param {boolean} args.baseIsToken0    is the token we are pricing token0?
 * @returns {number} price, in units of the counter token
 */
export function priceFromSqrtX96({
  sqrtPriceX96,
  token0Decimals,
  token1Decimals,
  baseIsToken0,
}) {
  if (typeof sqrtPriceX96 !== 'bigint') {
    throw new TypeError('sqrtPriceX96 must be a bigint')
  }
  /* Zero means the pool exists but was never initialised. Dividing by it would
     throw anyway; saying so plainly makes the fallback path's log readable. */
  if (sqrtPriceX96 <= 0n) {
    throw new Error('pool is uninitialised (sqrtPriceX96 is zero)')
  }
  for (const [name, d] of [
    ['token0Decimals', token0Decimals],
    ['token1Decimals', token1Decimals],
  ]) {
    if (!Number.isInteger(d) || d < 0 || d > 77) {
      throw new Error(`${name} must be an integer in 0..77, got ${d}`)
    }
  }

  const numerator = sqrtPriceX96 * sqrtPriceX96
  const scale0 = 10n ** BigInt(token0Decimals)
  const scale1 = 10n ** BigInt(token1Decimals)

  /* price(token0 in token1) = sqrtP^2 / 2^192 * 10^dec0 / 10^dec1
     Multiplications are all applied before the single division, so nothing is
     truncated mid-expression. */
  const scaled = baseIsToken0
    ? (numerator * scale0 * PRECISION) / (Q192 * scale1)
    : (Q192 * scale1 * PRECISION) / (numerator * scale0)

  return Number(scaled) / PRECISION_NUM
}

/**
 * Whole-token supply from a raw on-chain uint256.
 *
 * Kept in BigInt until the final division for the same reason as above: a 1e27
 * raw supply is already past Number's exact-integer range, so converting first
 * and dividing after would quietly lose the low digits.
 */
export function toWholeTokens(rawAmount, decimals) {
  if (typeof rawAmount !== 'bigint') {
    throw new TypeError('rawAmount must be a bigint')
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`decimals must be an integer in 0..77, got ${decimals}`)
  }
  const scale = 10n ** BigInt(decimals)
  const whole = rawAmount / scale
  const remainder = rawAmount % scale
  return Number(whole) + Number(remainder) / Number(scale)
}
