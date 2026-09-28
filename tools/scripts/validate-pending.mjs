/**
 * Read tools/apps-seed-pending.txt, validate each productId against the
 * Microsoft DisplayCatalog, dedupe against the existing apps-seed.json,
 * append new entries to apps-seed.json, and report results.
 *
 * Pending file format (one entry per line):
 *   <productId>                      # use DisplayCatalog title
 *   <productId> = <custom name>       # override display name
 *   # comments and blank lines are ignored
 *
 * Usage: node tools/scripts/validate-pending.mjs
 *
 * Side effects:
 *   - Writes results to GITHUB_OUTPUT (added_count, added_titles)
 *   - Mutates apps-seed.json in place (adds new entries, preserves
 *     existing field customizations like price/category/description)
 *   - Exits 0 on success regardless of whether anything was added.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = path.resolve(__dirname, '..')
const SEED_PATH = path.join(TOOLS_DIR, 'apps-seed.json')
const PENDING_PATH = path.join(TOOLS_DIR, 'apps-seed-pending.txt')

const CATALOG_URL = 'https://displaycatalog.mp.microsoft.com/v7.0/products'
const PUBLISHER_ID = '26137630'   // WPZStudio's Partner Center ID
const MARKET = 'CN'
const LOCALE = 'zh-CN'

function readEnvFile(path) {
  // Parse a GitHub Actions $GITHUB_OUTPUT / $GITHUB_ENV format file.
  try {
    return Object.fromEntries(
      require('node:fs').readFileSync(path, 'utf8')
        .split('\n')
        .filter(line => line.includes('='))
        .map(line => {
          const [k, ...rest] = line.split('=')
          return [k.trim(), rest.join('=').replace(/^"|"$/g, '')]
        })
    )
  } catch { return {} }
}

function appendOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT
  if (!out) return
  // Multi-line values: GitHub uses heredoc form `key<<EOF\nvalue\nEOF`
  if (String(value).includes('\n')) {
    const delim = `EOF_${Math.random().toString(36).slice(2, 10)}`
    require('node:fs').appendFileSync(out, `${key}<<${delim}\n${value}\n${delim}\n`)
  } else {
    require('node:fs').appendFileSync(out, `${key}=${value}\n`)
  }
}

function curlJson(url) {
  const out = execFileSync(
    'curl',
    ['-sS', '-L', '--compressed', '-A', 'Mozilla/5.0', url],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  )
  return JSON.parse(out)
}

function fetchCatalog(productId) {
  const url = `${CATALOG_URL}/${productId}?market=${MARKET}&locale=${LOCALE}&languages=${LOCALE}`
  try {
    return curlJson(url)
  } catch (err) {
    return { __error: String(err.message).slice(0, 200) }
  }
}

function parsePending(text) {
  const entries = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // Optional "<id> = <custom name>" or "<id> # comment"
    const idMatch = line.match(/^([A-Za-z0-9]{12,16})(?:\s*=\s*(.+?))?(?:\s*#.*)?$/)
    if (!idMatch) {
      console.warn(`[validate] skipping malformed line: ${rawLine}`)
      continue
    }
    const [, id, customName] = idMatch
    entries.push({ productId: id.toUpperCase(), customName: customName?.trim() || null })
  }
  return entries
}

function deriveSeedEntry(productId, catalog) {
  // Build a fresh seed entry from a DisplayCatalog response. The fields
  // we set here act as fallbacks for fetch-catalog.mjs — if seed already
  // has a price, that price wins; if seed has a description, that wins.
  const prod = catalog?.Product
  if (!prod) return null
  const loc = prod.LocalizedProperties?.[0] ?? {}
  const props = prod.Properties ?? {}
  const id = prod.ProductId || productId
  const title = loc.ProductTitle || productId
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || id.toLowerCase()
  return {
    slug,
    name: title,
    productId: id,
    // Seed-only fields. fetch-catalog.mjs prefers these when present.
    category: null,           // DisplayCatalog returns zh-CN category; let sync fill it
    price: '待同步',          // sentinel; sync will replace with CNY price
    description: (loc.ProductDescription || '').trim(),
    descriptionEn: (loc.ShortDescription || '').trim() || null,
    fallbackCover: ''
  }
}

async function main() {
  const pendingText = await fs.readFile(PENDING_PATH, 'utf8').catch(() => '')
  if (!pendingText.trim()) {
    appendOutput('added_count', '0')
    appendOutput('added_titles', '')
    console.log('[validate] pending file is empty — nothing to do')
    return
  }
  const parsed = parsePending(pendingText)
  if (parsed.length === 0) {
    appendOutput('added_count', '0')
    appendOutput('added_titles', '')
    console.log('[validate] no parseable productIds in pending file')
    return
  }
  console.log(`[validate] ${parsed.length} productId(s) in pending file`)

  const seed = JSON.parse(await fs.readFile(SEED_PATH, 'utf8'))
  const existing = new Set(seed.map(s => s.productId.toUpperCase()))

  const toAdd = []
  const addedTitles = []
  const skipped = []

  for (const { productId, customName } of parsed) {
    if (existing.has(productId)) {
      console.log(`[validate] ${productId}: already in seed — skip`)
      skipped.push({ productId, reason: 'duplicate' })
      continue
    }
    const catalog = fetchCatalog(productId)
    if (catalog?.__error || !catalog?.Product) {
      console.warn(`[validate] ${productId}: DisplayCatalog error: ${catalog?.__error || 'no Product'}`)
      skipped.push({ productId, reason: 'not_found' })
      continue
    }
    const pubId = catalog.Product.Properties?.PublisherId
    if (pubId !== PUBLISHER_ID) {
      console.warn(`[validate] ${productId}: wrong publisher ${pubId} (expected ${PUBLISHER_ID}) — skip`)
      skipped.push({ productId, reason: 'wrong_publisher' })
      continue
    }
    const entry = deriveSeedEntry(productId, catalog)
    if (!entry) {
      skipped.push({ productId, reason: 'no_data' })
      continue
    }
    if (customName) {
      entry.name = customName
      entry.slug = customName.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
    }
    toAdd.push(entry)
    addedTitles.push(`- ${entry.name} (${productId})`)
    existing.add(productId)
  }

  console.log(`[validate] valid: ${toAdd.length}, skipped: ${skipped.length}`)
  if (skipped.length) {
    console.log('[validate] skipped:')
    for (const s of skipped) console.log(`  - ${s.productId} (${s.reason})`)
  }

  if (toAdd.length > 0) {
    seed.push(...toAdd)
    // Sort by name for stable diffs
    seed.sort((a, b) => a.name.localeCompare(b.name))
    await fs.writeFile(SEED_PATH, JSON.stringify(seed, null, 2) + '\n', 'utf8')
    console.log(`[validate] wrote ${seed.length} entries to apps-seed.json`)
  }

  appendOutput('added_count', String(toAdd.length))
  appendOutput('added_titles', addedTitles.join('\n'))
}

main().catch((err) => {
  console.error('[validate] fatal:', err)
  process.exit(1)
})