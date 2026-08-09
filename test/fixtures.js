/**
 * FIXTURES
 * -----------------------------------------------------------------------------
 * Real upstream responses, captured 2026-08-08 from Robinhood Chain.
 *
 * Recorded rather than invented so the decoders are tested against the byte
 * layout a real node actually returns — hand-written hex tends to encode the
 * author's belief about the layout, which is the very thing under test.
 */

/** The PONSY/WETH Uniswap v3 pool. Note token0 is WETH, so PONSY is token1. */
export const POOL_ADDRESS = '0x8ec038a1868ee77c5a079f56495541b3b0ba0548'
export const TOKEN_ADDRESS = '0x0c5b5ef209dd8c9c84b6ef2e19c46a48fca0e33e'
export const WETH_ADDRESS = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'

/**
 * The real $PONSY contract on Robinhood Chain (chain 4663).
 *
 * Deliberately a separate constant from TOKEN_ADDRESS above: that one is a
 * stats-era fixture standing in for one of twelve tokens on this chain that
 * also call themselves PONSY, not the genuine contract. The swap quote
 * service hardcodes the real address as the only valid destination, so its
 * tests need the real one. Do not "simplify" by consolidating these two.
 */
export const PONSY_ADDRESS = '0x2E84F2E0b88BD3FFB5D6738aE0e3C7c00137083E'

/** slot0() — sqrtPriceX96 in word 0, tick 200248 in word 1. */
export const SLOT0_RETURNDATA =
  '0x' +
  '00000000000000000000000000000000000057125cd85ddd08d8ad502b600fc2' + // sqrtPriceX96
  '0000000000000000000000000000000000000000000000000000000000030e38' + // tick 200248
  '0000000000000000000000000000000000000000000000000000000000000000' + // observationIndex
  '0000000000000000000000000000000000000000000000000000000000000001' + // cardinality
  '0000000000000000000000000000000000000000000000000000000000000001' + // cardinalityNext
  '0000000000000000000000000000000000000000000000000000000000000066' + // feeProtocol
  '0000000000000000000000000000000000000000000000000000000000000001' // unlocked

export const SQRT_PRICE_X96 = 1766024476635090136263392994791362n

/** token0() -> WETH */
export const TOKEN0_RETURNDATA =
  '0x0000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad73'

/** token1() -> PONSY */
export const TOKEN1_RETURNDATA =
  '0x0000000000000000000000000c5b5ef209dd8c9c84b6ef2e19c46a48fca0e33e'

/** totalSupply() -> 1e27 raw = 1,000,000,000 whole tokens at 18 decimals */
export const TOTAL_SUPPLY_RETURNDATA =
  '0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000'

/** decimals() -> 18 */
export const DECIMALS_18_RETURNDATA =
  '0x0000000000000000000000000000000000000000000000000000000000000012'

/** decimals() -> 6 */
export const DECIMALS_6_RETURNDATA =
  '0x0000000000000000000000000000000000000000000000000000000000000006'

/** GET /api/v2/tokens/{addr}/counters */
export const BLOCKSCOUT_COUNTERS = {
  token_holders_count: '126',
  transfers_count: '7773',
}

/** GET /api/v2/stats — trimmed to the fields we read. */
export const BLOCKSCOUT_STATS = {
  coin_price: '1919.5',
  total_blocks: '31018806',
  average_block_time: 101.0,
}

/** GET /latest/dex/tokens/{addr} */
export const DEXSCREENER_TOKENS = {
  schemaVersion: '1.0.0',
  pairs: [
    {
      chainId: 'robinhood',
      dexId: 'uniswap',
      pairAddress: '0x8eC038A1868ee77C5a079f56495541b3b0bA0548',
      baseToken: { address: TOKEN_ADDRESS, name: 'ponsy', symbol: 'PONSY' },
      quoteToken: { address: WETH_ADDRESS, name: 'WETH', symbol: 'WETH' },
      priceNative: '0.000000002012',
      priceUsd: '0.000003858',
      liquidity: { usd: 3753.81, base: 825729250, quote: 0.2961 },
      fdv: 3858,
      marketCap: 3858,
    },
  ],
}

/**
 * A fake `fetch` driven by a routing table.
 *
 * Each entry is [substring-of-url, handler]. The handler returns either a plain
 * object (becomes a 200 JSON response) or throws (becomes a network failure).
 */
export function stubFetch(routes) {
  const calls = []

  async function fetchImpl(url, init = {}) {
    const href = String(url)
    calls.push({ url: href, init })

    for (const [match, handler] of routes) {
      if (!href.includes(match)) continue

      const body = init.body ? JSON.parse(init.body) : null
      const result = await handler(body, href)

      if (result instanceof Error) throw result
      if (result?.__status && result.__status >= 400) {
        const { __status, ...rest } = result
        return { ok: false, status: __status, json: async () => rest }
      }
      return { ok: true, status: 200, json: async () => result }
    }
    throw new Error(`stubFetch: no route matched ${href}`)
  }

  fetchImpl.calls = calls
  return fetchImpl
}

/** Builds a JSON-RPC batch reply for the given per-call returndata. */
export function rpcBatchReply(requests, returndataByIndex) {
  return requests.map((req, i) => {
    const data = returndataByIndex[i]
    if (data instanceof Error) {
      return { jsonrpc: '2.0', id: req.id, error: { message: data.message } }
    }
    return { jsonrpc: '2.0', id: req.id, result: data }
  })
}

/**
 * POST /quote — 0.02 ETH on Base -> PONSY on Robinhood Chain.
 * Captured 2026-08-09. Trimmed to the fields the service reads.
 */
export const RELAY_QUOTE = {
  steps: [
    {
      id: 'deposit',
      kind: 'transaction',
      requestId: '0x2451e373b348261c1e1d6b6df9f1edc9da51f9f9ca5047b34710b8c5b4',
      items: [
        {
          status: 'incomplete',
          data: {
            from: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
            to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
            data: '0x49290c1c0000000000000000000000002dfec17b1d8dce43cb5b1111352fd58be01d389e',
            value: '20000000000000000',
            chainId: 8453,
            gas: 32713,
          },
          check: {
            endpoint: '/intents/status?requestId=0x2451e373b348261c1e1d6b6df9f1edc9',
            method: 'GET',
          },
        },
      ],
    },
  ],
  fees: {
    gas: { amountUsd: '0.000276' },
    relayer: { amountUsd: '0.730005' },
    app: { amountUsd: '0' },
  },
  details: {
    operation: 'swap',
    currencyIn: {
      currency: { chainId: 8453, symbol: 'ETH', decimals: 18 },
      amount: '20000000000000000',
      amountFormatted: '0.02',
      amountUsd: '38.427738',
    },
    currencyOut: {
      currency: {
        chainId: 4663,
        address: '0x2e84f2e0b88bd3ffb5d6738ae0e3c7c00137083e',
        symbol: 'PONSY',
        decimals: 18,
      },
      amount: '287080575613057682974296',
      amountFormatted: '287080.575613057682974296',
      amountUsd: '36.462148',
      minimumAmount: '281338964100796529311189',
    },
    totalImpact: { usd: '-1.965590', percent: '-5.12' },
    swapImpact: { usd: '-1.235585', percent: '-3.22' },
    timeEstimate: 3,
  },
}

/** GET /intents/status — a completed intent. */
export const RELAY_STATUS_SUCCESS = {
  status: 'success',
  txHashes: ['0xaaa1'],
  destinationChainId: 4663,
}

/** The Solana payer and the EVM receiver — different addresses by necessity. */
export const SOL_PAYER = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'
export const EVM_RECIPIENT = '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E'

/** A real blockhash, for deterministic serialisation tests. */
export const SOL_BLOCKHASH = '5VERd3ffZBLbSUqXtkGxRWjGqzrGZP5nBs7SMDvvBGvS'

/**
 * POST /quote — 0.25 SOL -> PONSY. Captured 2026-08-09.
 *
 * Note `data` is hex with no 0x prefix (48 bytes), and `80b2e60e` at byte
 * offset 8 is 250000000 lamports little-endian. There are no EVM fields at all.
 */
export const RELAY_SOLANA_QUOTE = {
  steps: [
    {
      id: 'deposit',
      kind: 'transaction',
      requestId: '0xc43948b87065dbbbeb1f2a9c4d6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9012',
      items: [
        {
          status: 'incomplete',
          data: {
            instructions: [
              {
                programId: '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2',
                keys: [
                  { pubkey: 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc', isSigner: false, isWritable: false },
                  { pubkey: SOL_PAYER, isSigner: true, isWritable: true },
                  { pubkey: SOL_PAYER, isSigner: false, isWritable: false },
                  { pubkey: '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ', isSigner: false, isWritable: true },
                  { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
                ],
                data: '0d9e0ddf5fd51c0680b2e60e000000005820f2655113737636cb60db5eef7d385b48b1e17a629db5f8cbdf203fde6c2d',
              },
            ],
            addressLookupTableAddresses: ['Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP'],
          },
          check: { endpoint: '/intents/status?requestId=0xc43948b8', method: 'GET' },
        },
      ],
    },
  ],
  fees: { gas: { amountUsd: '0.000005' }, relayer: { amountUsd: '0.31' }, app: { amountUsd: '0' } },
  details: {
    operation: 'swap',
    currencyIn: {
      currency: { chainId: 792703809, symbol: 'SOL', decimals: 9 },
      amount: '250000000', amountFormatted: '0.25', amountUsd: '19.094335',
    },
    currencyOut: {
      currency: { chainId: 4663, address: '0x2e84f2e0b88bd3ffb5d6738ae0e3c7c00137083e', symbol: 'PONSY', decimals: 18 },
      amount: '86623618000000000000000', amountFormatted: '86623.618', amountUsd: '19.125422',
      minimumAmount: '84891145640000000000000',
    },
    totalImpact: { usd: '0.031087', percent: '0.16' },
    swapImpact: { usd: '0.02', percent: '0.10' },
    timeEstimate: 3,
  },
}

/** getLatestBlockhash JSON-RPC reply. */
export const SOL_BLOCKHASH_REPLY = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    context: { slot: 300000000 },
    value: { blockhash: SOL_BLOCKHASH, lastValidBlockHeight: 280000000 },
  },
}

/**
 * POST /quote — 40 USDC on Base -> PONSY. Captured 2026-08-09.
 *
 * Note both steps are `kind: "transaction"`: the approval is an on-chain
 * transaction, not a signature, and it approves the exact trade amount
 * (40000000) rather than uint256 max.
 */
export const RELAY_APPROVE_QUOTE = {
  steps: [
    {
      id: 'approve',
      kind: 'transaction',
      requestId: '0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899',
      items: [{
        status: 'incomplete',
        data: {
          from: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
          to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          data: '0x095ea7b30000000000000000000000004cd00e387622c35bddb9b4c962c136462338bc310000000000000000000000000000000000000000000000000000000002625a00',
          value: '0', chainId: 8453, gas: 60000,
        },
        check: { endpoint: '/intents/status?requestId=0xaa11bb22', method: 'GET' },
      }],
    },
    {
      id: 'deposit',
      kind: 'transaction',
      requestId: '0xaa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899',
      items: [{
        status: 'incomplete',
        data: {
          from: '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
          to: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
          data: '0xe80179520000000000000000000000002dfec17b1d8dce43cb5b1111352fd58be01d389e',
          value: '0', chainId: 8453, gas: 180000,
        },
        check: { endpoint: '/intents/status?requestId=0xaa11bb22', method: 'GET' },
      }],
    },
  ],
  fees: { gas: { amountUsd: '0.02' }, relayer: { amountUsd: '0.35' }, app: { amountUsd: '0' } },
  details: {
    operation: 'swap',
    currencyIn: {
      currency: { chainId: 8453, symbol: 'USDC', decimals: 6 },
      amount: '40000000', amountFormatted: '40', amountUsd: '39.99',
    },
    currencyOut: {
      currency: { chainId: 4663, address: '0x2e84f2e0b88bd3ffb5d6738ae0e3c7c00137083e', symbol: 'PONSY', decimals: 18 },
      amount: '300000000000000000000000', amountFormatted: '300000', amountUsd: '34.61',
      minimumAmount: '294000000000000000000000',
    },
    totalImpact: { usd: '-5.38', percent: '-13.45' },
    swapImpact: { usd: '-5.00', percent: '-12.50' },
    timeEstimate: 4,
  },
}
