/**
 * JSON-RPC CLIENT
 * -----------------------------------------------------------------------------
 * A batching `eth_call` client over fetch. No provider library.
 *
 * Batching is not a micro-optimisation here: pricing needs four reads
 * (totalSupply, decimals, slot0, token0) and sending them as one HTTP request
 * means they are answered against the same chain state. Four sequential
 * requests can straddle a block, which on a thin pool is enough to pair a
 * pre-trade price with a post-trade supply and print a market cap that never
 * existed.
 */

/**
 * Creates an RPC client bound to one endpoint.
 *
 * @param {object}   opts
 * @param {string}   opts.url         JSON-RPC endpoint
 * @param {number}   opts.timeoutMs   per-request timeout
 * @param {Function} [opts.fetchImpl] injectable for tests
 */
export function createRpcClient({ url, timeoutMs = 8000, fetchImpl = fetch }) {
  /**
   * Sends a batch of `eth_call`s and returns their raw returndata, in the same
   * order as the calls given.
   *
   * @param {Array<{to: string, data: string}>} calls
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<string[]>} hex returndata per call
   */
  async function ethCallBatch(calls, { signal } = {}) {
    if (calls.length === 0) return []

    const payload = calls.map((call, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'eth_call',
      params: [{ to: call.to, data: call.data }, 'latest'],
    }))

    /* Combine the caller's cancellation with our own timeout, so a hung
       upstream cannot pin a request open past the deadline. */
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    })

    if (!res.ok) {
      throw new Error(`RPC HTTP ${res.status} from ${url}`)
    }

    const json = await res.json()

    /* A batch request may legally be answered with a single error object when
       the whole batch is rejected, so this is not always an array. */
    if (!Array.isArray(json)) {
      if (json?.error) {
        throw new Error(`RPC error: ${json.error.message ?? 'unknown'}`)
      }
      throw new Error('RPC returned a non-array response to a batch request')
    }

    /* Responses may come back in any order, so map them by id rather than
       trusting position — a reordered batch would otherwise decode slot0 as a
       totalSupply and produce a plausible, entirely wrong price. */
    const byId = new Map(json.map((r) => [r.id, r]))

    return calls.map((_, i) => {
      const entry = byId.get(i)
      if (!entry) throw new Error(`RPC response missing id ${i}`)
      if (entry.error) {
        throw new Error(`RPC error on call ${i}: ${entry.error.message ?? 'unknown'}`)
      }
      if (typeof entry.result !== 'string') {
        throw new Error(`RPC returned no result for call ${i}`)
      }
      return entry.result
    })
  }

  return { ethCallBatch, url }
}
