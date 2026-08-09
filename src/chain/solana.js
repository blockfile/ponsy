/**
 * SOLANA TRANSACTION ASSEMBLY
 * -----------------------------------------------------------------------------
 * Turns Relay's instruction description into a signable transaction.
 *
 * This is the one place in the codebase with a real dependency, and the reason
 * is specific. The EVM side hand-rolls its ABI work because every call takes
 * zero arguments — calldata is a constant selector and decoding is hex slicing,
 * about forty lines. Solana serialisation is a message header, a compact-u16
 * account array, per-instruction account indexing and base64: roughly 150 lines
 * of exact binary work in which one off-by-one produces a malformed transaction
 * over real funds. The trade that justified hand-rolling there argues the
 * opposite here.
 *
 * A LEGACY transaction is built deliberately, not a v0 one. Relay returns a v0
 * shape carrying an address lookup table, but every account in the instruction
 * is named explicitly, so the table is a size optimisation rather than a
 * correctness requirement — and skipping it removes an RPC round trip per
 * quote. If Relay's solver ever turns out to care about the format, building v0
 * is a change contained entirely within this file.
 */

import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'

const HEX_RE = /^[0-9a-fA-F]*$/

/** Relay sends instruction data as hex with no 0x prefix. */
function decodeData(hex) {
  const s = String(hex ?? '')
  if (!HEX_RE.test(s) || s.length % 2 !== 0) {
    throw new Error(`instruction data must be even-length hex, got: ${s.slice(0, 24)}`)
  }
  return Buffer.from(s, 'hex')
}

/**
 * Builds an unsigned legacy transaction and returns it base64-encoded.
 *
 * Account order is preserved exactly as Relay gave it. That ordering is
 * consensus-critical — the program indexes into the array positionally, so a
 * reorder does not fail loudly, it moves funds somewhere else.
 */
export function buildSolanaTransaction({ instructions, feePayer, blockhash }) {
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new Error('at least one instruction is required')
  }
  if (!blockhash) throw new Error('a recent blockhash is required')

  const tx = new Transaction()
  for (const raw of instructions) {
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(raw.programId),
        keys: (raw.keys ?? []).map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: Boolean(k.isSigner),
          isWritable: Boolean(k.isWritable),
        })),
        data: decodeData(raw.data),
      }),
    )
  }

  tx.feePayer = new PublicKey(feePayer)
  tx.recentBlockhash = blockhash

  /* Unsigned by construction — the wallet signs. Serialising without that
     assertion is the whole point: the backend must never hold a key. */
  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64')
}

/**
 * A shared, briefly-cached blockhash.
 *
 * A blockhash is not per-user state — every transaction in the same few seconds
 * can carry the same one. Caching it means a public Solana RPC is sufficient
 * even under load: this is one cheap call every ttlMs, not one per visitor.
 */
export function createBlockhashProvider({
  rpcUrl,
  ttlMs = 10_000,
  timeoutMs = 8_000,
  now = Date.now,
  fetchImpl = fetch,
}) {
  let cached = null
  let storedAt = 0
  let inFlight = null

  async function fetchOne(signal) {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)

    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'confirmed' }],
      }),
      signal: AbortSignal.any(signals),
    })
    if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`)

    const json = await res.json()
    if (json?.error) throw new Error(`Solana RPC: ${json.error.message ?? 'unknown'}`)

    const value = json?.result?.value
    if (!value?.blockhash) throw new Error('Solana RPC returned no blockhash')

    return {
      blockhash: value.blockhash,
      lastValidBlockHeight: value.lastValidBlockHeight ?? null,
    }
  }

  async function get({ signal } = {}) {
    if (cached && now() - storedAt < ttlMs) return cached

    if (!inFlight) {
      inFlight = (async () => {
        try {
          cached = await fetchOne(signal)
          storedAt = now()
          return cached
        } finally {
          inFlight = null
        }
      })()
    }
    return inFlight
  }

  return { get }
}
