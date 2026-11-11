#!/usr/bin/env node
/**
 * build-seed-from-publisher.mjs
 *
 * Rebuild `tools/apps-seed.json` from the Microsoft Store publisher
 * enumeration + the current hand-curated seed.
 *
 *   node tools/scripts/build-seed-from-publisher.mjs \
 *     --markets  <markets.json> \
 *     --seed     <existing apps-seed.json> \
 *     --out      <new apps-seed.json>
 *
 * `markets.json` is the per-market dump produced by
 * `scripts/enumerate-publisher-products.mjs` (shape:
 * `{ "CN": { "<productId>": {...} }, "US": {...}, "HK": {...} }`).
 *
 * Rules (docs/syncskill.md):
 *   1. productId set = publisher listing UNION current seed
 *      (a seed entry missing from the storefront listing is NOT dead —
 *       it may be a free/trial-only listing that the search API omits).
 *   2. duplicate normalized title -> keep the LATEST release.
 *   3. price = CN market `displayPrice`, rendered verbatim.
 *      The site is zh-CN targeted, so the CN storefront amount is the one
 *      users compare against. A product the CN listing omits is probed via
 *      StoreEdge.
 *   4. description = CN storefront copy; descriptionEn = US storefront copy.
 *   5. category = current seed value when present (hand-curated zh
 *      vocabulary, continuity first); otherwise the CN storefront
 *      category mapped onto that vocabulary.
 *   6. name = current seed value when present (site continuity);
 *      otherwise the storefront title.
 *
 * Exit codes: 0 ok · 1 bad args · 2 no products
 */
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const a = { markets: null, seed: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => argv[++i]
    if (k === '--markets') a.markets = v()
    else if (k === '--seed') a.seed = v()
    else if (k === '--out') a.out = v()
    else if (k === '--help' || k === '-h') {
      console.log('usage: node build-seed-from-publisher.mjs --markets <m.json> --seed <s.json> --out <o.json>')
      process.exit(0)
    } else {
      console.error(`[build-seed] unknown flag: ${k}`)
      process.exit(1)
    }
  }
  if (!a.markets || !a.seed || !a.out) {
    console.error('[build-seed] --markets, --seed and --out are required')
    process.exit(1)
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
const markets = JSON.parse(fs.readFileSync(args.markets, 'utf8'))
const oldSeed = JSON.parse(fs.readFileSync(args.seed, 'utf8'))

const CN = markets.CN || {}
const US = markets.US || {}
const HK = markets.HK || {}

// The site's own zh category vocabulary. Storefront labels outside this set
// are mapped onto the closest member instead of inventing new vocabulary.
const CATEGORY_MAP = {
  '高效工作': '高效工作',
  '实用程序与工具': '实用程序与工具',
  '开发人员工具': '开发人员工具',
  '教育': '教育',
  '娱乐': '娱乐',
  '照片与视频': '照片与视频',
  '书籍与参考': '书籍与参考',
  '商务': '高效工作',
  '动作与冒险': '娱乐',
  '家庭与儿童': '教育',
  '音乐': '娱乐',
  '游戏': '娱乐',
  '体育': '娱乐',
}

const FREE_LABEL = '免费下载'

// Products that the storefront search listing omits (free / trial-only
// listings) still exist on DisplayCatalog. The storefront dump has no
// iconUrl for them, so the icon is recovered from the catalog.
async function fetchDisplayCatalogIcon(productId) {
  const url =
    `https://displaycatalog.mp.microsoft.com/v7.0/products/${productId}` +
    '?market=CN&locale=zh-CN&languages=zh-CN'
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    })
    if (!res.ok) return ''
    const j = await res.json()
    const images = j?.Product?.LocalizedProperties?.[0]?.Images || []
    const logos = images
      .filter((i) => i.ImagePurpose === 'Logo' && (i.Width || 0) >= 200)
      .sort((a, b) => (b.Width || 0) - (a.Width || 0))
    if (!logos.length) return ''
    const uri = logos[0].Uri || ''
    return uri.startsWith('//') ? `https:${uri}` : uri
  } catch {
    return ''
  }
}

const norm = (s) =>
  String(s || '').trim().toLowerCase().replace(/[^a-z0-9一-鿿]/g, '')

const seedById = new Map(oldSeed.map((s) => [String(s.productId).toLowerCase(), s]))

// ---- 1. candidate set = listing UNION seed ------------------------------
const candidates = new Map()
for (const id of Object.keys(CN)) candidates.set(id, { id, listed: true })
for (const id of Object.keys(US)) if (!candidates.has(id)) candidates.set(id, { id, listed: false })
for (const id of Object.keys(HK)) if (!candidates.has(id)) candidates.set(id, { id, listed: false })
for (const s of oldSeed) {
  const id = String(s.productId).toLowerCase()
  if (!candidates.has(id)) candidates.set(id, { id, listed: false })
}

const displayOf = (id) => CN[id] || US[id] || HK[id] || null
const titleOf = (id) => seedById.get(id)?.name || displayOf(id)?.title || id

// ---- 2. dedup by normalized title, keep the newest release --------------
const clusters = new Map()
for (const c of candidates.values()) {
  const key = norm(titleOf(c.id))
  if (!key) continue
  if (!clusters.has(key)) clusters.set(key, [])
  clusters.get(key).push(c.id)
}
const dropped = []
for (const [key, ids] of clusters) {
  if (ids.length < 2) continue
  const rel = (id) => CN[id]?.releaseDateUtc || US[id]?.releaseDateUtc || HK[id]?.releaseDateUtc || ''
  const sorted = [...ids].sort((a, b) => {
    const ra = rel(a)
    const rb = rel(b)
    if (ra && rb && ra !== rb) return rb.localeCompare(ra)
    const inSeed = (id) => (seedById.has(id) ? 1 : 0)
    const d = inSeed(b) - inSeed(a)
    return d !== 0 ? d : a.localeCompare(b)
  })
  for (const id of sorted.slice(1)) {
    dropped.push({ id, title: titleOf(id), kept: sorted[0] })
    candidates.delete(id)
  }
}

// ---- 3. slugs ----------------------------------------------------------
const usedSlugs = new Set()
function makeSlug(name, id) {
  const base =
    String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
    `app-${id}`
  let slug = base
  let n = 2
  while (usedSlugs.has(slug)) slug = `${base}-${n++}`
  usedSlugs.add(slug)
  return slug
}

// ---- 4. emit -----------------------------------------------------------
const out = []
const changes = []
const freeList = []

async function emit() {
for (const c of [...candidates.values()].sort((a, b) =>
  titleOf(a.id).localeCompare(titleOf(b.id))
)) {
  const id = c.id
  const prev = seedById.get(id)
  const cn = CN[id] || null
  const us = US[id] || null
  const hk = HK[id] || null

  const name = prev?.name || cn?.title || us?.title || hk?.title || id

  // price — CN market verbatim (the site is zh-CN targeted: 简体 descriptions,
  // 简体 category vocabulary). The previous seed carried "HK$" labels over
  // CN amounts; the HK storefront lists genuinely different digits
  // (AirBridge CN ¥14 / HK $15), so the label was wrong, not just cosmetic.
  // Zero-priced products render with the 简体 free label.
  let price = cn?.displayPrice || ''
  if (!price && hk?.displayPrice) price = hk.displayPrice
  if (!price && us?.displayPrice) price = us.displayPrice
  if (!price && prev?.price) price = prev.price
  const isFree = /免费|免費|free/i.test(price) || /^[¥$]?\s*0(\.0+)?$/.test(price.trim())
  if (isFree) price = FREE_LABEL

  // descriptions — CN storefront copy + US storefront copy
  const description = (cn?.description || '').trim() || (prev?.description || '').trim()
  const descriptionEn = (us?.description || '').trim() || (prev?.descriptionEn || '').trim()

  // category — hand-curated seed value wins (continuity), else map storefront
  let category = prev?.category || null
  if (!category) {
    const storeCat = cn?.categories?.[0] || us?.categories?.[0] || null
    category = storeCat ? CATEGORY_MAP[storeCat] || storeCat : null
  }

  const slug = prev?.slug && String(prev.slug).trim() ? prev.slug : makeSlug(name, id)
  // icon: storefront first, then DisplayCatalog for products the storefront
  // listing omits (free/trial-only listings have no iconUrl there).
  let fallbackCover = prev?.fallbackCover || cn?.iconUrl || us?.iconUrl || hk?.iconUrl || ''
  if (!fallbackCover) {
    fallbackCover = await fetchDisplayCatalogIcon(id)
    if (fallbackCover) console.log(`  icon  ${name} (${id}) <- DisplayCatalog`)
  }

  out.push({
    slug,
    name,
    productId: id.toUpperCase(),
    category,
    price,
    description,
    descriptionEn,
    fallbackCover,
  })

  if (isFree) freeList.push(name)
  if (!prev) changes.push(`NEW     ${name} (${id}) ${price || '(no price)'}`)
  else if (prev.price !== price) changes.push(`PRICE   ${name}: ${prev.price || '(empty)'} -> ${price || '(empty)'}`)
}
}

await emit()

fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
fs.writeFileSync(args.out, JSON.stringify(out, null, 2), 'utf8')

console.log(`[build-seed] entries: ${oldSeed.length} -> ${out.length}`)
console.log(`[build-seed] dropped duplicate-title ids: ${dropped.length}`)
for (const d of dropped) console.log(`  - ${d.title} (${d.id}) kept ${d.kept}`)
console.log(`[build-seed] new/price-changed: ${changes.length}`)
for (const c of changes) console.log(`  ${c}`)
console.log(`[build-seed] free entries (${freeList.length}): ${freeList.join(', ') || '(none)'}`)
const noZh = out.filter((o) => !o.description)
const noEn = out.filter((o) => !o.descriptionEn)
console.log(`[build-seed] missing zh desc: ${noZh.length} ${noZh.map((x) => x.name).join(', ')}`)
console.log(`[build-seed] missing en desc: ${noEn.length} ${noEn.map((x) => x.name).join(', ')}`)
console.log(`[build-seed] wrote ${args.out}`)

if (out.length === 0) process.exit(2)
