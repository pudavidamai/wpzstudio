/**
 * Fetch full Microsoft Store catalog metadata for a list of productIds and
 * write Jekyll `_data/wpz_apps.yml` (and a JSON twin) into the wpzstudio
 * repo at D:/Projects/wpzstudio/_data/.
 *
 * Source: `displaycatalog.mp.microsoft.com/v7.0/products/<id>` — Microsoft's
 * public DisplayCatalog endpoint. No auth, but it requires the `market`
 * query param (we use `CN` since wpzstudio-promotion.md is zh-CN targeted).
 *
 * Usage:
 *   cd D:/Projects/wpzstudio-tools
 *   node fetch-catalog.mjs
 *
 // Reads the seed list from `apps-seed.json` (kept in version control next
 // to this script). Each entry: { productId, slug, name, fallbackCover, ... }
 // where `fallbackCover` is the original Microsoft Store cover URL (used only
 // if DisplayCatalog returns no Logo 300x300 image). The bilingual
 // `description` and `descriptionEn` fields may contain `\u00xx` escape
 // sequences (em-dashes, smart quotes, ellipsis) — we decode them here so the
 // YAML round-trip doesn't double-encode them.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEED_PATH = path.join(__dirname, 'apps-seed.json')
// Output target resolution order:
//   1. WPZSTUDIO_ROOT env var (for testing / different layouts)
//   2. Default: .. relative to this script (this script lives at
//      <repo>/tools/fetch-catalog.mjs, so .. is the Jekyll repo root
//      containing _data/)
const WPZSTUDIO_ROOT = process.env.WPZSTUDIO_ROOT
  ? path.resolve(process.env.WPZSTUDIO_ROOT)
  : path.resolve(__dirname, '..')
const DATA_DIR = path.join(WPZSTUDIO_ROOT, '_data')
const OUT_JSON = path.join(DATA_DIR, 'wpz_apps.json')
const OUT_YAML = path.join(DATA_DIR, 'wpz_apps.yml')

const CATALOG_URL =
  'https://displaycatalog.mp.microsoft.com/v7.0/products'

function curlJson(url) {
  // DisplayCatalog gzip-encodes responses — pass --compressed to curl.
  const out = execFileSync(
    'curl',
    ['-sS', '-L', '--compressed', '-A', 'Mozilla/5.0', url],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  return JSON.parse(out)
}

function pickImage(images, purpose, minSize = 0) {
  // Microsoft Store returns multiple sizes per purpose; pick the largest.
  const candidates = images.filter(
    (i) => i.ImagePurpose === purpose && (i.Width || 0) >= minSize
  )
  if (!candidates.length) return null
  candidates.sort((a, b) => (b.Width || 0) - (a.Width || 0))
  // URIs come in as `//store-images.s-microsoft.com/...` — prepend https:
  const uri = candidates[0].Uri
  return uri.startsWith('//') ? `https:${uri}` : uri
}

function pickScreenshot(images) {
  return pickImage(images, 'Screenshot', 800)
}

function normalize(app, raw) {
  const prod = raw.Product
  const loc = prod?.LocalizedProperties?.[0] ?? {}
  const props = prod?.Properties ?? {}
  const images = loc.Images ?? []
  return {
    productId: prod?.ProductId || app.productId,
    slug: app.slug,
    name: app.name,
    title: loc.ProductTitle || app.name,
    // Catalog meta — preserved from seed (which was hand-curated from
    // Microsoft Store): category is shown in zh-CN on the existing site;
    // price is in HK$; descriptions are bilingual (desc for zh, descEn for
    // fallback when zh description is absent from DisplayCatalog).
    category: app.category || props.Category || null,
    subCategory: props.SubCategory || null,
    price: isRealPrice(app.price) ? app.price : derivePriceFromCatalog(prod) || app.price || null,
    description: (loc.ProductDescription || '').trim() || app.description || null,
    descriptionEn: app.descriptionEn || null,
    shortDescription: (loc.ShortDescription || '').trim() || null,
    publisher: loc.PublisherName || null,
    developer: loc.DeveloperName || null,
    publisherWebsiteUri: loc.PublisherWebsiteUri || null,
    supportUri: loc.SupportUri || null,
    publisherId: props.PublisherId || null,
    packageFamilyName: props.PackageFamilyName || null,
    iconUrl: pickImage(images, 'Logo', 200) || app.fallbackCover || null,
    bannerUrl: pickImage(images, 'Tile', 200) || app.fallbackCover || null,
    heroUrl: pickScreenshot(images) || app.fallbackCover || null,
    images: images
      .filter((i) => i.Width)
      .map((i) => ({
        purpose: i.ImagePurpose,
        width: i.Width,
        height: i.Height,
        url: i.Uri.startsWith('//') ? `https:${i.Uri}` : i.Uri
      }))
  }
}

function isRealPrice(price) {
  // Treat placeholder strings (e.g. "待同步") as not-a-real-price so we
  // fall back to deriving from DisplayCatalog.
  if (price == null) return false
  if (typeof price !== 'string') return true
  const trimmed = price.trim()
  if (!trimmed) return false
  if (trimmed === '待同步') return false
  return true
}

function derivePriceFromCatalog(prod) {
  // Walk DisplaySkuAvailabilities → Sku.MarketProperties[*].Price.
  // Prefer CNY list price (most stable for zh-CN-locale storefront).
  // Returns a display string like "¥26.00" or "免费下载" or null.
  const skus = prod?.DisplaySkuAvailabilities || []
  let best = null
  let bestCny = null
  for (const sku of skus) {
    for (const mp of sku?.Sku?.MarketProperties || []) {
      const price = mp?.Price
      if (!price) continue
      const code = String(price.CurrencyCode || '').toUpperCase()
      const list = Number(price.ListPrice)
      if (!Number.isFinite(list)) continue
      if (list <= 0) {
        if (!best) best = '免费下载'
        continue
      }
      const symbol = code === 'CNY' ? '¥' : code === 'HK$' ? 'HK$' : code === 'USD' ? '$' : ''
      const label = symbol === 'HK$' || symbol === '$'
        ? `${symbol}${list.toFixed(2)}`
        : `${symbol}${list.toFixed(2)}`
      if (code === 'CNY') bestCny = label
      else if (!best) best = label
    }
  }
  return bestCny || best
}

function decodeEscapes(s) {
  // Converts literal backslash-u00xx sequences into the actual Unicode
  // codepoint (e.g. "\u2014" → "—"). Used to undo the double-encoding that
  // can happen when source text round-trips through JS unicode_escape + UTF-8.
  if (typeof s !== 'string') return s
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16))
  )
}

function yamlEscape(s) {
  if (s == null) return ''
  return String(s).replace(/"/g, '\\"')
}

function yamlBlock(s) {
  // Multi-line YAML block scalar (`|`). Each line prefixed with 4 spaces,
  // trailing newline preserved.
  const lines = String(s).replace(/\r\n/g, '\n').split('\n')
  return ['|'].concat(lines.map((l) => `    ${l}`)).join('\n')
}

function toYaml(apps) {
  const out = []
  for (const a of apps) {
    // Repair any mojibake that crept into descriptionEn from past JS-extract
    // passes. The classic failure mode is double-encoded UTF-8 (a Chinese
    // char like '欢' -> '\xe6\xac\xa2' bytes, decoded as latin-1 -> 'æ¬¢'
    // chars, then re-encoded as UTF-8 -> '\xc3\xa6\xc2\xac\xc2\xa2' bytes).
    // When that ends up in YAML, PyYAML rejects the C1 control bytes. If
    // any C1 char is present in descriptionEn, fall back to the Chinese
    // description (or to descriptionEn again as a last resort).
    const repaired = (s) =>
      s && /[\u0080-\u009f]/.test(s) ? null : s
    const descEn = repaired(a.descriptionEn) ?? a.description ?? null
    out.push(`- productId: "${a.productId}"`)
    out.push(`  slug: "${a.slug}"`)
    out.push(`  name: "${yamlEscape(a.name)}"`)
    out.push(`  title: "${yamlEscape(a.title)}"`)
    if (a.category) out.push(`  category: "${yamlEscape(a.category)}"`)
    if (a.price) out.push(`  price: "${yamlEscape(a.price)}"`)
    if (a.shortDescription) {
      out.push(`  shortDescription: "${yamlEscape(a.shortDescription)}"`)
    }
    if (a.description) {
      out.push(`  description: ${yamlBlock(decodeEscapes(a.description))}`)
    }
    if (descEn) {
      out.push(`  descriptionEn: ${yamlBlock(decodeEscapes(descEn))}`)
    }
    if (a.publisher) out.push(`  publisher: "${yamlEscape(a.publisher)}"`)
    if (a.developer) out.push(`  developer: "${yamlEscape(a.developer)}"`)
    if (a.publisherWebsiteUri) {
      out.push(`  publisherWebsiteUri: "${a.publisherWebsiteUri}"`)
    }
    if (a.publisherId) out.push(`  publisherId: "${a.publisherId}"`)
    if (a.packageFamilyName) {
      out.push(`  packageFamilyName: "${a.packageFamilyName}"`)
    }
    if (a.subCategory) out.push(`  subCategory: "${yamlEscape(a.subCategory)}"`)
    if (a.iconUrl) out.push(`  iconUrl: "${a.iconUrl}"`)
    if (a.bannerUrl) out.push(`  bannerUrl: "${a.bannerUrl}"`)
    if (a.heroUrl) out.push(`  heroUrl: "${a.heroUrl}"`)
    if (a.images && a.images.length) {
      out.push(`  images:`)
      for (const img of a.images.slice(0, 8)) {
        out.push(`    - purpose: "${img.purpose}"`)
        out.push(`      width: ${img.width}`)
        out.push(`      height: ${img.height}`)
        out.push(`      url: "${img.url}"`)
      }
    }
    out.push('')
  }
  return out.join('\n')
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const seed = JSON.parse(await fs.readFile(SEED_PATH, 'utf8'))
  console.log(`[fetch-catalog] ${seed.length} products in seed list`)

  const apps = []
  for (const item of seed) {
    const url = `${CATALOG_URL}/${item.productId}?market=CN&locale=zh-CN&languages=zh-CN`
    process.stdout.write(`[fetch-catalog] ${item.name} (${item.productId})... `)
    try {
      const raw = curlJson(url)
      if (!raw || !raw.Product) {
        throw new Error(`unexpected response shape: ${JSON.stringify(raw).slice(0, 200)}`)
      }
      const app = normalize(item, raw)
      apps.push(app)
      console.log(`✓ ${app.title || '(no title)'}`)
    } catch (err) {
      console.log(`✗ ${err.message?.slice(0, 120)}`)
      apps.push({
        productId: item.productId,
        slug: item.slug,
        name: item.name,
        iconUrl: item.fallbackCover || null,
        error: String(err.message)
      })
    }
  }

  await fs.writeFile(OUT_JSON, JSON.stringify(apps, null, 2), 'utf8')
  await fs.writeFile(OUT_YAML, toYaml(apps), 'utf8')
  const ok = apps.filter((a) => !a.error).length
  console.log(`\n[fetch-catalog] wrote ${ok}/${apps.length} entries to:`)
  console.log(`  ${OUT_JSON}`)
  console.log(`  ${OUT_YAML}`)
}

main().catch((err) => {
  console.error('[fetch-catalog] fatal:', err)
  process.exit(1)
})