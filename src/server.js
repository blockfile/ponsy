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

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.statsService  createStatsService instance
 * @param {object} deps.cache         createCache instance
 * @param {object} [deps.logger]
 */
export function createServer({ config, statsService, cache, logger = console }) {
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
    /* Tie the upstream work to the client connection: if the visitor navigates
       away mid-request, there is no reason to keep waiting on an RPC. */
    const ac = new AbortController()
    req.on('close', () => ac.abort())

    try {
      const { value, stale, updatedAt } = await cache.get(() =>
        statsService.collect({ signal: ac.signal }),
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
      if (ac.signal.aborted) return // client left; nothing to answer

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

  app.use((_req, res) => res.status(404).json({ error: 'not found' }))

  return app
}
