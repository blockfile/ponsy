/**
 * ENTRY POINT
 * -----------------------------------------------------------------------------
 * Loads config, wires the pieces together, starts listening.
 */

import { loadEnvFile, buildConfig, waitBudgetWarning } from './config.js'
import { createRpcClient } from './chain/rpc.js'
import { createBlockhashProvider } from './chain/solana.js'
import { createStatsService } from './stats.js'
import { createQuoteService } from './quote.js'
import { createCache } from './cache.js'
import { createRefresher } from './refresher.js'
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

/* Keeps the stats cache warm on a timer so GET /stats can answer from memory
   instead of waiting on an upstream — see refresher.js. Started explicitly
   (never auto-starts) and stopped on shutdown below, so it never runs in
   tests and never outlives the process. */
const refresher = createRefresher({
  cache,
  statsService,
  intervalMs: config.refreshIntervalMs,
})

/* timeoutMs is passed explicitly rather than left to the provider's own
   default. Both upstream calls on the /quote path now run concurrently, so
   the worst case is max(relay, blockhash) — but that is only true if the two
   budgets actually track each other. Leaving blockhash on a separate
   hardcoded constant meant raising UPSTREAM_TIMEOUT_MS silently widened the
   gap between them, which is exactly the kind of drift between two numbers
   in two files that caused this project's 504 twice. */
const blockhash = createBlockhashProvider({
  rpcUrl: config.solanaRpcUrl,
  timeoutMs: config.upstreamTimeoutMs,
})
const quoteService = createQuoteService({ config, blockhash })

const app = createServer({ config, statsService, quoteService, cache })

/* Start warming the cache before the server can accept a single connection,
   so the earliest possible request has the best chance of finding a refresh
   already in flight (or, after the first cycle, already sitting in cache)
   instead of paying collect()'s latency itself. */
refresher.start()

const server = app.listen(config.port, config.host, () => {
  console.log(`[ponsy-stats] listening on ${config.host}:${config.port}`)
  console.log(`[ponsy-stats] rpc        ${config.rpcUrl}`)
  console.log(`[ponsy-stats] explorer   ${config.blockscoutUrl}`)
  console.log(`[ponsy-stats] refresh    every ${config.refreshIntervalMs}ms`)
  console.log(
    `[ponsy-stats] token      ${config.tokenAddress ?? 'UNSET — /stats returns nulls until you set TOKEN_ADDRESS'}`,
  )
  console.log(
    `[ponsy-stats] pool       ${config.poolAddress ?? 'UNSET — pricing via Dexscreener fallback'}`,
  )
  console.log(`[ponsy-stats] waits      stats ${config.statsWaitMs}ms · quote ${config.quoteWaitMs}ms`)

  /* See waitBudgetWarning() in config.js for why this warns rather than
     throws, and why the check lives there rather than inline here. */
  const warning = waitBudgetWarning(config)
  if (warning) console.warn(`[ponsy-stats] WARNING: ${warning}`)
})

/* Containers stop with SIGTERM; without this the platform waits out its grace
   period on every deploy. Stopping the refresher here too, not just the
   server, is what keeps this timer from leaking past shutdown. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[ponsy-stats] ${signal} — shutting down`)
    refresher.stop()
    server.close(() => process.exit(0))
  })
}
