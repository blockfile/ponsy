# Burn Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Report how much $PONSY has been burned on `/stats`, and show it beside MARKET CAP and HOLDERS.

**Architecture:** Two `balanceOf` reads join the existing batched `eth_call` in `readChain`, so the figure costs no extra round trip. The response gains `burned` and `burnedPct`, both degrading to `null` like `marketCap` already does. The frontend adds a third stat with a sub-line.

**Tech Stack:** Node 20 + Express + node:test (backend); React 18 + Vite + Vitest (frontend).

## Global Constraints

- **No new round trip on `/stats`.** The burn reads go in the existing `ethCallBatch` array. A sequential call caused this project's 504 outage and nearly repeated it on `/quote`. An implementation that returns the right number by adding a round trip is wrong.
- **A burn failure must never fail `/stats`.** Degrade to `null` plus a warning, exactly as `marketCap` does.
- **Purely additive.** No existing response field changes meaning. `marketCap` stays `priceUsd × totalSupply` — deliberately, see the spec.
- **Burn address:** `0x000000000000000000000000000000000000dEaD`, plus `0x0000000000000000000000000000000000000000`, summed.
- **No new dependencies**, either repo.

---

### Task 1: Burn on `/stats` (backend)

**Repo:** `d:\projects\ponsy`, branch `swap-quote-api` — the branch production runs. 187 tests passing.

**Files:**
- Modify: `src/chain/abi.js` — add the `balanceOf` selector and an encoder
- Modify: `src/stats.js` — `readChain` reads the two balances; `collect` exposes `burned`/`burnedPct`
- Test: `test/stats.test.js`, `test/abi.test.js` (whichever exist; follow the file layout already there)

**Interfaces:**
- Produces: `/stats` response fields `burned: number|null` (whole tokens) and `burnedPct: number|null` (percent, e.g. `3.0437`).

- [ ] **Step 1: Add the selector and encoder**

`balanceOf(address)` is `0x70a08231` followed by the address left-padded to 32 bytes.

```js
/** ERC-20 balanceOf(address) -> uint256 */
balanceOf: '0x70a08231',
```

with a helper beside the existing decoders:

```js
/**
 * Encodes balanceOf(address) calldata: the selector followed by the address
 * left-padded to a full 32-byte word. Lowercased because the padding is
 * positional, not checksum-sensitive, and a mixed-case tail reads like it
 * might matter.
 */
export function encodeBalanceOf(address) {
  return SELECTORS.balanceOf + '000000000000000000000000' + address.slice(2).toLowerCase()
}
```

- [ ] **Step 2: Write the failing tests**

Cover, at minimum: the encoder produces exactly 4 + 32 bytes with the address right-aligned; `readChain` issues the burn reads **in the same batch** as `totalSupply` (assert on the calls array, not on timing); `burned` applies decimals; `burnedPct` divides by total supply; a failed burn read leaves `marketCap` and `holders` intact and adds a warning.

The batching assertion is the important one — it is the constraint that exists because of the outage. Assert the burn calls appear in the single `ethCallBatch` argument, so a future refactor to a second call fails the test.

- [ ] **Step 3: Run them and watch them fail**

Run: `npm test`

- [ ] **Step 4: Implement**

Push the two calls into the existing `calls` array **before** `ethCallBatch` is invoked, decode by index, and derive:

```
burned    = toWholeTokens(dead + zero, decimals)
burnedPct = supply > 0 ? (burned / supply) * 100 : null
```

Guard the division: a zero supply must not produce `Infinity` or `NaN` in a JSON response.

- [ ] **Step 5: Run the suite and probe live**

Run: `npm test`, then start the server and `curl` `/stats`. The live figure must match the on-chain balance — roughly 30.4M and 3.04% as of 2026-08-10, though it moves if anyone burns more.

- [ ] **Step 6: Commit**

```bash
git add src/chain/abi.js src/stats.js test/
git commit -m "feat: report burned supply on /stats"
```

---

### Task 2: Burn in the stats row (frontend)

**Repo:** `D:\projects\Meme4`. **Cut a new branch from `origin/swap`** — NOT from local `swap`, which carries 31 commits of unshipped swap work and a different `SWAP_ENABLED`:

```bash
git fetch origin && git checkout -b burn-stat origin/swap
```

**Files:**
- Modify: `src/lib/stats.js` — `normalise` gains the burn row; add an abbreviating formatter
- Modify: `src/components/StatsRow.jsx` — render `sub`; skeleton 2 → 3
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`, `src/i18n/zh.json`
- Test: `src/lib/stats.test.js` (create if absent)

**Interfaces:**
- Consumes: `/stats` fields `burned`, `burnedPct` from Task 1.

- [ ] **Step 1: Write the failing tests**

`normalise` returns three rows; the burn row has `key: 'burned'` and an abbreviated value; a `null` burn yields a dash rather than `NaN` or a crash; the existing two rows are unchanged and carry no `sub`.

- [ ] **Step 2: Add the formatter and the row**

```js
/** 30436764 -> "30.4M" */
export function formatCompact(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const v = Number(n)
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return String(Math.round(v))
}
```

The row, appended after `holders`:

```js
{
  key: 'burned',
  label: 'BURNED',
  value: formatCompact(raw?.burned),
  sub: raw?.burnedPct != null ? `${Number(raw.burnedPct).toFixed(2)}% OF SUPPLY` : null,
}
```

`key: 'burned'` is what the i18n lookup keys on — it must be stable.

- [ ] **Step 3: Render `sub`, and fix the skeleton**

In `StatsRow.jsx`, under the existing value paragraph:

```jsx
{s.sub && (
  <p className="mt-1 font-code text-[9px] font-bold tracking-[.14em] text-ink/60 sm:text-[10px]">
    {s.sub}
  </p>
)}
```

Change the skeleton's `{[0, 1].map(...)}` to `{[0, 1, 2].map(...)}` and its `repeat(2, ...)` to `repeat(3, ...)`, so the panel geometry matches the loaded state and the section does not jump.

- [ ] **Step 4: Translations — all three locales**

`package.json` runs `check:i18n` before `vite build`, so a missing key **fails the build**. Add `stats.burned` to `en.json`, `ru.json` and `zh.json`. Read the existing entries first and match their tone and casing.

The "% OF SUPPLY" suffix is user-visible text too. Either add it as its own key and compose it in the component, or accept English there and say so in the report — do not leave it silently untranslated while claiming the feature is localised.

- [ ] **Step 5: Verify**

Run: `npm test && npm run build`. The build must pass, which proves `check:i18n` is satisfied. Then run the dev server against a local backend carrying Task 1 and confirm three panels render, the sub-line reads `3.04% OF SUPPLY`, and the loading state shows three skeletons.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stats.js src/components/StatsRow.jsx src/i18n src/lib/stats.test.js
git commit -m "feat: show burned supply in the stats row"
```

Do not push. Do not merge anything into this branch.
