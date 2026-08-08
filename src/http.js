/**
 * HTTP HELPER
 * -----------------------------------------------------------------------------
 * One place where every outbound GET gets its timeout and its error message, so
 * no upstream can be added later that quietly hangs forever.
 */

/**
 * GETs JSON with a bounded deadline.
 *
 * @param {string} url
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.fetchImpl] injectable for tests
 */
export async function getJson(url, { timeoutMs = 8000, signal, fetchImpl = fetch } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)

  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any(signals),
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`)
  }
  return res.json()
}

/**
 * Parses a value that upstreams send as either a number or a decimal string.
 *
 * Returns null rather than NaN for anything unusable. NaN propagates silently
 * through arithmetic and only reveals itself at the far end as a blank panel;
 * null is checked at every use site in stats.js.
 */
export function toNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
