import test from 'node:test'
import assert from 'node:assert/strict'

import { createCache } from '../src/cache.js'

/** Controllable clock, so staleness is tested without real waiting. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

test('serves from cache within the TTL', async () => {
  const c = clock()
  const cache = createCache({ ttlMs: 1000, staleMaxMs: 10_000, now: c.now })

  let calls = 0
  const producer = async () => ({ n: ++calls })

  assert.deepEqual((await cache.get(producer)).value, { n: 1 })
  c.advance(999)
  const second = await cache.get(producer)

  assert.deepEqual(second.value, { n: 1 })
  assert.equal(second.stale, false)
  assert.equal(calls, 1, 'producer should not have run again')
})

test('refetches once the TTL expires', async () => {
  const c = clock()
  const cache = createCache({ ttlMs: 1000, staleMaxMs: 10_000, now: c.now })

  let calls = 0
  const producer = async () => ({ n: ++calls })

  await cache.get(producer)
  c.advance(1001)

  assert.deepEqual((await cache.get(producer)).value, { n: 2 })
})

test('serves the last good value when the producer fails inside the stale window', async () => {
  const c = clock()
  const cache = createCache({ ttlMs: 1000, staleMaxMs: 10_000, now: c.now })

  await cache.get(async () => ({ n: 1 }))
  c.advance(5000)

  const result = await cache.get(async () => {
    throw new Error('upstream down')
  })

  assert.deepEqual(result.value, { n: 1 })
  assert.equal(result.stale, true)
})

test('throws once the value is older than the stale window', async () => {
  const c = clock()
  const cache = createCache({ ttlMs: 1000, staleMaxMs: 10_000, now: c.now })

  await cache.get(async () => ({ n: 1 }))
  c.advance(10_001)

  await assert.rejects(
    () => cache.get(async () => { throw new Error('upstream down') }),
    /upstream down/,
  )
})

test('propagates the failure when there is nothing cached at all', async () => {
  const cache = createCache({ ttlMs: 1000, staleMaxMs: 10_000, now: clock().now })

  await assert.rejects(
    () => cache.get(async () => { throw new Error('cold failure') }),
    /cold failure/,
  )
})

test('coalesces concurrent misses into one producer run', async () => {
  const cache = createCache({ ttlMs: 1000, staleMaxMs: 10_000, now: clock().now })

  let calls = 0
  const producer = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 10))
    return { n: calls }
  }

  const results = await Promise.all(
    Array.from({ length: 20 }, () => cache.get(producer)),
  )

  assert.equal(calls, 1, 'a cold cache under load should make one upstream call')
  for (const r of results) assert.deepEqual(r.value, { n: 1 })
})

test('recovers after a failure rather than latching', async () => {
  const c = clock()
  const cache = createCache({ ttlMs: 1000, staleMaxMs: 10_000, now: c.now })

  await assert.rejects(() =>
    cache.get(async () => { throw new Error('boom') }),
  )

  const result = await cache.get(async () => ({ n: 'recovered' }))
  assert.deepEqual(result.value, { n: 'recovered' })
  assert.equal(result.stale, false)
})
