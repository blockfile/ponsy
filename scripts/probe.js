#!/usr/bin/env node
/**
 * PROBE
 * -----------------------------------------------------------------------------
 * Checks each upstream independently and prints what it returned.
 *
 * Exists because /stats deliberately degrades quietly: when a source is down
 * you get a null field and a warning, not a stack trace. That is right for the
 * website and useless for diagnosis, so this walks the same path with the
 * failures made loud.
 *
 *   npm run probe
 */

import { loadEnvFile, buildConfig } from '../src/config.js'
import { createRpcClient } from '../src/chain/rpc.js'
import { SELECTORS, decodeUint, decodeUint8, decodeAddress } from '../src/chain/abi.js'
import { toWholeTokens } from '../src/chain/uniswapV3.js'
import * as blockscout from '../src/sources/blockscout.js'
import * as dexscreener from '../src/sources/dexscreener.js'

loadEnvFile()
const config = buildConfig()

const ok = (label, value) => console.log(`  ok    ${label.padEnd(22)} ${value}`)
const bad = (label, err) => console.log(`  FAIL  ${label.padEnd(22)} ${err.message}`)

async function step(label, fn) {
  try {
    ok(label, await fn())
    return true
  } catch (err) {
    bad(label, err)
    return false
  }
}

console.log(`\nRPC       ${config.rpcUrl}`)
console.log(`Explorer  ${config.blockscoutUrl}`)
console.log(`Token     ${config.tokenAddress ?? '(unset)'}`)
console.log(`Pool      ${config.poolAddress ?? '(unset)'}\n`)

const rpc = createRpcClient({ url: config.rpcUrl, timeoutMs: config.upstreamTimeoutMs })
const opts = { timeoutMs: config.upstreamTimeoutMs }

await step('chain id', async () => {
  const res = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(config.upstreamTimeoutMs),
  })
  const { result } = await res.json()
  return `${parseInt(result, 16)} (${result})`
})

await step('ETH/USD', async () =>
  `$${await blockscout.fetchNativeUsd(config.blockscoutUrl, opts)}`,
)

if (!config.tokenAddress) {
  console.log('\n  TOKEN_ADDRESS is unset — /stats will return nulls.')
  console.log('  Set it in .env to check the token-specific sources.\n')
  process.exit(0)
}

await step('holders', async () =>
  await blockscout.fetchHolders(config.blockscoutUrl, config.tokenAddress, opts),
)

let decimals = 18
await step('supply', async () => {
  const [supplyData, decimalsData] = await rpc.ethCallBatch([
    { to: config.tokenAddress, data: SELECTORS.totalSupply },
    { to: config.tokenAddress, data: SELECTORS.decimals },
  ])
  decimals = decodeUint8(decimalsData)
  return `${toWholeTokens(decodeUint(supplyData), decimals).toLocaleString('en-US')} (${decimals} decimals)`
})

if (config.poolAddress) {
  await step('pool tokens', async () => {
    const [t0, t1] = await rpc.ethCallBatch([
      { to: config.poolAddress, data: SELECTORS.token0 },
      { to: config.poolAddress, data: SELECTORS.token1 },
    ])
    const token0 = decodeAddress(t0)
    const token1 = decodeAddress(t1)
    const which = token0 === config.tokenAddress ? 'token0' : 'token1'
    const counter = token0 === config.tokenAddress ? token1 : token0
    const isWeth = counter === config.wethAddress ? 'WETH ok' : `NOT WETH (${counter})`
    return `PONSY is ${which}, counter ${isWeth}`
  })
} else {
  console.log('  skip  pool                   POOL_ADDRESS unset')
}

await step('dexscreener', async () => {
  const q = await dexscreener.fetchPrice(config.dexscreenerUrl, config.tokenAddress, opts)
  return `$${q.priceUsd} (liquidity $${q.liquidityUsd})`
})

console.log('')
