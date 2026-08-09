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

/* `+`, not `*`: an empty string must fail this test on its own. Combined with
   dropping the old `?? ''` fallback below, a missing, null, or renamed `data`
   field from Relay throws here instead of silently becoming a zero-byte
   instruction — one that looks valid, gets signed, and only fails on-chain
   after the user has already approved it. */
const HEX_RE = /^[0-9a-fA-F]+$/

/** Relay sends instruction data as hex with no 0x prefix. */
function decodeData(hex) {
  const s = String(hex)
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

  const feePayerKey = new PublicKey(feePayer)

  const tx = new Transaction()
  for (const raw of instructions) {
    /* A missing or empty `keys` is the same class of problem as missing
       `data`: a structurally valid-looking instruction that touches no
       accounts, guaranteed to fail on-chain after the user has approved it. */
    if (!Array.isArray(raw.keys) || raw.keys.length === 0) {
      throw new Error('instruction keys must be a non-empty array')
    }
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(raw.programId),
        keys: raw.keys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: Boolean(k.isSigner),
          isWritable: Boolean(k.isWritable),
        })),
        data: decodeData(raw.data),
      }),
    )
  }

  /* Relay is expected to name the fee payer as a signer among the
     instructions' own keys. If it doesn't, the compiled message ends up
     requiring a signature the wallet was never shown a reason to give, and
     the mismatch would otherwise surface only after the user has approved
     the prompt, as an opaque RPC rejection rather than a caught error here. */
  const feePayerIsSigner = instructions.some((raw) =>
    raw.keys.some((k) => Boolean(k.isSigner) && k.pubkey === feePayer),
  )
  if (!feePayerIsSigner) {
    throw new Error(`feePayer ${feePayer} is not declared as a signer in any instruction`)
  }

  tx.feePayer = feePayerKey
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

  async function fetchOne() {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'confirmed' }],
      }),
      /* Bounded only by timeoutMs — deliberately never by a caller's own
         AbortSignal. This fetch is shared: every concurrent caller is
         coalesced onto the one in-flight request, so wiring a per-caller
         signal in here would mean one visitor closing their tab cancels the
         blockhash everyone else concurrently waiting is depending on.
         Per-caller give-up is handled at the get() boundary below instead,
         without touching the shared request. Do not "fix" this by threading
         a signal back in. */
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`)

    const json = await res.json()
    if (json?.error) throw new Error(`Solana RPC: ${json.error.message ?? 'unknown'}`)

    const value = json?.result?.value
    if (!value?.blockhash) throw new Error('Solana RPC returned no blockhash')

    /* Frozen because this same object is handed to every caller sharing the
       cache — one caller mutating it would corrupt what everyone else reads. */
    return Object.freeze({
      blockhash: value.blockhash,
      lastValidBlockHeight: value.lastValidBlockHeight ?? null,
    })
  }

  async function get({ signal } = {}) {
    if (cached && now() - storedAt < ttlMs) return cached

    if (!inFlight) {
      inFlight = (async () => {
        try {
          cached = await fetchOne()
          storedAt = now()
          return cached
        } finally {
          inFlight = null
        }
      })()
    }
    const shared = inFlight

    if (!signal) return shared

    /* Race this caller's own signal against the shared fetch instead of
       passing it into fetchOne — giving up must stop only this call from
       waiting, not cancel the request every other caller is joined on. */
    if (signal.aborted) throw signal.reason ?? new Error('aborted')
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  return { get }
}
