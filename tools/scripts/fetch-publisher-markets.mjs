#!/usr/bin/env node
/**
 * fetch-publisher-markets.mjs — dump the publisher's full catalog for each
 * market into `tools/.publisher-markets.json`.
 *
 *   node tools/scripts/fetch-publisher-markets.mjs [--out <file>]
 *
 * Source: the Microsoft Store storefront's own publisher-search endpoint
 * (`SearchByPublisherName`), cursor-paginated. It returns localized titles,
 * descriptions, categories and prices per market — DisplayCatalog omits the
 * price for many recently published SKUs, so this endpoint is the primary
 * price source.
 *
 * The storefront listing omits some live products (free / trial-only
 * listings). `build-seed-from-publisher.mjs` unions the listing with the
 * current seed so those products are not dropped.
 *
 * Every returned productId is also checked against DisplayCatalog to
 * confirm `PublisherId == 26137630` — a product that belongs to another
 * publisher must never reach the catalog.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = path.resolve(__dirname, '..')

const ENDPOINT = 'https://apps.microsoft.com/api/Products/SearchByPublisherName'
const DISPLAY_CATALOG = 'https://displaycatalog.mp.microsoft.com/v7.0/products'
const PUBLISHER = 'WPZStudio'
const PUBLISHER_ID = '26137630'

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Referer: 'https://apps.microsoft.com/',
}

const MARKETS = [
  { code: 'CN', locale: 'zh-CN' },
  { code: 'US', locale: 'en-US' },
  { code: 'HK', locale: 'zh-HK' },
]

const outArgIndex = process.argv.indexOf('--out')
const OUT = path.resolve(
  outArgIndex > -1 && process.argv[outArgIndex + 1]
    ? process.argv[outArgIndex + 1]
    : path.join(TOOLS_DIR, '.publisher-markets.json')
)

async function fetchMarket(code, locale) {
  const u = new URL(ENDPOINT)
  u.searchParams.set('publisherName', PUBLISHER)
  u.searchParams.set('gl', code)
  u.searchParams.set('hl', locale)
  u.searchParams.set('exp', '-1493872042')

  const out = new Map()
  let cursor = null
  let page = 0
  do {
    if (cursor) u.searchParams.set('cursor', cursor)
    const res = await fetch(u, { headers: HEADERS })
    if (res.status !== 200) {
      // A market that 403s / 404s is unavailable, not an empty catalog.
      console.error(`[publisher] gl=${code} HTTP ${res.status} — market unavailable, skipping`)
      return { map: out, failed: true }
    }
    const j = await res.json()
    const list = Array.isArray(j.productsList) ? j.productsList : []
    for (const p of list) {
      const id = String(p.productId || '').toLowerCase()
      if (!id || out.has(id)) continue
      out.set(id, {
        productId: id,
        title: p.title ?? null,
        description: p.description ?? null,
        displayPrice: p.displayPrice ?? null,
        price: typeof p.price === 'number' ? p.price : null,
        categories: Array.isArray(p.categories) ? p.categories : [],
        iconUrl: p.iconUrl ?? null,
        releaseDateUtc: p.releaseDateUtc ?? null,
        publisherName: p.publisherName ?? null,
        packageFamilyNames: Array.isArray(p.packageFamilyNames) ? p.packageFamilyNames : [],
      })
    }
    const next = j.cursor ?? null
    if (!j.hasMorePages || !next || next === cursor) break
    cursor = next
    page++
    if (page > 30) throw new Error(`gl=${code} cursor loop — aborting`)
  } while (true)
  return { map: out, failed: false }
}

async function verifyPublisher(productId) {
  const url =
    `${DISPLAY_CATALOG}/${productId}` +
    '?market=CN&locale=zh-CN&languages=zh-CN'
  try {
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const j = await res.json()
    const P = j?.Product
    if (!P) return { ok: false, reason: 'no Product wrapper' }
    return {
      ok: true,
      publisherId: P?.Properties?.PublisherId ?? null,
      packageFamilyName: P?.Properties?.PackageFamilyName ?? null,
    }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

const result = {}
const failedMarkets = []

for (const m of MARKETS) {
  const { map, failed } = await fetchMarket(m.code, m.locale)
  if (failed) failedMarkets.push(m.code)
  result[m.code] = Object.fromEntries(map)
  console.error(`[publisher] ${m.code}: ${map.size} products`)
}

// ownership gate — nothing from another publisher may enter the catalog
console.error('[publisher] verifying ownership on DisplayCatalog …')
const cnIds = Object.keys(result.CN || {})
const rejected = []
for (const id of cnIds) {
  const v = await verifyPublisher(id)
  if (!v.ok) {
    rejected.push({ id, reason: v.reason })
  } else if (String(v.publisherId) !== PUBLISHER_ID) {
    rejected.push({ id, reason: `publisherId=${v.publisherId}` })
  }
}
if (rejected.length) {
  console.error(`[publisher] REJECTED ${rejected.length} product(s) not owned by ${PUBLISHER}:`)
  for (const r of rejected) console.error(`  - ${r.id}: ${r.reason}`)
  process.exit(1)
}
console.error(`[publisher] ownership verified for ${cnIds.length} products (PublisherId=${PUBLISHER_ID})`)

fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8')
console.error(`[publisher] wrote ${OUT}`)

const onlyCn = cnIds.filter((id) => !result.US?.[id])
const onlyCnHk = cnIds.filter((id) => !result.HK?.[id])
if (onlyCn.length) console.error(`[publisher] not listed in US: ${onlyCn.join(', ')}`)
if (onlyCnHk.length) console.error(`[publisher] not listed in HK: ${onlyCnHk.join(', ')}`)
if (failedMarkets.length) console.error(`[publisher] unavailable markets: ${failedMarkets.join(', ')}`)
