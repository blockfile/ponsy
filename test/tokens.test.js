import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveToken, tokensFor, TOKENS_BY_CHAIN, resolvePayAssetKey } from '../src/tokens.js'

const NATIVE = '0x0000000000000000000000000000000000000000'

test('every network offers its native asset first', () => {
  for (const [chainId, list] of Object.entries(TOKENS_BY_CHAIN)) {
    assert.equal(list[0].key, 'native', `chain ${chainId} must list native first`)
    assert.ok(list[0].symbol, `chain ${chainId} native needs a symbol`)
  }
})

test('resolves native to the zero address on EVM chains', () => {
  assert.equal(resolveToken(8453, 'native').address, NATIVE)
  assert.equal(resolveToken(8453, 'native').decimals, 18)
  assert.equal(resolveToken(56, 'native').symbol, 'BNB')
})

test('resolves SOL to its mint, with 9 decimals', () => {
  const sol = resolveToken(792703809, 'native')
  assert.equal(sol.address, '11111111111111111111111111111111')
  assert.equal(sol.decimals, 9)
  assert.equal(sol.symbol, 'SOL')
})

test('USDC is 6 decimals on Base but 18 on BNB Chain', () => {
  /* Getting this backwards is a 10^12 error in the amount sent to Relay —
     the single most expensive mistake available in this file. */
  assert.equal(resolveToken(8453, 'usdc').decimals, 6)
  assert.equal(resolveToken(56, 'usdc').decimals, 18)
})

test('Solana offers native only — SPL tokens do not route', () => {
  assert.deepEqual(tokensFor(792703809).map((t) => t.key), ['native'])
  assert.throws(() => resolveToken(792703809, 'usdc'), /not available/)
})

test('rejects an unknown token key rather than falling back to native', () => {
  assert.throws(() => resolveToken(8453, 'ponzi'), /not available/)
  assert.throws(() => resolveToken(8453, ''), /not available/)
  assert.throws(() => resolveToken(8453, undefined), /not available/)
})

test('rejects an unknown chain', () => {
  assert.throws(() => resolveToken(137, 'native'), /not supported/)
})

test('a caller cannot inject an address — only keys are accepted', () => {
  assert.throws(
    () => resolveToken(8453, '0xd314ee5350570e57c8e2e5bb6b3920cd1a16083e'),
    /not available/,
  )
})

/* resolvePayAssetKey — the swap widget's `?from=` key -> (chainId, token)
   mapping. Every row here is the table verified live against Relay
   (2026-08-09) in the task that added this endpoint shape. */

test('maps each pay-asset key to the chain and token it was verified against', () => {
  assert.deepEqual(resolvePayAssetKey('sol'), { chainId: 792703809, token: 'native' })
  assert.deepEqual(resolvePayAssetKey('bnb'), { chainId: 56, token: 'native' })
  assert.deepEqual(resolvePayAssetKey('eth'), { chainId: 1, token: 'native' })
  assert.deepEqual(resolvePayAssetKey('usdc-eth'), { chainId: 1, token: 'usdc' })
})

test('every resolvePayAssetKey mapping resolves through resolveToken too', () => {
  // Pins the two files together: a mapping that points at a (chainId, token)
  // pair tokens.js doesn't actually offer would throw deep inside quote.js
  // instead of here, where the mismatch is obvious.
  for (const key of ['sol', 'bnb', 'eth', 'usdc-eth']) {
    const { chainId, token } = resolvePayAssetKey(key)
    assert.doesNotThrow(() => resolveToken(chainId, token), key)
  }
})

test('rejects usdc-sol with an actionable message naming the real problem, not a generic refusal', () => {
  // SPL USDC genuinely has no route to PONSY (NO_SWAP_ROUTES_FOUND, verified
  // live) — this must read as "this asset doesn't work here", not as one
  // more instance of the generic unknown-key error below.
  assert.throws(() => resolvePayAssetKey('usdc-sol'), /USDC on Solana cannot be swapped to PONSY/)
})

test('rejects an unknown pay-asset key rather than defaulting to any asset', () => {
  assert.throws(() => resolvePayAssetKey('doge'), /not a supported asset/)
  assert.throws(() => resolvePayAssetKey(''), /not a supported asset/)
  assert.throws(() => resolvePayAssetKey(undefined), /not a supported asset/)
})

test('every listed address is a plausible identifier for its VM', () => {
  const EVM_RE = /^0x[0-9a-fA-F]{40}$/
  const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
  for (const [chainId, list] of Object.entries(TOKENS_BY_CHAIN)) {
    for (const t of list) {
      const ok = Number(chainId) === 792703809 ? B58_RE.test(t.address) : EVM_RE.test(t.address)
      assert.ok(ok, `chain ${chainId} token ${t.key} has a malformed address: ${t.address}`)
      assert.ok(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 18)
    }
  }
})
