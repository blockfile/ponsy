/**
 * CONFIG
 * -----------------------------------------------------------------------------
 * Every environment-dependent value, parsed and validated once at startup.
 *
 * Validation is fail-fast and happens here rather than at the call site: a
 * malformed TOKEN_ADDRESS should stop the process with a clear message, not
 * surface hours later as an empty stats panel nobody can explain.
 */

import { readFileSync } from 'node:fs'

/**
 * Minimal .env loader.
 *
 * Hand-rolled rather than pulling in `dotenv`: this is thirty lines against a
 * dependency, and `node --env-file` is not an option because it hard-fails when
 * the file is absent, which is the normal case in a container where the values
 * come from the platform.
 *
 * Real environment variables always win, so a platform-injected value is never
 * clobbered by a stale .env left in the image.
 */
export function loadEnvFile(path = '.env', env = process.env) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return env // no file is fine — the platform supplies the values
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eq = trimmed.indexOf('=')
    if (eq === -1) continue

    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()

    // Strip one layer of matching quotes, so `FOO="bar baz"` yields `bar baz`.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }

    if (!(key in env)) env[key] = value
  }
  return env
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Validates an EVM address, returning it lowercased.
 *
 * Lowercasing matters: addresses arrive from three upstreams with three
 * different capitalisations (Blockscout returns EIP-55 checksummed, the RPC
 * returns lowercase, Dexscreener mixes both), and token-ordering comparisons
 * against `token0()` would silently fail if we compared them as-typed.
 *
 * Returns null for an unset value — "not launched yet" is a valid state, not an
 * error. Anything set but malformed throws, because that is always a typo.
 */
export function parseAddress(value, name) {
  if (value == null || value === '') return null
  const trimmed = String(value).trim()
  if (!ADDRESS_RE.test(trimmed)) {
    throw new Error(
      `${name} must be a 0x-prefixed 40-hex-character address, got: ${trimmed}`,
    )
  }
  return trimmed.toLowerCase()
}

/** Strips any trailing slash so callers can join paths without doubling it. */
function parseUrl(value, fallback, name) {
  const raw = value == null || value === '' ? fallback : String(value).trim()
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${name} must be a valid URL, got: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be http or https, got: ${raw}`)
  }
  return raw.replace(/\/+$/, '')
}

function parsePositiveInt(value, fallback, name) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`${name} must be a non-negative integer, got: ${value}`)
  }
  return n
}

/**
 * Parses the CORS allowlist.
 *
 * `*` is a deliberate, supported choice here rather than a lax default: /stats
 * is public read-only data with no credentials and no side effects, so there is
 * nothing for a cross-origin caller to abuse.
 */
function parseOrigins(value) {
  const raw = (value ?? '').trim()
  if (raw === '') return []
  if (raw === '*') return '*'
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/** Builds the frozen config object. Throws on any invalid value. */
export function buildConfig(env = process.env) {
  return Object.freeze({
    tokenAddress: parseAddress(env.TOKEN_ADDRESS, 'TOKEN_ADDRESS'),
    poolAddress: parseAddress(env.POOL_ADDRESS, 'POOL_ADDRESS'),

    /* The pool's counter token. On-chain pricing multiplies by the *native*
       coin price, so it is only correct against a WETH pair — stats.js checks
       the pool against this and falls back rather than mispricing. Overridable
       because a wrapped-token address is deployment data, not a law of nature. */
    wethAddress: parseAddress(
      env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
      'WETH_ADDRESS',
    ),

    rpcUrl: parseUrl(
      env.RPC_URL,
      'https://rpc.mainnet.chain.robinhood.com',
      'RPC_URL',
    ),
    blockscoutUrl: parseUrl(
      env.BLOCKSCOUT_URL,
      'https://robinhoodchain.blockscout.com',
      'BLOCKSCOUT_URL',
    ),
    dexscreenerUrl: parseUrl(
      env.DEXSCREENER_URL,
      'https://api.dexscreener.com',
      'DEXSCREENER_URL',
    ),

    relayUrl: parseUrl(env.RELAY_URL, 'https://api.relay.link', 'RELAY_URL'),

    solanaRpcUrl: parseUrl(
      env.SOLANA_RPC_URL,
      'https://api.mainnet-beta.solana.com',
      'SOLANA_RPC_URL',
    ),

    /* Chains a user may pay from. Server-side because it is a safety rule, not
       a preference: an unlisted chain means an unaudited route. */
    allowedChainIds: (env.ALLOWED_CHAIN_IDS ?? '8453,1,42161,10,4663,56,792703809')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),

    /* Below this, fixed relayer and gas costs are a double-digit percentage of
       the trade. Measured: a $5 trade executes 20.8% worse than spot. */
    minTradeUsd: parsePositiveInt(env.MIN_TRADE_USD, 25, 'MIN_TRADE_USD'),

    port: parsePositiveInt(env.PORT, 8787, 'PORT'),

    /* Loopback by default. Behind nginx there is no reason to accept traffic on
       the public interface, and binding 0.0.0.0 means a missing firewall rule
       silently exposes the app port alongside the proxied one. Override to
       0.0.0.0 only for a container that is itself the network boundary. */
    host: (env.HOST ?? '127.0.0.1').trim(),
    corsOrigins: parseOrigins(env.CORS_ORIGIN ?? 'http://localhost:5173'),

    cacheTtlMs: parsePositiveInt(env.CACHE_TTL_MS, 30_000, 'CACHE_TTL_MS'),
    staleMaxMs: parsePositiveInt(env.STALE_MAX_MS, 600_000, 'STALE_MAX_MS'),
    upstreamTimeoutMs: parsePositiveInt(
      env.UPSTREAM_TIMEOUT_MS,
      8_000,
      'UPSTREAM_TIMEOUT_MS',
    ),

    /* How often the background refresher (src/refresher.js) re-collects stats
       and writes them into the cache. Kept below cacheTtlMs so the timer, not
       an inbound request, is almost always what pays collect()'s latency. */
    refreshIntervalMs: parsePositiveInt(
      env.REFRESH_INTERVAL_MS,
      20_000,
      'REFRESH_INTERVAL_MS',
    ),

    /* Caps how long GET /stats will wait on a cold cache (nothing collected
       yet) before degrading to a 503 rather than hanging. Deliberately well
       under both collect()'s ~8s worst case and nginx's 15s proxy_read_timeout
       — see server.js's withDeadline(). */
    statsWaitMs: parsePositiveInt(env.STATS_WAIT_MS, 5_000, 'STATS_WAIT_MS'),

    /* Caps how long GET /quote will wait before answering with a timeout
       instead of hanging. Unlike statsWaitMs, this is NOT meant to fire under
       normal conditions — a real quote has no cache to fall back to, so
       degrading early would just turn a slow-but-succeeding quote into a
       needless failure. It exists as the structural backstop: quote.js now
       runs the Relay quote and (for a Solana origin) the blockhash fetch
       concurrently rather than sequentially, which caps their combined worst
       case at ~upstreamTimeoutMs (max, not sum) — but that arithmetic is easy
       to re-break the next time a third sequential upstream call is added to
       this path. 12s clears that ~8s worst case with margin for real network
       latency and JSON parsing, while staying comfortably under nginx's 15s
       proxy_read_timeout (deploy/nginx.conf) so this route can never again
       ride a slow request all the way to a 504 from nginx itself. */
    quoteWaitMs: parsePositiveInt(env.QUOTE_WAIT_MS, 12_000, 'QUOTE_WAIT_MS'),
  })
}
