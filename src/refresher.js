/**
 * BACKGROUND REFRESHER
 * -----------------------------------------------------------------------------
 * Keeps the stats cache warm on a timer, so GET /stats can answer from memory
 * instead of waiting on an upstream.
 *
 * Without this, a request that lands after the cache's TTL expires pays
 * collect()'s full latency itself — and under load, a pile of them can queue
 * up behind the same in-flight fetch. With this running, cache.get() almost
 * always finds a value younger than its TTL and returns synchronously; the
 * refresh happens on the clock, off the request path entirely.
 *
 * Deliberately thin: all the hard parts — TTL, stale-serve-on-failure,
 * single-flight coalescing — already live in cache.js. This only calls
 * cache.get() on an interval and swallows whatever it throws, so a bad
 * upstream stretch never takes the process down or wipes out the last good
 * payload. cache.js already guarantees the latter (a failed producer call
 * never clears the cached value); this just has to not crash on the former.
 *
 * The refresh itself is never tied to any one HTTP request's lifecycle — it
 * runs on behalf of the shared cache, for whoever asks next — so it carries
 * no AbortSignal. Each individual upstream call still has its own bounded
 * timeout (config.upstreamTimeoutMs, enforced in http.js/rpc.js), so this
 * cannot hang indefinitely even without one.
 */

/**
 * @param {object}   opts
 * @param {object}   opts.cache            createCache instance to keep warm
 * @param {object}   opts.statsService     createStatsService instance
 * @param {number}   [opts.intervalMs]     time between refreshes
 * @param {object}   [opts.logger]
 * @param {Function} [opts.setIntervalFn]  injectable for tests
 * @param {Function} [opts.clearIntervalFn] injectable for tests
 */
export function createRefresher({
  cache,
  statsService,
  intervalMs = 20_000,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let timer = null

  async function refresh() {
    try {
      await cache.get(() => statsService.collect())
    } catch (err) {
      /* Nothing fatal: cache.js has already either served the last good
         value (within its stale window) or determined there is truly
         nothing to serve. Either way the cache's own state is intact — this
         catch exists only so the rejection does not become an unhandled
         promise rejection and take the process down with it. */
      logger.error?.('[refresher] refresh failed:', err.message)
    }
  }

  /** Idempotent: a second call while already running is a no-op. */
  function start() {
    if (timer) return
    refresh() // fire immediately so a cold cache does not wait a full interval
    timer = setIntervalFn(refresh, intervalMs)
    timer.unref?.() // this timer alone should never be the reason the process stays alive
  }

  /** Idempotent: safe to call even if start() was never called. */
  function stop() {
    if (!timer) return
    clearIntervalFn(timer)
    timer = null
  }

  return { start, stop }
}
