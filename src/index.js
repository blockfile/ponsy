/**
 * ENTRY POINT
 * -----------------------------------------------------------------------------
 * Loads config, wires the pieces together, starts listening.
 */

import { loadEnvFile, buildConfig } from './config.js'
import { createRpcClient } from './chain/rpc.js'
import { createStatsService } from './stats.js'
import { createQuoteService } from './quote.js'
import { createCache } from './cache.js'
import { createServer } from './server.js'

loadEnvFile()

let config
try {
  config = buildConfig()
} catch (err) {
  /* Fail here, loudly, rather than starting a server that can only ever answer
     with errors. A typo'd address should cost you a startup log line, not an
     afternoon of wondering why the panel is blank. */
  console.error(`[config] ${err.message}`)
  process.exit(1)
}

const rpc = createRpcClient({
  url: config.rpcUrl,
  timeoutMs: config.upstreamTimeoutMs,
})

const statsService = createStatsService({ config, rpc })
const cache = createCache({
  ttlMs: config.cacheTtlMs,
  staleMaxMs: config.staleMaxMs,
})

const quoteService = createQuoteService({ config })

const app = createServer({ config, statsService, quoteService, cache })

const server = app.listen(config.port, config.host, () => {
  console.log(`[ponsy-stats] listening on ${config.host}:${config.port}`)
  console.log(`[ponsy-stats] rpc        ${config.rpcUrl}`)
  console.log(`[ponsy-stats] explorer   ${config.blockscoutUrl}`)
  console.log(
    `[ponsy-stats] token      ${config.tokenAddress ?? 'UNSET — /stats returns nulls until you set TOKEN_ADDRESS'}`,
  )
  console.log(
    `[ponsy-stats] pool       ${config.poolAddress ?? 'UNSET — pricing via Dexscreener fallback'}`,
  )
})

/* Containers stop with SIGTERM; without this the platform waits out its grace
   period on every deploy. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[ponsy-stats] ${signal} — shutting down`)
    server.close(() => process.exit(0))
  })
}
