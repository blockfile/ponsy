import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { createCache } from '../src/cache.js'
import { TOKEN_ADDRESS, POOL_ADDRESS, WETH_ADDRESS } from './fixtures.js'

const silent = { error: () => {}, log: () => {} }

/**
 * Boots the app on an ephemeral port and returns a bound fetch helper.
 *
 * Cleanup (`server.close()`) always runs via `finally`, even if `run` throws
 * or an assertion inside it fails — a leaked listener from a failed test is
 * what turns a fast, clear failure into a hung `node --test` process.
 *
 * @param {object} opts
 * @param {Function} opts.collect          stats collector, passed to statsService
 * @param {object} opts.config
 * @param {object} [opts.quoteService]     passed straight through to createServer
 * @param {number} [opts.cacheTtlMs]       overrides config.cacheTtlMs for the stats cache
 * @param {number} [opts.staleMaxMs]       overrides config.staleMaxMs for the stats cache
 */
async function withServer({ collect, config, quoteService, cacheTtlMs, staleMaxMs }, run) {
  const app = createServer({
    config,
    statsService: { collect },
    quoteService,
    cache: createCache({
      ttlMs: cacheTtlMs ?? config.cacheTtlMs,
      staleMaxMs: staleMaxMs ?? config.staleMaxMs,
    }),
    logger: silent,
  })

  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    return await run((path, init) => fetch(base + path, init))
  } finally {
    await new Promise((r) => server.close(r))
  }
}

const CONFIG = buildConfig({
  TOKEN_ADDRESS,
  POOL_ADDRESS,
  WETH_ADDRESS,
  CORS_ORIGIN: 'http://localhost:5173',
})

const PAYLOAD = {
  marketCap: 3863.26,
  holders: 126,
  priceUsd: 0.000003863,
  totalSupply: 1_000_000_000,
  placeholder: false,
  source: { price: 'pool', holders: 'blockscout' },
  warnings: [],
}

test('GET /stats returns the payload with stale and updatedAt', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/stats')
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.marketCap, 3863.26)
    assert.equal(body.holders, 126)
    assert.equal(body.stale, false)
    assert.ok(!Number.isNaN(Date.parse(body.updatedAt)))
  })
})

test('GET /stats sets Cache-Control matching the TTL', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/stats')
    assert.match(res.headers.get('cache-control'), /max-age=30/)
  })
})

test('a second request within the TTL is served from cache, without calling statsService again', async () => {
  /* The point of the background refresher (refresher.js) is that GET /stats
     answers from memory. This pins the request-side half of that contract at
     the HTTP layer: whatever populated the cache — the refresher's timer or,
     as here, a first request — a second request inside the TTL must not
     re-invoke the stats service ("upstreams" from the route's point of
     view). CONFIG's TTL is the 30s default, so it is still fresh here. */
  let calls = 0
  const collect = async () => {
    calls++
    return PAYLOAD
  }

  await withServer({ config: CONFIG, collect }, async (get) => {
    const first = await get('/stats')
    assert.equal(first.status, 200)

    const second = await get('/stats')
    assert.equal(second.status, 200)
    assert.deepEqual(await second.json().then((b) => b.marketCap), PAYLOAD.marketCap)

    assert.equal(calls, 1, 'the second request must not re-invoke the stats service')
  })
})

test('allows a configured origin and sets Vary', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/stats', { headers: { Origin: 'http://localhost:5173' } })

    assert.equal(
      res.headers.get('access-control-allow-origin'),
      'http://localhost:5173',
    )
    assert.match(res.headers.get('vary') ?? '', /Origin/)
  })
})

test('does not allow an unlisted origin', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/stats', { headers: { Origin: 'https://evil.example' } })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })
})

test('answers a CORS preflight with 204', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/stats', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(res.status, 204)
  })
})

test('a wildcard allowlist admits any origin', async () => {
  const config = buildConfig({ TOKEN_ADDRESS, CORS_ORIGIN: '*' })
  await withServer({ config, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/stats', { headers: { Origin: 'https://anywhere.example' } })
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })
})

test('returns 503 when collection fails with nothing cached', async () => {
  await withServer(
    {
      config: CONFIG,
      collect: async () => {
        throw new Error('everything is down')
      },
    },
    async (get) => {
      const res = await get('/stats')
      const body = await res.json()

      assert.equal(res.status, 503)
      assert.equal(body.error, 'stats unavailable')
    },
  )
})

test('GET /stats degrades within the wait budget instead of hanging on a cold cache', async () => {
  /* Models the production incident: nothing cached yet (or the refresher's
     current cycle is running long) and collection is slow. Before this fix,
     the request just waited on collect() — up to 16s, past nginx's 15s
     proxy_read_timeout, a 504. Now the wait is bounded by STATS_WAIT_MS: the
     request must come back well inside that budget, degrading to a 503
     rather than hanging, while the slow collect() is left to finish on its
     own and land in the cache for the next request. */
  const config = buildConfig({ TOKEN_ADDRESS, STATS_WAIT_MS: 50 })

  const collect = () =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(PAYLOAD), 2000)
      t.unref?.()
    })

  await withServer({ config, collect }, async (get) => {
    const startedAt = Date.now()
    const res = await get('/stats')
    const elapsedMs = Date.now() - startedAt

    assert.equal(res.status, 503)
    const body = await res.json()
    assert.match(body.error, /warming/)
    assert.ok(
      elapsedMs < 1000,
      `expected a prompt response well inside the 2000ms collection delay, took ${elapsedMs}ms`,
    )
  })
})

test('serves the last good payload with stale:true after a failure', async () => {
  /* TTL of 0 forces a refetch on the second request, so the stale path is
     exercised without waiting on a real clock. */
  const config = buildConfig({ TOKEN_ADDRESS, CACHE_TTL_MS: 0, STALE_MAX_MS: 600000 })

  let healthy = true
  const collect = async () => {
    if (!healthy) throw new Error('upstreams down')
    return PAYLOAD
  }

  await withServer({ config, collect }, async (get) => {
    assert.equal((await get('/stats')).status, 200)

    healthy = false
    const res = await get('/stats')
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.stale, true)
    assert.equal(body.marketCap, 3863.26)
  })
})

test('GET /health reports config without touching upstreams', async () => {
  await withServer(
    {
      config: CONFIG,
      collect: async () => {
        throw new Error('should not be called')
      },
    },
    async (get) => {
      const res = await get('/health')
      const body = await res.json()

      assert.equal(res.status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.tokenConfigured, true)
      assert.equal(body.poolConfigured, true)
    },
  )
})

test('unknown routes 404 as JSON', async () => {
  await withServer({ config: CONFIG, collect: async () => PAYLOAD }, async (get) => {
    const res = await get('/nope')
    assert.equal(res.status, 404)
    assert.equal((await res.json()).error, 'not found')
  })
})

const QUOTE = {
  amountIn: 0.02, amountOut: 287080.57, amountInUsd: 38.42, amountOutUsd: 36.46,
  rate: 14354028.5, priceImpact: -0.0512, minReceived: 281338.96, feeUsd: 0.73,
  timeEstimate: 3, route: 'Base to Robinhood Chain, one transaction',
  tx: { to: '0x4cd0', data: '0x49290c1c', value: '20000000000000000', chainId: 8453 },
  requestId: '0xreq', mock: false,
}

function quoteStub(overrides = {}) {
  return {
    getQuote: async () => QUOTE,
    getStatus: async () => ({ status: 'success' }),
    ...overrides,
  }
}

test('GET /quote returns the normalised quote', async () => {
  await withServer(
    {
      config: CONFIG,
      collect: async () => PAYLOAD,
      quoteService: quoteStub(),
      cacheTtlMs: 0,
      staleMaxMs: 0,
    },
    async (get) => {
      const res = await get(
        '/quote?amount=0.02&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
      )
      const body = await res.json()

      assert.equal(res.status, 200)
      assert.equal(body.amountOut, 287080.57)
      assert.equal(body.tx.chainId, 8453)
      assert.equal(res.headers.get('cache-control'), 'no-store')
    },
  )
})

test('GET /quote returns 400 with the reason when the service rejects', async () => {
  await withServer(
    {
      config: CONFIG,
      collect: async () => PAYLOAD,
      quoteService: quoteStub({
        getQuote: async () => { throw new Error('minimum trade is $25') },
      }),
      cacheTtlMs: 0,
      staleMaxMs: 0,
    },
    async (get) => {
      const res = await get(
        '/quote?amount=0.001&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
      )
      const body = await res.json()

      assert.equal(res.status, 400)
      assert.match(body.error, /minimum trade is \$25/)
      assert.equal(res.headers.get('cache-control'), 'no-store')
    },
  )
})

test('GET /quote forwards recipient from the query string verbatim', async () => {
  // A Solana origin cannot derive its destination from the payer, so this
  // query parameter has to survive the HTTP layer untouched — pin the value
  // the service actually receives, not just that the route returns 200.
  let received
  await withServer(
    {
      config: CONFIG,
      collect: async () => PAYLOAD,
      quoteService: quoteStub({
        getQuote: async (args) => {
          received = args
          return QUOTE
        },
      }),
      cacheTtlMs: 0,
      staleMaxMs: 0,
    },
    async (get) => {
      const res = await get(
        '/quote?amount=0.25&chainId=792703809&user=GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ&recipient=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
      )
      assert.equal(res.status, 200)
      assert.equal(received.recipient, '0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E')
    },
  )
})

test('GET /quote forwards token from the query string verbatim', async () => {
  // Mirrors the recipient test above — the same class of bug (58f48cc:
  // recipient dropped at the HTTP layer while every unit test calling
  // getQuote() directly stayed green, because none of them go through
  // server.js's route). Deleting or renaming server.js's `token:
  // req.query.token` would make ?token=usdc unreachable, silently falling
  // back to a native quote at a completely different amount, and no test
  // that calls getQuote() directly can see that regression.
  let received
  await withServer(
    {
      config: CONFIG,
      collect: async () => PAYLOAD,
      quoteService: quoteStub({
        getQuote: async (args) => {
          received = args
          return QUOTE
        },
      }),
      cacheTtlMs: 0,
      staleMaxMs: 0,
    },
    async (get) => {
      const res = await get(
        '/quote?amount=40&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E&token=usdc',
      )
      assert.equal(res.status, 200)
      assert.equal(received.token, 'usdc')
    },
  )
})

test('GET /quote forwards a missing recipient as undefined, not "" or null', async () => {
  // getQuote's own recipient-defaulting (EVM: falls back to user) and
  // Solana validation (ADDRESS_RE.test(String(recipient ?? ''))) both depend
  // on genuinely receiving undefined here. Express never produces '' for an
  // absent query param, but this pins the value the route actually passes
  // through rather than assuming Express's behaviour.
  let received
  await withServer(
    {
      config: CONFIG,
      collect: async () => PAYLOAD,
      quoteService: quoteStub({
        getQuote: async (args) => {
          received = args
          return QUOTE
        },
      }),
      cacheTtlMs: 0,
      staleMaxMs: 0,
    },
    async (get) => {
      const res = await get(
        '/quote?amount=0.02&chainId=8453&user=0x2DFeC17b1d8DcE43cB5B1111352Fd58BE01d389E',
      )
      assert.equal(res.status, 200)
      assert.equal(received.recipient, undefined)
    },
  )
})

test('GET /quote returns 400 when the service rejects a Solana quote for a missing recipient', async () => {
  // Same passthrough mechanism as the existing 400 test above, exercised
  // with the specific error a Solana origin produces when recipient is
  // absent — confirms the new failure mode reaches the caller exactly like
  // every other quote rejection, not as a special case.
  await withServer(
    {
      config: CONFIG,
      collect: async () => PAYLOAD,
      quoteService: quoteStub({
        getQuote: async () => {
          throw new Error('recipient must be a 0x address when paying from Solana')
        },
      }),
      cacheTtlMs: 0,
      staleMaxMs: 0,
    },
    async (get) => {
      const res = await get(
        '/quote?amount=0.25&chainId=792703809&user=GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ',
      )
      const body = await res.json()

      assert.equal(res.status, 400)
      assert.match(body.error, /recipient must be a 0x address/)
      assert.equal(res.headers.get('cache-control'), 'no-store')
    },
  )
})

test('GET /quote/status proxies the intent status', async () => {
  /* The route must forward req.query.requestId to the service untouched —
     a regression that dropped it (eg. forwarding undefined) would otherwise
     still read 'success' from the stub's fixed return value and ship green. */
  let receivedRequestId
  await withServer(
    {
      config: CONFIG,
      collect: async () => PAYLOAD,
      quoteService: quoteStub({
        getStatus: async (requestId) => {
          receivedRequestId = requestId
          return { status: 'success' }
        },
      }),
      cacheTtlMs: 0,
      staleMaxMs: 0,
    },
    async (get) => {
      const res = await get('/quote/status?requestId=0xreq')
      const body = await res.json()

      assert.equal(body.status, 'success')
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.equal(receivedRequestId, '0xreq')
    },
  )
})

test('GET /quote/status returns 400 with the reason when the service rejects', async () => {
  await withServer(
    {
      config: CONFIG,
      collect: async () => PAYLOAD,
      quoteService: quoteStub({
        getStatus: async () => { throw new Error('requestId is required') },
      }),
      cacheTtlMs: 0,
      staleMaxMs: 0,
    },
    async (get) => {
      const res = await get('/quote/status')
      const body = await res.json()

      assert.equal(res.status, 400)
      assert.equal(body.error, 'requestId is required')
      assert.equal(res.headers.get('cache-control'), 'no-store')
    },
  )
})
