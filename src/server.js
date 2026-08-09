/**
 * HTTP SERVER
 * -----------------------------------------------------------------------------
 * Express wiring only. All data concerns live in stats.js, all caching in
 * cache.js — this file decides status codes and headers, nothing more.
 */

import express from 'express'

/**
 * CORS for a public, read-only, credential-free endpoint.
 *
 * Written out rather than pulling in the `cors` package: the policy is a GET
 * allowlist and a preflight reply, and a dependency for that is not worth the
 * supply-chain surface.
 */
function cors(origins) {
  return (req, res, next) => {
    const origin = req.headers.origin

    if (origins === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*')
    } else if (origin && origins.includes(origin.replace(/\/+$/, ''))) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      /* Responses differ by Origin, so any shared cache in front of this must
         key on it — without Vary, one visitor's allowed origin header can be
         replayed to a visitor from a different one. */
      res.setHeader('Vary', 'Origin')
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')

    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  }
}

/** Distinguishes "the wait budget ran out" from a genuine collection failure. */
class StatsTimeoutError extends Error {}

/**
 * Bounds how long a caller waits on `promise`.
 *
 * If `promise` settles first, that settlement passes through untouched. If
 * `ms` elapses first, this rejects with StatsTimeoutError instead — but
 * `promise` itself is left running, uncancelled. That is deliberate: the
 * fetch it represents is populating the *shared* cache (see cache.js's
 * single-flight coalescing and refresher.js), not answering this one caller,
 * so whichever request happens to be the one that started it should not be
 * able to cut it short just because that request gave up waiting. Its
 * eventual result (or failure) still reaches cache.js via the `.then` below,
 * ready for the next request; its rejection is handled right here so it can
 * never surface as an unhandled promise rejection.
 */
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StatsTimeoutError(`stats collection exceeded the ${ms}ms wait budget`)),
      ms,
    )
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.statsService  createStatsService instance
 * @param {object} deps.quoteService  createQuoteService instance
 * @param {object} deps.cache         createCache instance
 * @param {object} [deps.logger]
 */
export function createServer({ config, statsService, quoteService, cache, logger = console }) {
  const app = express()
  app.disable('x-powered-by')
  app.use(cors(config.corsOrigins))

  /** Liveness. Deliberately touches no upstream, so it stays up when they don't. */
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      tokenConfigured: Boolean(config.tokenAddress),
      poolConfigured: Boolean(config.poolAddress),
    })
  })

  app.get('/stats', async (req, res) => {
    /* No per-request AbortController here (deliberately — see withDeadline's
       comment above): with the background refresher (refresher.js) keeping
       this cache warm, cache.get() normally returns an already-fresh value
       in well under a millisecond, without calling statsService.collect() at
       all. The only time this actually waits on a live collect() is a cold
       cache — freshly booted, or a sustained upstream outage past the stale
       window — and withDeadline bounds that wait so this route can never
       ride collect() all the way to nginx's 15s proxy_read_timeout. */
    try {
      const { value, stale, updatedAt } = await withDeadline(
        cache.get(() => statsService.collect()),
        config.statsWaitMs,
      )

      /* Let intermediaries cache for the same window we do, so a CDN in front
         of this absorbs the traffic instead of forwarding it. */
      res.setHeader(
        'Cache-Control',
        `public, max-age=${Math.floor(config.cacheTtlMs / 1000)}`,
      )

      res.json({
        ...value,
        stale,
        updatedAt: new Date(updatedAt).toISOString(),
      })
    } catch (err) {
      if (err instanceof StatsTimeoutError) {
        /* Cold start: nothing cached yet and collection is still running in
           the background (it will land in the cache for the next request —
           see withDeadline). Degrade honestly and promptly rather than
           making the visitor, and nginx, wait on it. A 503 here — like the
           one below — trips the frontend panel's RETRY state, which is an
           honest description of "no figures available right now" even
           though the underlying cause (still warming up) differs from a
           real outage. */
        logger.warn?.(`[stats] cold start: no cached value within ${config.statsWaitMs}ms`)
        return res.status(503).json({
          error: 'stats warming up',
          detail: 'no cached figures yet; try again shortly',
        })
      }

      logger.error?.('[stats] all sources failed:', err.message)

      /* 503, not 200-with-nulls. Every source being down is a real outage, and
         the frontend's error panel with its RETRY button is the honest way to
         show it. Note this differs from the pre-launch case in stats.js, which
         is a success — "no token yet" and "we are broken" are different facts
         and must not render the same. */
      res.status(503).json({
        error: 'stats unavailable',
        detail: err.message,
      })
    }
  })

  /* Never cached. A quote is a price with an expiry — serving a stale one from
     any layer is how a user signs a transaction for a number that no longer
     exists. Note this is the opposite of /stats, which is cached for 30s. */
  app.get('/quote', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const quote = await quoteService.getQuote({
        user: req.query.user,
        chainId: req.query.chainId,
        amount: req.query.amount,
      })
      res.json(quote)
    } catch (err) {
      /* 400, not 500: nearly everything that fails here is the request's fault
         — an unsupported chain, too small an amount, no route for that pair —
         and the message is written to be shown to the user as-is. */
      logger.warn?.('[quote]', err.message)
      res.status(400).json({ error: err.message })
    }
  })

  app.get('/quote/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.json(await quoteService.getStatus(req.query.requestId))
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  app.use((_req, res) => res.status(404).json({ error: 'not found' }))

  return app
}
