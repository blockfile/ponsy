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

/** Same distinction as StatsTimeoutError, kept as its own class rather than
    reused, so the /quote route's catch block can tell "this route's own
    wait budget expired" apart from a StatsTimeoutError it was never meant to
    see, and so each carries a message worded for the request that hit it. */
class QuoteTimeoutError extends Error {}

/**
 * Bounds how long a caller waits on `promise`.
 *
 * If `promise` settles first, that settlement passes through untouched. If
 * `ms` elapses first, this rejects with `onTimeout()`'s error instead — but
 * `promise` itself is left running, uncancelled. For /stats that is
 * deliberate: the fetch it represents is populating the *shared* cache (see
 * cache.js's single-flight coalescing and refresher.js), not answering this
 * one caller, so whichever request happens to be the one that started it
 * should not be able to cut it short just because that request gave up
 * waiting. /quote reuses the same shape for a different reason — see the
 * comment at its call site below. Either way, `promise`'s eventual result
 * (or failure) is still handled right here via the `.then` below, so it can
 * never surface as an unhandled promise rejection even though nothing else
 * is still waiting on it.
 */
function withDeadline(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
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
        () => new StatsTimeoutError(`stats collection exceeded the ${config.statsWaitMs}ms wait budget`),
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
      /* Bounded the same way GET /stats bounds cache.get() above, and for a
         related but distinct reason. quote.js now runs the Relay quote and
         (for a Solana origin) the blockhash fetch concurrently, which caps
         their combined worst case at max(quote, blockhash) instead of their
         sum — but that arithmetic is only correct today. Nothing stops a
         future change from adding a third sequential upstream call to this
         path and quietly re-arming the exact composition-past-nginx's-15s
         failure this fix closes (see quoteWaitMs's comment in config.js).
         This wrapper is that structural backstop: whatever getQuote() ends
         up doing internally, this route can never again ride it all the way
         to nginx's own 504. */
      const quote = await withDeadline(
        quoteService.getQuote({
          user: req.query.user,
          chainId: req.query.chainId,
          amount: req.query.amount,
          recipient: req.query.recipient,
          token: req.query.token,
        }),
        config.quoteWaitMs,
        () => new QuoteTimeoutError(`quote exceeded the ${config.quoteWaitMs}ms wait budget`),
      )
      res.json(quote)
    } catch (err) {
      if (err instanceof QuoteTimeoutError) {
        /* Deliberately not folded into the 400 branch below, even though that
           branch's own comment says "nearly everything that fails here is the
           request's fault" — this is the one thing that isn't. A 400 tells a
           client "change what you sent"; retrying the identical request would
           be correct advice for a timeout, and is actively bad advice for a
           malformed address or an unsupported chain. 504 (Gateway Timeout) is
           the honest, standard code for "the upstream took too long," and — as
           importantly — it is not 400, so a caller (or the frontend) can
           special-case "try again" from "fix your input" without parsing the
           message text. */
        logger.warn?.(`[quote] ${err.message}`)
        return res.status(504).json({
          error: 'quote timed out',
          detail: err.message,
        })
      }

      /* 400, not 500: nearly everything else that fails here is the request's
         fault — an unsupported chain, too small an amount, no route for that
         pair — and the message is written to be shown to the user as-is. */
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
