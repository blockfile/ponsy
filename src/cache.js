/**
 * TTL CACHE WITH STALE-ON-FAILURE
 * -----------------------------------------------------------------------------
 * Sits between the public endpoint and the upstreams, and does three jobs:
 *
 *   throttles   one upstream fetch per TTL regardless of visitor count, so a
 *               busy launch day does not translate into rate-limit bans
 *
 *   coalesces   concurrent misses share a single in-flight fetch, so a cold
 *               cache under load produces one upstream request, not hundreds
 *
 *   degrades    serves the last good payload while upstreams are failing, up to
 *               a bounded window — then stops, so the site never shows numbers
 *               so old they are fiction
 */

/**
 * @param {object}   opts
 * @param {number}   opts.ttlMs       how long a value is considered fresh
 * @param {number}   opts.staleMaxMs  how long past that it may still be served
 * @param {Function} [opts.now]       injectable clock for tests
 */
export function createCache({ ttlMs, staleMaxMs, now = Date.now }) {
  let value = null
  let storedAt = 0
  let inFlight = null

  /**
   * Returns a cached value if fresh, otherwise refreshes via `producer`.
   *
   * @param {Function} producer async () => value
   * @returns {Promise<{value: any, stale: boolean, updatedAt: number}>}
   */
  async function get(producer) {
    const age = now() - storedAt

    if (value !== null && age < ttlMs) {
      return { value, stale: false, updatedAt: storedAt }
    }

    /* Join the fetch already running rather than starting a second one. */
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const fresh = await producer()
          value = fresh
          storedAt = now()
          return { value, stale: false, updatedAt: storedAt }
        } finally {
          inFlight = null
        }
      })()
    }

    try {
      return await inFlight
    } catch (err) {
      /* Upstreams are down. A recent-enough payload is more useful than an
         error, but only for a bounded window — past staleMaxMs the numbers
         stop being "a moment ago" and start being misinformation, so the
         failure is surfaced instead. */
      if (value !== null && now() - storedAt <= staleMaxMs) {
        return { value, stale: true, updatedAt: storedAt, error: err }
      }
      throw err
    }
  }

  /** Test seam — drops everything held. */
  function clear() {
    value = null
    storedAt = 0
    inFlight = null
  }

  return { get, clear }
}
