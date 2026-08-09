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

test('the output is unsigned — one signature slot, sixty-four zero bytes', () => {
  const b64 = buildSolanaTransaction({
    instructions: INSTRUCTIONS, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH,
  })
  const raw = Buffer.from(b64, 'base64')

  /* This is the property the file exists to guarantee — the backend must
     never hold a key — made explicit rather than left implicit in the other
     tests. */
  assert.equal(raw[0], 1, 'compact-u16 signature count')
  assert.ok(raw.subarray(1, 65).every((b) => b === 0), 'the signature slot must be all zero, not a real signature')
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

test('rejects odd-length hex rather than misreading the byte boundary', () => {
  const bad = [{ ...INSTRUCTIONS[0], data: 'abc' }]
  assert.throws(
    () => buildSolanaTransaction({ instructions: bad, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }),
    /hex/i,
  )
})

test('rejects missing instruction data (null or undefined) rather than building a zero-byte instruction', () => {
  for (const missing of [null, undefined]) {
    const bad = [{ ...INSTRUCTIONS[0], data: missing }]
    assert.throws(
      () => buildSolanaTransaction({ instructions: bad, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }),
      /hex/i,
    )
  }
})

test('rejects non-string instruction data instead of silently stringifying it into something hex-shaped', () => {
  /* String(12) is '12' and String(['ab']) is 'ab' — both look like valid hex
     once stringified, which is exactly how a wrong-typed field used to slip
     through unnoticed. */
  for (const notAString of [12, ['ab']]) {
    const bad = [{ ...INSTRUCTIONS[0], data: notAString }]
    assert.throws(
      () => buildSolanaTransaction({ instructions: bad, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }),
      /hex/i,
    )
  }
})

test('accepts genuinely empty instruction data — some real Solana instructions carry zero bytes', async () => {
  const { Transaction } = await import('@solana/web3.js')
  const withEmptyData = [{ ...INSTRUCTIONS[0], data: '' }]
  const b64 = buildSolanaTransaction({ instructions: withEmptyData, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH })
  const data = Transaction.from(Buffer.from(b64, 'base64')).instructions[0].data

  assert.equal(data.length, 0)
})

test('rejects a malformed base58 pubkey', () => {
  const bad = [{ ...INSTRUCTIONS[0], programId: 'not-a-real-pubkey!!!' }]
  assert.throws(() =>
    buildSolanaTransaction({ instructions: bad, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }))
})

test('rejects an instruction with no keys rather than building a zero-account instruction', () => {
  const bad = [{ ...INSTRUCTIONS[0], keys: undefined }]
  assert.throws(
    () => buildSolanaTransaction({ instructions: bad, feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }),
    /keys/i,
  )
})

test('accepts an empty keys array on one instruction — some real Solana instructions touch no accounts', async () => {
  const { Transaction } = await import('@solana/web3.js')
  /* The real fixture instruction still names SOL_PAYER as a signer, so the
     feePayer cross-check is satisfied by it; the second, synthetic
     instruction is the one actually under test here — zero accounts. */
  const noAccountsInstruction = { programId: INSTRUCTIONS[0].programId, keys: [], data: '00' }
  const b64 = buildSolanaTransaction({
    instructions: [INSTRUCTIONS[0], noAccountsInstruction], feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH,
  })
  const tx = Transaction.from(Buffer.from(b64, 'base64'))

  assert.equal(tx.instructions.length, 2)
  assert.equal(tx.instructions[1].keys.length, 0)
})

test('requires at least one instruction', () => {
  assert.throws(
    () => buildSolanaTransaction({ instructions: [], feePayer: SOL_PAYER, blockhash: SOL_BLOCKHASH }),
    /instruction/i,
  )
})

test('rejects a feePayer that is not declared as a signer in any instruction', () => {
  /* Index 3 of the fixture (7uTT8Xi...) is a real key in this instruction,
     just not one Relay marked isSigner:true — the boundary this check exists
     to catch, as opposed to a pubkey absent from the instruction entirely. */
  const notASigner = INSTRUCTIONS[0].keys[3].pubkey
  assert.throws(
    () => buildSolanaTransaction({ instructions: INSTRUCTIONS, feePayer: notASigner, blockhash: SOL_BLOCKHASH }),
    /signer/i,
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

test('an aborting caller rejects only itself; a concurrent caller still resolves from the same fetch', async () => {
  let calls = 0
  const fetchImpl = stubFetch([['solana', async () => { calls++; return SOL_BLOCKHASH_REPLY }]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl })

  const ac = new AbortController()
  const aborting = p.get({ signal: ac.signal })
  const concurrent = p.get()
  ac.abort(new Error('caller gave up'))

  await assert.rejects(aborting, /caller gave up/)
  assert.equal((await concurrent).blockhash, SOL_BLOCKHASH)
  assert.equal(calls, 1, 'the shared fetch runs once regardless of the abort')
})

test('inFlight clears after an abort, so a later caller starts a fresh fetch', async () => {
  const c = clock()
  let calls = 0
  const fetchImpl = stubFetch([['solana', async () => { calls++; return SOL_BLOCKHASH_REPLY }]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl, ttlMs: 10_000, now: c.now })

  const ac = new AbortController()
  const aborting = p.get({ signal: ac.signal })
  const concurrent = p.get() // rides the same shared fetch, unaffected by the abort
  ac.abort()

  await assert.rejects(aborting)
  await concurrent // the shared fetch has now fully settled and cleared inFlight

  c.advance(10_001)
  await p.get()

  assert.equal(calls, 2, 'a later call past the TTL starts a fresh fetch rather than being stuck')
})

test('a pre-aborted signal rejects immediately without starting a fetch', async () => {
  let calls = 0
  const fetchImpl = stubFetch([['solana', async () => { calls++; return SOL_BLOCKHASH_REPLY }]])
  const p = createBlockhashProvider({ rpcUrl: 'https://solana.example', fetchImpl })

  const ac = new AbortController()
  ac.abort(new Error('already gone'))

  /* This is the crash regression: checking `signal.aborted` after the shared
     fetch was already created meant a pre-aborted caller discarded it
     without attaching a handler — an eventual rejection became an unhandled
     rejection under Node's default --unhandled-rejections=throw. */
  await assert.rejects(() => p.get({ signal: ac.signal }), /already gone/)
  assert.equal(calls, 0, 'a caller who already gave up must not trigger an RPC round trip')
})
