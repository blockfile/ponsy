/**
 * RELAY
 * -----------------------------------------------------------------------------
 * Transport only: builds the request, posts it, hands back what Relay said.
 *
 * All policy — which token, which chains, what minimum — lives in quote.js.
 * Keeping them apart means the rules can be tested without a network stub and
 * the transport can be tested without reasoning about the rules.
 */

/**
 * Requests a swap quote.
 *
 * @returns {Promise<object>} the raw Relay response
 */
export async function fetchRelayQuote(baseUrl, params, { timeoutMs = 15000, signal, fetchImpl = fetch } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)

  const res = await fetchImpl(`${baseUrl}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      user: params.user,
      /* Defaults to the payer when the caller supplies no recipient — the
         same behaviour as before a separate recipient existed. Now explicit
         for a Solana origin: a Solana keypair has no EVM address, so
         quote.js passes the real 0x destination through here rather than
         letting it silently collapse back to the (base58) payer. */
      recipient: params.recipient ?? params.user,
      originChainId: params.originChainId,
      destinationChainId: params.destinationChainId,
      originCurrency: params.originCurrency,
      destinationCurrency: params.destinationCurrency,
      amount: params.amount,
      tradeType: 'EXACT_INPUT',
      ...(params.appFees ? { appFees: params.appFees } : {}),
    }),
    signal: AbortSignal.any(signals),
  })

  /* Deliberately asymmetric tolerance: on the error path below, a failed body
     parse still falls back to a status-based message, because Relay's error
     detail is a bonus, not a guarantee. On the success path, a failed parse
     is a real transport fault, not "no data", and must throw rather than be
     swallowed into `{}` — do not "simplify" this back to one tolerant parse. */
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    /* Relay names the failure — NO_SWAP_ROUTES_FOUND, AMOUNT_TOO_LOW and so on.
       Passing that through beats "HTTP 400", which tells the user nothing. */
    throw new Error(json.errorCode || json.message || `Relay HTTP ${res.status}`)
  }

  try {
    return await res.json()
  } catch (err) {
    throw new Error(`Relay quote response could not be parsed as JSON: ${err.message}`)
  }
}

/** Polls an intent by the requestId returned with the quote. */
export async function fetchRelayStatus(baseUrl, requestId, { timeoutMs = 10000, signal, fetchImpl = fetch } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)

  const url = `${baseUrl}/intents/status?requestId=${encodeURIComponent(requestId)}`
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.any(signals),
  })

  /* Same asymmetry as fetchRelayQuote: tolerant parse on error (best-effort
     errorCode extraction), strict parse on success (a 2xx with an unparseable
     body is a transport fault and must throw, not become `{}`). */
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    throw new Error(json.errorCode || `Relay HTTP ${res.status}`)
  }

  try {
    return await res.json()
  } catch (err) {
    throw new Error(`Relay status response could not be parsed as JSON: ${err.message}`)
  }
}
