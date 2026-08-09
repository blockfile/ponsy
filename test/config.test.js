import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildConfig,
  parseAddress,
  waitBudgetWarning,
  NGINX_PROXY_READ_TIMEOUT_MS,
} from '../src/config.js'
import { TOKEN_ADDRESS } from './fixtures.js'

test('an unset address is null, not an error', () => {
  assert.equal(parseAddress('', 'TOKEN_ADDRESS'), null)
  assert.equal(parseAddress(undefined, 'TOKEN_ADDRESS'), null)
})

test('lowercases a checksummed address', () => {
  assert.equal(
    parseAddress('0x0c5B5eF209dd8c9C84B6EF2e19c46a48fCa0e33E', 'TOKEN_ADDRESS'),
    TOKEN_ADDRESS,
  )
})

test('rejects a malformed address with a message naming the variable', () => {
  assert.throws(() => parseAddress('0xnope', 'TOKEN_ADDRESS'), /TOKEN_ADDRESS/)
  assert.throws(
    () => parseAddress('0c5B5eF209dd8c9C84B6EF2e19c46a48fCa0e33E', 'TOKEN_ADDRESS'),
    /TOKEN_ADDRESS/,
  )
})

test('defaults are the Robinhood Chain endpoints', () => {
  const config = buildConfig({})
  assert.equal(config.rpcUrl, 'https://rpc.mainnet.chain.robinhood.com')
  assert.equal(config.blockscoutUrl, 'https://robinhoodchain.blockscout.com')
  assert.equal(config.port, 8787)
  assert.equal(config.tokenAddress, null)
})

test('strips a trailing slash from upstream URLs', () => {
  const config = buildConfig({ BLOCKSCOUT_URL: 'https://example.com/' })
  assert.equal(config.blockscoutUrl, 'https://example.com')
})

test('rejects a non-http upstream URL', () => {
  assert.throws(() => buildConfig({ RPC_URL: 'ftp://example.com' }), /RPC_URL/)
})

test('parses a comma-separated CORS allowlist', () => {
  const config = buildConfig({
    CORS_ORIGIN: 'http://localhost:5173, https://ponsy.xyz/',
  })
  assert.deepEqual(config.corsOrigins, [
    'http://localhost:5173',
    'https://ponsy.xyz',
  ])
})

test('supports a wildcard CORS origin', () => {
  assert.equal(buildConfig({ CORS_ORIGIN: '*' }).corsOrigins, '*')
})

test('rejects a non-integer port', () => {
  assert.throws(() => buildConfig({ PORT: 'abc' }), /PORT/)
})

test('allowedChainIds default includes BNB Chain (56) and Solana (792703809) alongside the original four', () => {
  // Pins .env.example and this fallback in sync: the source-of-truth default
  // lives in both places, and only a test catches them drifting apart.
  const config = buildConfig({})
  assert.deepEqual(config.allowedChainIds, [8453, 1, 42161, 10, 4663, 56, 792703809])
})

test('SOLANA_RPC_URL defaults to the public Solana mainnet endpoint', () => {
  const config = buildConfig({})
  assert.equal(config.solanaRpcUrl, 'https://api.mainnet-beta.solana.com')
})

test('background refresh interval and cold-start wait budget have sensible defaults', () => {
  const config = buildConfig({})
  assert.equal(config.refreshIntervalMs, 20000)
  assert.equal(config.statsWaitMs, 5000)
  assert.ok(
    config.refreshIntervalMs < config.cacheTtlMs,
    'the refresh interval must stay ahead of the cache TTL, or the cache goes stale between refreshes',
  )
})

test('REFRESH_INTERVAL_MS and STATS_WAIT_MS are configurable', () => {
  const config = buildConfig({ REFRESH_INTERVAL_MS: '5000', STATS_WAIT_MS: '1000' })
  assert.equal(config.refreshIntervalMs, 5000)
  assert.equal(config.statsWaitMs, 1000)
})

test('the quote wait budget defaults to 12s and is configurable', () => {
  assert.equal(buildConfig({}).quoteWaitMs, 12000)
  assert.equal(buildConfig({ QUOTE_WAIT_MS: '9000' }).quoteWaitMs, 9000)
})

/* The default config must not itself trip the warning — if it did, every
   operator would see it on every boot and learn to ignore the one message
   that prevents this project's twice-repeated outage. */
test('the shipped defaults stay under nginx proxy_read_timeout', () => {
  const config = buildConfig({})
  assert.ok(config.statsWaitMs < NGINX_PROXY_READ_TIMEOUT_MS)
  assert.ok(config.quoteWaitMs < NGINX_PROXY_READ_TIMEOUT_MS)
  assert.equal(waitBudgetWarning(config), null)
})

test('a wait budget at or over nginx proxy_read_timeout warns, naming both numbers', () => {
  const warning = waitBudgetWarning({ statsWaitMs: 5000, quoteWaitMs: 20000 })
  assert.ok(warning, 'a 20s quote budget against a 15s ceiling must warn')
  assert.match(warning, /20000ms/)
  assert.match(warning, /15000ms/)
  assert.match(warning, /proxy_read_timeout/)
  assert.match(warning, /deploy\/nginx\.conf/)
})

/* Either budget alone can exceed the ceiling — the check takes the max, not
   the quote budget it was written for. */
test('the stats budget alone can trip the warning', () => {
  assert.ok(waitBudgetWarning({ statsWaitMs: 16000, quoteWaitMs: 1000 }))
})

/* Boundary: 'meets OR exceeds'. A budget exactly equal to the ceiling leaves
   zero margin for nginx's own overhead, so it warns. */
test('the warning fires exactly at the ceiling, not just above it', () => {
  const at = NGINX_PROXY_READ_TIMEOUT_MS
  assert.ok(waitBudgetWarning({ statsWaitMs: 0, quoteWaitMs: at }))
  assert.equal(waitBudgetWarning({ statsWaitMs: 0, quoteWaitMs: at - 1 }), null)
})

/* An operator who raises proxy_read_timeout in nginx is not doing anything
   wrong, and must be able to say so without the warning crying wolf. */
test('a raised ceiling silences the warning', () => {
  assert.ok(waitBudgetWarning({ statsWaitMs: 0, quoteWaitMs: 20000 }))
  assert.equal(waitBudgetWarning({ statsWaitMs: 0, quoteWaitMs: 20000 }, 30000), null)
})

/* Reads the real deploy/nginx.conf rather than asserting the constant equals
   itself. The whole failure mode this guards is two numbers drifting apart in
   two files, so a test that only looks at one file would reproduce the bug
   rather than catch it: change nginx to 10s and every other test here still
   passes while production silently 504s again. */
test('the mirrored ceiling matches proxy_read_timeout in deploy/nginx.conf', () => {
  const conf = readFileSync(
    new URL('../deploy/nginx.conf', import.meta.url),
    'utf8',
  )
  const match = conf.match(/proxy_read_timeout\s+(\d+)(m?s);/)
  assert.ok(match, 'deploy/nginx.conf must declare a proxy_read_timeout')
  const ms = match[2] === 's' ? Number(match[1]) * 1000 : Number(match[1])
  assert.equal(
    NGINX_PROXY_READ_TIMEOUT_MS,
    ms,
    'NGINX_PROXY_READ_TIMEOUT_MS in config.js has drifted from deploy/nginx.conf — change both together',
  )
})
