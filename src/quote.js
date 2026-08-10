/**
 * QUOTE POLICY
 * -----------------------------------------------------------------------------
 * Everything the browser is not allowed to decide.
 *
 * The destination token is fixed here and never read from the request. Twelve
 * tokens on chain 4663 call themselves PONSY, two of them using vanity
 * addresses ending ...083e to look like the real one. A client-supplied
 * destination would make this endpoint a convenient way to route a visitor's
 * money into a copy.
 */

import { fetchRelayQuote, fetchRelayStatus } from './sources/relay.js'
import { buildSolanaTransaction } from './chain/solana.js'
import { resolveToken, resolvePayAssetKey } from './tokens.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** The zero address, used only to detect a Solana recipient that would burn
    the PONSY it receives. Not an origin-currency identifier — those now come
    from tokens.js's resolveToken(). */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Placeholder addresses used ONLY to price a quote when nobody has connected
 * a wallet — a request with no `user` (see `priceOnly` in getQuote below).
 * Relay's pricing call still needs a syntactically valid `user` and, for a
 * Solana origin, a syntactically valid EVM `recipient`, to price against —
 * but nothing downstream may ever build a SIGNABLE transaction around either
 * one. Safe for pricing: neither address has a private key anyone controls
 * (the EVM one is the conventional unspendable "dead" address; the Solana
 * one is the System Program's all-zero-byte key), so a quote priced against
 * them commits nobody to anything. Unsafe for signing: a real transaction
 * addressed to or from a placeholder would move a real user's PONSY to an
 * account nobody can ever recover it from — which is exactly why getQuote()
 * omits tx/steps/solanaTx entirely, rather than merely building them around
 * these, whenever priceOnly is true.
 */
const PRICE_ONLY_ADDRESS_EVM = '0x' + 'dead'.repeat(10)
const PRICE_ONLY_ADDRESS_SVM = '11111111111111111111111111111111'

/** Relay's id for Solana. Verified live. Still drives VM branching even
    though the currency itself is resolved via tokens.js. */
export const SOLANA_CHAIN_ID = 792703809

/* Base58 excludes 0, O, I and l precisely so addresses cannot be misread.
   Length is 32-44 characters for a 32-byte key. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Decimal string -> integer wei string, without floating point. */
export function toWei(amount, decimals = 18) {
  const s = String(amount).trim()
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') {
    throw new Error(`amount must be a valid decimal number, got: ${amount}`)
  }
  const [whole = '0', frac = ''] = s.split('.')
  if (frac.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimal places`)
  }
  const padded = (whole + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '')
  if (BigInt(padded) <= 0n) {
    throw new Error(`amount must be a positive number, got: ${amount}`)
  }
  return padded
}

/** SOL has 9 decimals, not 18. Same exact-integer path as toWei. */
export function toLamports(amount) {
  return toWei(amount, 9)
}

/** Decimal string -> smallest units for a token of the given decimals. */
function toUnits(amount, decimals) {
  return toWei(amount, decimals)
}

/** Raw integer string -> whole tokens as a Number. */
function fromRaw(raw, decimals = 18) {
  const v = BigInt(raw)
  const scale = 10n ** BigInt(decimals)
  return Number(v / scale) + Number(v % scale) / Number(scale)
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Requested slippage tolerance -> a finite number, defaulting to 1 (matches
    the widget's own DEFAULT_SLIPPAGE) for anything missing or unusable.
    Deliberately not `num()`, which defaults to 0 — 0% slippage tolerance is
    a real, much stricter setting than "not specified", so the two must not
    collapse into the same value. */
function parseSlippage(value) {
  if (value === undefined || value === null || value === '') return 1
  const n = Number(value)
  return Number.isFinite(n) ? n : 1
}

/**
 * Parses Relay's gas LIMIT into a definite JS number, or undefined if
 * absent/unusable — never 0, never a string.
 *
 * Runs through Number() rather than a `typeof === 'number'` check: a live
 * capture against api.relay.link (2026-08-09, two independent requests,
 * different amounts) showed this field arriving as `"32713"` — a JSON
 * *string* — not the bare number the field conceptually is. A strict
 * typeof check would silently drop gas on every real quote while still
 * passing a fixture-based test that (reasonably, but incorrectly per this
 * live evidence) encodes it as a number. Number() normalises either wire
 * shape to the same value, so the forwarded field is always a genuine
 * number by the time it reaches the frontend's toHexQuantityLoose.
 */
function parseGasLimit(value) {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export function createQuoteService({ config, fetchImpl = fetch, blockhash }) {
  /* A missing or malformed blockhash provider must fail here, at
     construction — index.js calls this once, at boot — not three levels
     deep inside a live request handler after a Relay round trip has already
     happened. Before this check, an omitted provider surfaced as a bare
     `Cannot read properties of undefined (reading 'get')` TypeError, caught
     by server.js's generic catch-all and reported to the caller as an
     opaque HTTP 400 — a wiring bug dressed up as a user-facing error. */
  if (!blockhash?.get) {
    throw new Error('createQuoteService requires a blockhash provider with a get() method')
  }

  async function getQuote({
    user, chainId, amount, recipient, token, signal,
    // New, additive request shape — see tokens.js's resolvePayAssetKey.
    // Never read unless `from` is present, so a caller using the existing
    // (chainId, token, user, recipient) shape is completely unaffected by
    // any of these three.
    from, to, toNetwork, slippage,
  }) {
    if (!config.tokenAddress) {
      throw new Error('TOKEN_ADDRESS is not set')
    }

    /* Detected by the presence of `from`, per the swap widget's contract:
       it names an asset by key ("usdc-eth") instead of a chain id and a
       token key. Resolved into `chainId`/`token` and then handled by every
       line below exactly as the existing shape already is — this is the
       only place the two request shapes diverge. */
    if (from !== undefined && from !== null && from !== '') {
      /* The destination is fixed server-side (config.tokenAddress, chain
         4663 below) and never actually read from `to`/`toNetwork` — but a
         caller sending one that ISN'T "ponsy" has a bug worth surfacing
         rather than silently quoting PONSY anyway. */
      if (to !== undefined && to !== '' && to !== 'ponsy') {
        throw new Error(`unsupported destination "${to}" — this endpoint only quotes PONSY`)
      }
      if (toNetwork !== undefined && toNetwork !== '' && toNetwork !== 'ponsy') {
        throw new Error(`unsupported destination network "${toNetwork}" — this endpoint only quotes PONSY`)
      }
      const resolved = resolvePayAssetKey(String(from))
      chainId = resolved.chainId
      token = resolved.token
    }

    const origin = Number(chainId)
    if (!config.allowedChainIds.includes(origin)) {
      throw new Error(`chain ${chainId} is not supported`)
    }

    const isSolana = origin === SOLANA_CHAIN_ID

    /* Resolved from a closed set of keys, never from an address in the
       request. See src/tokens.js for why. */
    const originToken = resolveToken(origin, token ?? 'native')

    /* No `user` at all means a price-only quote — the swap widget's new
       shape never sends one, but the existing shape is equally entitled to
       omit it and get a price rather than a validation error. Everything
       from here on that would produce something SIGNABLE (the blockhash
       fetch below, and the tx/steps/solanaTx assembly further down) is
       gated on this being false. See PRICE_ONLY_ADDRESS_EVM/SVM above for
       why a placeholder is safe for this and only this. */
    const priceOnly = user === undefined || user === null || user === ''

    let payer
    let receiver
    if (priceOnly) {
      payer = isSolana ? PRICE_ONLY_ADDRESS_SVM : PRICE_ONLY_ADDRESS_EVM
      /* A Solana quote's destination is an EVM address; an EVM quote's
         payer receives directly — same shape as the real branch below. */
      receiver = isSolana ? PRICE_ONLY_ADDRESS_EVM : payer
    } else {
      if (isSolana) {
        if (!BASE58_RE.test(String(user ?? ''))) {
          throw new Error('user must be a base58 Solana address for a Solana origin')
        }
        /* A Solana keypair has no EVM address, so the destination cannot be
           derived — it has to be supplied. Guessing one would send PONSY
           somewhere unrecoverable. */
        if (!ADDRESS_RE.test(String(recipient ?? ''))) {
          throw new Error('recipient must be a 0x address when paying from Solana')
        }
        /* The zero address is a syntactically valid 0x string, so the check
           above alone lets it through. On EVM this was never reachable — the
           recipient there is always the connected wallet — but a Solana
           recipient is a free-form field, so a frontend bug or a crafted link
           can produce a signable transaction that delivers PONSY to a burn
           address. */
        if (String(recipient).toLowerCase() === ZERO_ADDRESS) {
          throw new Error('recipient must not be the zero address — that PONSY would be unrecoverable')
        }
      } else if (!ADDRESS_RE.test(String(user ?? ''))) {
        throw new Error('user must be a 0x-prefixed 40-hex-character address')
      }

      /* Re-stringified rather than forwarded as-is: Express turns
         `?user[0]=...` into a one-element array, and String() of a
         one-element array equals its bare element — so the ADDRESS_RE/
         BASE58_RE checks above can pass while `user`/`recipient` are still
         arrays, not strings. Letting that array reach the Relay request body,
         or buildSolanaTransaction's feePayer below, is the actual hazard:
         `new PublicKey(['abc...'])` does not throw, it silently yields the
         all-zeros system-program key (verified directly against
         @solana/web3.js) — caught in this codebase's own tests only by
         incidental luck, because that bogus key happens not to be declared a
         signer in the captured fixture's instructions. A plain string is the
         one thing every downstream consumer must receive. */
      payer = String(user)
      /* On EVM the payer receives, exactly as before. */
      receiver = isSolana ? String(recipient) : payer
    }

    /* Started here — before the Relay round trip — and awaited only where
       the value is actually used, inside the `isSolana` branch below. The
       blockhash does not depend on the quote's result, so there is no reason
       to make it wait on one.

       This used to run strictly after `raw = await fetchRelayQuote(...)`
       resolved. Both this call and fetchRelayQuote bound themselves at
       ~config.upstreamTimeoutMs independently (8s by default) — sequencing
       them composed those two budgets into a ~16s worst case that could
       outlive nginx's 15s proxy_read_timeout (deploy/nginx.conf) even though
       neither individual upstream call had itself timed out. This is the
       same class of bug that produced the /stats outage documented in
       deploy/DEPLOY.md — two sequential ~8s calls adding up past the same
       15s ceiling. Starting both here and racing them caps the combined wait
       at max(quote, blockhash) instead of quote + blockhash.

       The `.catch(() => {})` immediately below is required, not decorative.
       If `fetchRelayQuote` rejects first (a very normal outcome — a bad
       route, a down upstream), this promise may still be in flight and
       nothing has awaited it yet. A promise that rejects with no attached
       handler becomes an unhandled rejection, and Node's default
       `--unhandled-rejections=throw` turns that into a process crash — a
       strictly worse failure than the timeout this change fixes. Attaching
       a no-op handler the instant the promise is created absorbs that
       specific hazard without hiding a real failure: `await pendingBlockhash`
       below still throws normally on its own rejection, for whichever
       request actually reaches it.

       Gated on !priceOnly too: a blockhash exists to make a transaction
       signable, and a price-only quote will never build one (see the
       isSolana branch of the tx-assembly block below) — fetching it anyway
       would be a wasted Solana RPC call on every price-only request. */
    const pendingBlockhash = isSolana && !priceOnly ? blockhash.get({ signal }) : null
    pendingBlockhash?.catch(() => {})

    const raw = await fetchRelayQuote(
      config.relayUrl,
      {
        user: payer,
        recipient: receiver,
        originChainId: origin,
        destinationChainId: 4663,
        originCurrency: originToken.address,
        // Fixed. Deliberately ignores anything the caller sent.
        destinationCurrency: config.tokenAddress,
        amount: toUnits(amount, originToken.decimals),
      },
      { fetchImpl, timeoutMs: config.upstreamTimeoutMs },
    )

    const d = raw?.details ?? {}

    /* Fail CLOSED, deliberately. num() maps a missing, "0", or garbled
       amountUsd to 0, and 0 is not > 0 — reusing num() for this check would
       let an unverifiable trade value sail through as if it had no minimum
       at all, defeating the one control this layer exists to enforce. So
       this parses independently of num() and rejects anything that isn't a
       usable positive number, with a message distinct from the below-minimum
       one below so the two failure modes are debuggable apart. Do not
       "simplify" this back to num(d.currencyIn?.amountUsd) > 0 — that
       reintroduces the fail-open bug. */
    const inUsd = Number(d.currencyIn?.amountUsd)
    if (!Number.isFinite(inUsd) || inUsd <= 0) {
      throw new Error('could not verify the trade value in USD — refusing to quote')
    }

    /* Checked after quoting rather than before, because the minimum is in USD
       and only Relay knows what the user's native asset is worth right now. */
    if (inUsd < config.minTradeUsd) {
      throw new Error(
        `minimum trade is $${config.minTradeUsd} — fixed costs would exceed 5% below that`,
      )
    }

    const outDecimals = d.currencyOut?.currency?.decimals ?? 18
    const amountOut = num(d.currencyOut?.amountFormatted)
    const amountIn = num(d.currencyIn?.amountFormatted)
    const item = raw?.steps?.[0]?.items?.[0]

    /* Solana and EVM quotes carry incompatible signing payloads — one an
       instruction list, the other calldata — so exactly one of solanaTx/tx is
       built here and spread into the response below. Never both, never
       neither: a frontend that hasn't been updated for the other VM must fail
       loudly on an undefined field rather than sign something meaningless.

       A price-only quote (priceOnly true) builds NEITHER: txField stays `{}`
       and nothing below it is spread into the response, so amountOut /
       priceImpact / etc. still price out normally, but there is no
       signable payload for a placeholder-addressed request to be attached
       to. This is the one gate this whole feature exists to get right — see
       PRICE_ONLY_ADDRESS_EVM/SVM's comment at the top of this file. */
    let txField = {}
    /* How many signatures this quote actually requires, hoisted out of the
       branch below so the shared `route` string can reflect it. A Solana
       quote is always exactly one blob to sign; an EVM quote may be one
       (deposit) or two (approve, deposit). */
    let stepCount
    if (isSolana) {
      const ixs = item?.data?.instructions
      if (!Array.isArray(ixs) || ixs.length === 0) {
        throw new Error('Relay returned no Solana instructions to sign')
      }
      stepCount = 1
      if (!priceOnly) {
        const { blockhash: hash, lastValidBlockHeight } = await pendingBlockhash
        txField = {
          solanaTx: {
            base64: buildSolanaTransaction({
              instructions: ixs,
              feePayer: payer,
              blockhash: hash,
            }),
            lastValidBlockHeight,
          },
        }
      }
    } else {
      const rawSteps = raw?.steps ?? []
      if (rawSteps.length === 0) throw new Error('Relay returned no steps to sign')
      stepCount = rawSteps.length

      if (!priceOnly) {
        /* Every step is validated the same way the old single-transaction path
           validated its one step — `to` and `from` must both be present — but
           now for EACH step, with the step id in the message. A two-step quote
           (approve, deposit) whose approval is well-formed but whose deposit is
           missing `to` must fail on the deposit specifically, not pass because
           only steps[0] was ever checked. */
        const steps = rawSteps.map((s) => {
          const d = s?.items?.[0]?.data
          if (!d?.to) throw new Error(`Relay step "${s?.id}" has no transaction to sign`)
          /* `from` is forwarded to the frontend and relied on by two independent
             downstream guards: the wallet only gets to validate its selected
             account against a `from` that actually exists on `tx`, and the
             frontend's own account-match check (`if (from && ...)`) skips
             entirely when `from` is absent — silently, not fail-closed. Refuse
             here rather than let a Relay response with no `from` defeat both. */
          if (!d?.from) throw new Error(`Relay step "${s?.id}" has no sending account`)
          const gasLimit = parseGasLimit(d.gas)
          return {
            id: s.id,
            tx: {
              /* Carried through because some wallets reject eth_sendTransaction
                 without an explicit `from`. Relay echoes back the `user` we sent, so
                 this is the connected account by construction. */
              from: d.from,
              to: d.to,
              data: d.data,
              value: String(d.value ?? '0'),
              chainId: d.chainId,
              /* Gas LIMIT, forwarded as a genuine JS number (see parseGasLimit) —
                 never stringified, never hex-encoded, and never a stale
                 maxFeePerGas/maxPriorityFeePerGas (those are prices, not limits,
                 and go stale between quote and send — see prior revisions of this
                 file for the full incident writeup). Omitted entirely, never
                 null/0, when Relay doesn't supply a usable one, so the wallet
                 falls back to its own estimation. */
              ...(gasLimit !== undefined ? { gas: gasLimit } : {}),
            },
          }
        })

        /* `tx` is retained for single-step quotes so a client that predates the
           steps array keeps working. A multi-step quote deliberately omits it:
           such a client must fail loudly rather than sign the approval and stop,
           leaving the user having paid gas for nothing. */
        txField = steps.length === 1 ? { steps, tx: steps[0].tx } : { steps }
      }
    }

    return {
      amountIn,
      amountOut,
      amountInUsd: inUsd,
      amountOutUsd: num(d.currencyOut?.amountUsd),
      // Tokens per 1 unit of the source chain's native asset. Derived rather
      // than read, so it always agrees with the two amounts shown directly
      // above it in the UI.
      rate: amountIn > 0 ? amountOut / amountIn : 0,
      /* A fraction, not a percentage: the widget's formatPct multiplies by 100.
         Relay's "-5.12" passed through unchanged would render "-512.00%". */
      priceImpact: num(d.totalImpact?.percent) / 100,
      minReceived: d.currencyOut?.minimumAmount
        ? fromRaw(d.currencyOut.minimumAmount, outDecimals)
        : 0,
      /* relayer + app only — not fees.gas. fees.relayer is already the total
         of Relay's own relayerGas + relayerService legs (verified against a
         live quote: 0.648713 + 0.081292 = 0.730005 = fees.relayer), while
         fees.gas is the origin-chain gas the user's own wallet charges and
         displays separately. Adding it here would double-count it. */
      feeUsd: num(raw?.fees?.relayer?.amountUsd) + num(raw?.fees?.app?.amountUsd),
      timeEstimate: num(d.timeEstimate),
      /* Same value as timeEstimate above, under the name the swap widget
         actually reads: it renders `etaSeconds ?? estimatedTime`, and
         neither of those was ever sent, so its ETA rendered as a dash. Kept
         as a second field rather than a rename — `timeEstimate` already
         serves the other, deployed frontend and must not move. */
      etaSeconds: num(d.timeEstimate),
      /* True unless the ORIGIN is already Robinhood Chain (4663) — the
         destination this endpoint always quotes to. Paying from 4663 is the
         one case that is not actually a cross-chain swap. */
      crossChain: origin !== 4663,
      // Echoes back what was requested, defaulting to 1 exactly like the
      // widget's own DEFAULT_SLIPPAGE — this layer doesn't currently use
      // the value for anything (Relay isn't told a slippage tolerance), so
      // echoing is honest: it reflects the request, not a promise enforced
      // upstream.
      slippage: parseSlippage(slippage),
      /* False for a price-only quote (see `priceOnly` above): tx/steps/
         solanaTx are deliberately absent from `txField` in that case, and
         this is the positive, always-present flag an executor can check
         instead of inferring "can I sign this?" from field absence. */
      executable: !priceOnly,
      /* Reflects the real signature count. A hardcoded "one transaction" here
         lied on a two-step (approve + deposit) quote — exactly the live USDC
         capture in this task's report — telling the user to expect one
         signature on the path that requires two. */
      route: `${originName(origin)} to Robinhood Chain, ${
        stepCount === 1 ? 'one transaction' : `${stepCount} transactions`
      }`,
      // Which origin asset this quote priced, so the UI can label the amount
      // without re-deriving it from the request it already sent.
      token: { key: originToken.key, symbol: originToken.symbol, decimals: originToken.decimals },
      /* A field that is always present and always meaningful, so an executor
         (Task 4) can branch on it directly instead of inferring the VM from
         which of tx/steps/solanaTx happens to be present — the defensive
         `quote.steps ?? []` idiom silently iterates zero steps and reports
         success on a Solana quote, having signed nothing. */
      vm: isSolana ? 'svm' : 'evm',
      ...txField,
      requestId: raw?.steps?.[0]?.requestId ?? null,
      mock: false,
    }
  }

  function getStatus(requestId) {
    if (!requestId) throw new Error('requestId is required')
    return fetchRelayStatus(config.relayUrl, requestId, {
      fetchImpl,
      timeoutMs: config.upstreamTimeoutMs,
    })
  }

  return { getQuote, getStatus }
}

const CHAIN_NAMES = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB Chain',
  8453: 'Base',
  42161: 'Arbitrum',
  4663: 'Robinhood Chain',
  792703809: 'Solana',
}
function originName(id) {
  return CHAIN_NAMES[id] ?? `Chain ${id}`
}
