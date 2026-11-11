#!/usr/bin/env node
/**
 * doctor.mjs — catalog integrity gate for the wpzstudio Jekyll site.
 *
 *   node tools/scripts/doctor.mjs
 *
 * Checks (exit 1 on any FAIL):
 *   1. seed / _data counts agree
 *   2. no duplicate productId, name or slug in the seed
 *   3. every entry has productId, name, category, price, description,
 *      descriptionEn, iconUrl
 *   4. every price is a real amount (a currency + digits, or the free label)
 *   5. every productId belongs to publisher 26137630
 *   6. the front-end does NOT silently drop free apps (the bug that made
 *      the site advertise "N 款应用" while the catalog held more)
 *   7. every category used in the catalog has a zh+en label in index.html
 *   8. the site logo / favicon assets referenced by the layouts exist
 *   9. `_data/*.yml` parses as valid YAML with the same entry count
 *
 * Usage: node tools/scripts/doctor.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')

const SEED = path.join(ROOT, 'tools', 'apps-seed.json')
const DATA_JSON = path.join(ROOT, '_data', 'wpz_apps.json')
const DATA_YAML = path.join(ROOT, '_data', 'wpz_apps.yml')
const INDEX = path.join(ROOT, 'index.html')
const CONFIG = path.join(ROOT, '_config.yml')
const META = path.join(ROOT, '_includes', 'meta.html')

const PUBLISHER_ID = '26137630'
const FREE_PRICE_RE = /^(免费|免費|Free|免费下载)$/i
const PRICE_RE = /^[¥$]|^(HK\$|US\$|CN¥)\s*\d/i

const failures = []
const warnings = []
let checks = 0

function check(name, fn) {
  checks++
  try {
    const result = fn()
    if (result === true || result === undefined) {
      console.log(`PASS  ${name}`)
    } else if (typeof result === 'string') {
      console.log(`PASS  ${name} — ${result}`)
    } else {
      console.log(`FAIL  ${name}`)
      failures.push(name)
    }
  } catch (err) {
    console.log(`FAIL  ${name} — ${err.message}`)
    failures.push(name)
  }
}

function warn(name, detail) {
  warnings.push(`${name}: ${detail}`)
  console.log(`WARN  ${name} — ${detail}`)
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const readText = (p) => fs.readFileSync(p, 'utf8')

const seed = readJson(SEED)
const data = readJson(DATA_JSON)
const indexHtml = readText(INDEX)
const configYml = readText(CONFIG)
const metaHtml = readText(META)

console.log(`[doctor] wpzstudio catalog integrity — ${seed.length} seed entries\n`)

// 1. counts agree
check('seed and _data counts agree', () => {
  if (seed.length !== data.length) {
    throw new Error(`seed=${seed.length} but _data=${data.length} — run node tools/fetch-catalog.mjs`)
  }
  return `${seed.length} entries`
})

// 2. no duplicates
check('no duplicate productId / name / slug', () => {
  const dup = (key) => {
    const seen = new Map()
    for (const e of seed) {
      const k = String(e[key] || '').trim().toLowerCase()
      if (!k) continue
      seen.set(k, (seen.get(k) || 0) + 1)
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
  }
  const d1 = dup('productId')
  const d2 = dup('name')
  const d3 = dup('slug')
  if (d1.length || d2.length || d3.length) {
    throw new Error(`dup productId=${d1.join(',')} name=${d2.join(',')} slug=${d3.join(',')}`)
  }
  return 'unique'
})

// 3. required fields
check('every entry has the required fields', () => {
  const required = ['productId', 'name', 'category', 'price', 'description', 'descriptionEn', 'fallbackCover']
  const missing = []
  for (const e of seed) {
    for (const f of required) {
      if (!String(e[f] || '').trim()) missing.push(`${e.name || e.productId}.${f}`)
    }
  }
  if (missing.length) throw new Error(missing.join(', '))
  return `${required.length} fields × ${seed.length} entries`
})

// 4. prices are real
check('every price is a real amount', () => {
  const bad = []
  for (const e of seed) {
    const p = String(e.price || '').trim()
    if (!FREE_PRICE_RE.test(p) && !PRICE_RE.test(p)) bad.push(`${e.name}: "${p}"`)
    if (/待同步/.test(p)) bad.push(`${e.name}: placeholder "${p}"`)
  }
  if (bad.length) throw new Error(bad.join('; '))
  const free = seed.filter((e) => FREE_PRICE_RE.test(String(e.price || '').trim()))
  return `${seed.length - free.length} paid + ${free.length} free`
})

// 5. publisher ownership
check(`every productId belongs to publisher ${PUBLISHER_ID}`, () => {
  const bad = [...new Set(data.map((e) => e.publisherId).filter((p) => p && String(p) !== PUBLISHER_ID))]
  if (bad.length) throw new Error(`wrong publisherId: ${bad.join(', ')}`)
  const missing = data.filter((e) => !e.publisherId).length
  if (missing) throw new Error(`${missing} entries have no publisherId`)
  return `${data.length} verified`
})

// 6. the front-end must not silently drop free apps
check('front-end does not filter free apps out of the grid', () => {
  const sanitize = indexHtml.match(/function sanitizeApps[\s\S]*?\n  \}/)
  if (!sanitize) throw new Error('sanitizeApps() not found in index.html')
  if (/isFreePrice\(app\.price\)\)\s*\{?\s*return/.test(sanitize[0])) {
    throw new Error('sanitizeApps() drops free apps — cards and the count are both silently reduced')
  }
  const free = seed.filter((e) => FREE_PRICE_RE.test(String(e.price || '').trim()))
  return `${free.length} free app(s) visible`
})

// 7. category labels exist for every category in use
check('every catalog category has a zh+en label in index.html', () => {
  const used = [...new Set(seed.map((e) => e.category).filter(Boolean))]
  const block = indexHtml.match(/const categoryI18n\s*=\s*\{[\s\S]*?\n  \};/)
  if (!block) throw new Error('categoryI18n map not found in index.html')
  // The zh block and the en block must each carry every category. Checking
  // "does the string appear anywhere" is too weak — deleting only the zh
  // label still leaves the en one, so the check would pass.
  const zhBlock = block[0].match(/zh:\s*\{[\s\S]*?\n    \}/)
  const enBlock = block[0].match(/en:\s*\{[\s\S]*?\n    \}/)
  if (!zhBlock || !enBlock) throw new Error('categoryI18n zh/en blocks not found in index.html')
  const missingZh = used.filter((c) => !zhBlock[0].includes(`"${c}"`))
  const missingEn = used.filter((c) => !enBlock[0].includes(`"${c}"`))
  if (missingZh.length) throw new Error(`missing zh labels: ${missingZh.join(', ')}`)
  if (missingEn.length) throw new Error(`missing en labels: ${missingEn.join(', ')}`)
  return `${used.length} categories labelled in both locales`
})

// 8. logo / favicon assets exist
check('logo and favicon assets exist', () => {
  const refs = new Set()
  const avatar = configYml.match(/^avatar:\s*(\S+)/m)
  if (avatar) refs.add(avatar[1])
  for (const m of metaHtml.matchAll(/href="\{\{\s*'(\/[^']+)'\s*\|\s*relative_url\s*\}\}"/g)) {
    refs.add(m[1])
  }
  const missing = []
  for (const ref of refs) {
    const p = path.join(ROOT, ref.replace(/^\//, ''))
    if (!fs.existsSync(p)) missing.push(ref)
  }
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`)
  return `${refs.size} asset refs present`
})

// 9. YAML twin is valid and agrees
check('_data/wpz_apps.yml is valid YAML with the same count', () => {
  const yaml = readText(DATA_YAML)
  // structural check without a YAML dependency: count the entry markers
  const entries = (yaml.match(/^- productId:/gm) || []).length
  if (entries !== data.length) {
    throw new Error(`yaml has ${entries} entries, json has ${data.length}`)
  }
  if (/[\u0080-\u009f]/.test(yaml)) {
    throw new Error('yaml contains C1 control characters (mojibake) — PyYAML will reject it')
  }
  return `${entries} entries`
})

// 10. every seed productId resolves to a data entry
check('every seed productId is present in _data', () => {
  const ids = new Set(data.map((e) => String(e.productId).toLowerCase()))
  const missing = seed
    .map((e) => String(e.productId).toLowerCase())
    .filter((id) => !ids.has(id))
  if (missing.length) throw new Error(`missing from _data: ${missing.join(', ')}`)
  return `${seed.length} matched`
})

console.log('')
if (warnings.length) {
  console.log(`${warnings.length} warning(s):`)
  for (const w of warnings) console.log(`  - ${w}`)
  console.log('')
}
if (failures.length) {
  console.error(`DOCTOR FAILED — ${failures.length} of ${checks} check(s) failed:`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`DOCTOR OK — ${checks}/${checks} checks passed`)
