import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SELECTORS,
  word,
  decodeUint,
  decodeUint8,
  decodeAddress,
  encodeBalanceOf,
} from '../src/chain/abi.js'
import {
  SLOT0_RETURNDATA,
  SQRT_PRICE_X96,
  TOKEN0_RETURNDATA,
  TOKEN1_RETURNDATA,
  TOTAL_SUPPLY_RETURNDATA,
  DECIMALS_18_RETURNDATA,
  TOKEN_ADDRESS,
  WETH_ADDRESS,
} from './fixtures.js'

test('decodes sqrtPriceX96 from the first word of slot0', () => {
  assert.equal(decodeUint(SLOT0_RETURNDATA, 0), SQRT_PRICE_X96)
})

test('decodes the tick from the second word of slot0', () => {
  assert.equal(decodeUint(SLOT0_RETURNDATA, 1), 200248n)
})

test('decodes totalSupply as 1e27', () => {
  assert.equal(decodeUint(TOTAL_SUPPLY_RETURNDATA), 10n ** 27n)
})

test('decodes decimals as 18', () => {
  assert.equal(decodeUint8(DECIMALS_18_RETURNDATA), 18)
})

test('decodes token0 as WETH and token1 as PONSY, lowercased', () => {
  assert.equal(decodeAddress(TOKEN0_RETURNDATA), WETH_ADDRESS)
  assert.equal(decodeAddress(TOKEN1_RETURNDATA), TOKEN_ADDRESS)
})

test('throws on truncated returndata rather than returning a partial word', () => {
  /* '0x' is what a call to a non-contract address returns. Reading it as zero
     would silently become a $0 market cap. */
  assert.throws(() => decodeUint('0x'), /expected at least/)
})

test('throws when reading past the end of returndata', () => {
  assert.throws(() => word(DECIMALS_18_RETURNDATA, 1), /expected at least/)
})

test('rejects a uint8 that does not fit in a byte', () => {
  const tooBig = '0x' + 'ff'.repeat(32)
  assert.throws(() => decodeUint8(tooBig), /expected a uint8/)
})

test('accepts returndata without the 0x prefix', () => {
  assert.equal(decodeUint8(DECIMALS_18_RETURNDATA.slice(2)), 18)
})

test('encodeBalanceOf produces exactly 4 + 32 bytes with the address right-aligned', () => {
  const address = '0xAbCdEf0123456789aBcDef0123456789ABCDEF01'
  const calldata = encodeBalanceOf(address)

  assert.equal(
    calldata.slice(0, 10),
    SELECTORS.balanceOf,
    'the first 4 bytes are the balanceOf selector',
  )
  assert.equal(
    calldata.length,
    2 + 8 + 64,
    '0x + 4-byte selector + one 32-byte word, no more and no less',
  )
  assert.equal(
    calldata.slice(10, 34),
    '0'.repeat(24),
    'the word\'s upper 12 bytes are zero padding',
  )
  assert.equal(
    calldata.slice(34),
    address.slice(2).toLowerCase(),
    'the address occupies the low 20 bytes of the word, right-aligned',
  )
})

test('encodeBalanceOf lowercases the address', () => {
  /* The padding is positional, not checksum-sensitive — a mixed-case tail
     would still decode identically on-chain, but comparing calldata strings
     in tests (and logs) is easier when case is normalised. */
  const upper = '0x' + 'AB'.repeat(20)
  const lower = '0x' + 'ab'.repeat(20)
  assert.equal(encodeBalanceOf(upper), encodeBalanceOf(lower))
})
