import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSolanaTransaction, createBlockhashProvider } from '../src/chain/solana.js'
import {
  RELAY_SOLANA_QUOTE,
  SOL_PAYER,
  SOL_BLOCKHASH,
  SOL_BLOCKHASH_REPLY,
  stubFetch,
} from './fixtures.js'

const INSTRUCTIONS = RELAY_SOLANA_QUOTE.steps[0].items[0].data.instructions

test('serialises to base64 that round-trips back to the same instruction', async () => {
  const { Transaction } = await import('@solana/web3.js')

  const b64 = buildSolanaTransaction({
    instructions: INSTRUCTIONS,
    feePayer: SOL_PAYER,
    blockhash: SOL_BLOCKHASH,
  })

  const tx = Transaction.from(Buffer.from(b64, 'base64'))

  assert.equal(tx.instructions.length, 1)
  assert.equal(tx.instructions[0].programId.toBase58(), INSTRUCTIONS[0].programId)
  assert.equal(tx.recentBlockhash, SOL_BLOCKHASH)
  assert.equal(tx.feePayer.toBase58(), SOL_PAYER)
})

test('preserves account order exactly — position is what the program indexes on', async () => {
  const { Transaction } = await import('@solana/web3.js')
  const b64 = buildSolanaTransaction({
    instructions: INSTRUCTIONS, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH,
  })
  const keys = Transaction.from(Buffer.from(b64, 'base64')).instructions[0].keys

  /* Order is the consensus-critical property: the program indexes into this
     array positionally, so a reorder does not fail loudly — it moves funds to
     a different account. */
  assert.equal(keys.length, INSTRUCTIONS[0].keys.length)
  keys.forEach((k, i) => {
    assert.equal(k.pubkey.toBase58(), INSTRUCTIONS[0].keys[i].pubkey, `key ${i} pubkey`)
  })
})

test('flags merge per unique account, as the wire format requires', async () => {
  const { Transaction } = await import('@solana/web3.js')
  const b64 = buildSolanaTransaction({
    instructions: INSTRUCTIONS, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH,
  })
  const keys = Transaction.from(Buffer.from(b64, 'base64')).instructions[0].keys

  /* A Solana message holds ONE signer/writable flag per unique pubkey, taken
     from its single slot in the compiled account-keys array — not one per
     occurrence. So when Relay lists the same account twice with different
     roles, both occurrences round-trip as the union of those roles. The fee
     payer is additionally forced signer+writable by protocol rule.
     Asserting per-occurrence equality with Relay's JSON is therefore
     unsatisfiable by any correct implementation. */
  const declared = INSTRUCTIONS[0].keys
  keys.forEach((k, i) => {
    const union = declared.filter((d) => d.pubkey === declared[i].pubkey)
    const isFeePayer = declared[i].pubkey === SOL_PAYER
    assert.equal(k.isSigner, isFeePayer || union.some((d) => d.isSigner), `key ${i} isSigner`)
    assert.equal(k.isWritable, isFeePayer || union.some((d) => d.isWritable), `key ${i} isWritable`)
  })
})

test('decodes the hex data unchanged — the amount must survive byte for byte', async () => {
  const { Transaction } = await import('@solana/web3.js')
  const b64 = buildSolanaTransaction({
    instructions: INSTRUCTIONS, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH,
  })
  const data = Transaction.from(Buffer.from(b64, 'base64')).instructions[0].data

  assert.equal(data.toString('hex'), INSTRUCTIONS[0].data)
  assert.equal(data.length, 48)
  /* Bytes 8..12 are the lamport amount, little-endian. 0x0ee6b280 = 250000000.
     If this drifts, the user sends a different amount than they were quoted. */
  assert.equal(data.readUInt32LE(8), 250_000_000)
})

test('rejects data that is not clean hex rather than silently truncating', () => {
  const bad = [{ ...INSTRUCTIONS[0], data: '0xzz' }]
  assert.throws(
    () => buildSolanaTransaction({ instructions: bad, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }),
    /hex/i,
  )
})

test('rejects a malformed base58 pubkey', () => {
  const bad = [{ ...INSTRUCTIONS[0], programId: 'not-a-real-pubkey!!!' }]
  assert.throws(() =>
    buildSolanaTransaction({ instructions: bad, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }))
})

test('requires at least one instruction', () => {
  assert.throws(
    () => buildSolanaTransaction({ instructions: [], feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }),
    /instruction/i,
  )
})

/* ---- blockhash provider ---- */

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

test('fetches a blockhash and reports its expiry height', async () => {
  const fetchImpl = stubFetch([['solana', async () => SOL_BLOCKHASH_REPLY]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl })

  const got = await p.get()
  assert.equal(got.blockhash, SOL_BLOCKHASH)
  assert.equal(got.lastValidBlockHeight, 280000000)
})

test('caches across callers so one RPC serves everyone', async () => {
  const c = clock()
  let calls = 0
  const fetchImpl = stubFetch([['solana', async () => { calls++; return SOL_BLOCKHASH_REPLY }]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl, ttlMs: 10_000, now: c.now })

  await Promise.all([p.get(), p.get(), p.get()])
  c.advance(9_000)
  await p.get()

  assert.equal(calls, 1, 'a blockhash is shared; it is not per-user state')
})

test('refetches once the cache window passes', async () => {
  const c = clock()
  let calls = 0
  const fetchImpl = stubFetch([['solana', async () => { calls++; return SOL_BLOCKHASH_REPLY }]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl, ttlMs: 10_000, now: c.now })

  await p.get()
  c.advance(10_001)
  await p.get()

  assert.equal(calls, 2)
})

test('surfaces an RPC error rather than returning a stale-looking null', async () => {
  const fetchImpl = stubFetch([['solana', async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'node behind' } })]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl })
  await assert.rejects(() => p.get(), /node behind/)
})
