import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/config.js'
import { createServer } from '../src/server.js'
import { createCache } from '../src/cache.js'
import { TOKEN_ADDRESS, POOL_ADDRESS, WETH_ADDRESS } from './fixtures.js'

const silent = { error: () => {}, log: () => {} }

/** Boots the app on an ephemeral port and returns a bound fetch helper. */
async function withServer({ collect, config }, run) {
  const app = createServer({
    config,
    statsService: { collect },
    cache: createCache({ ttlMs: config.cacheTtlMs, staleMaxMs: config.staleMaxMs }),
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
