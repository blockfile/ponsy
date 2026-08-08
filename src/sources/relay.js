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
      /* The payer receives the tokens. A separate recipient is a footgun we
         have no use for: it would let a caller direct someone else's funds. */
      recipient: params.user,
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

  const json = await res.json().catch(() => ({}))

  if (!res.ok) {
    /* Relay names the failure — NO_SWAP_ROUTES_FOUND, AMOUNT_TOO_LOW and so on.
       Passing that through beats "HTTP 400", which tells the user nothing. */
    throw new Error(json.errorCode || json.message || `Relay HTTP ${res.status}`)
  }
  return json
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
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.errorCode || `Relay HTTP ${res.status}`)
  return json
}
