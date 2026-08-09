import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig, parseAddress } from '../src/config.js'
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

test('allowedChainIds default includes BNB Chain (56) alongside the existing five', () => {
  // Pins .env.example and this fallback in sync: the source-of-truth default
  // lives in both places, and only a test catches them drifting apart.
  const config = buildConfig({})
  assert.deepEqual(config.allowedChainIds, [8453, 1, 42161, 10, 4663, 56])
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
