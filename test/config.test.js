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
