#!/usr/bin/env node
/**
 * verify-render.mjs — prove that the site's Liquid loop + front-end JS
 * actually render one card per catalog entry.
 *
 *   node tools/scripts/verify-render.mjs
 *
 * GitHub Pages renders the site with Jekyll, which is not installed on every
 * dev machine. This script reproduces the two steps that decide what the
 * visitor sees:
 *
 *   1. the `{%- for app in site.data.wpz_apps -%}` loop in index.html is
 *      evaluated against `_data/wpz_apps.json` — the same data Jekyll feeds it;
 *   2. the resulting `apps` array is pushed through the page's own
 *      `sanitizeApps()` / `isFreePrice()` / `normalizeName()` logic and the
 *      resulting card count is compared with the catalog count.
 *
 * This is the check that catches the "site says 40 款应用 while the catalog
 * holds 42" class of bug: if the front-end ever filters an app out silently,
 * the counts diverge and this script fails.
 *
 * Exit codes: 0 ok · 1 mismatch
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const INDEX = path.join(ROOT, 'index.html')
const DATA = path.join(ROOT, '_data', 'wpz_apps.json')

const indexHtml = fs.readFileSync(INDEX, 'utf8')
const catalog = JSON.parse(fs.readFileSync(DATA, 'utf8'))

const failures = []
function fail(msg) {
  failures.push(msg)
  console.log(`FAIL  ${msg}`)
}

// ---- 1. evaluate the Liquid loop ---------------------------------------

const loopMatch = indexHtml.match(
  /const apps = \[\s*\{%-?\s*for app in site\.data\.wpz_apps\s*-?%\}([\s\S]*?)\{%-?\s*endfor\s*-?%\}\s*\];/
)
if (!loopMatch) {
  fail('could not find the `{% for app in site.data.wpz_apps %}` loop in index.html')
  process.exit(1)
}
const loopBody = loopMatch[1]

// The Liquid body emits `key: {{ app.field | jsonify }}` pairs. The key is the
// JS property name (name / desc / image / …) and `app.field` is the data
// column it reads — they are NOT the same thing (e.g. `desc` <- `description`,
// `image` <- `iconUrl`). Parse the pairs, never guess.
function renderLoop() {
  const items = []
  const pairRe = /(\w+)\s*:\s*\{\{\s*app\.(\w+)\s*(\|[^}]*)?\}\}/g
  for (const app of catalog) {
    const obj = {}
    let matched = false
    let m
    pairRe.lastIndex = 0
    while ((m = pairRe.exec(loopBody)) !== null) {
      const [, key, field, filters] = m
      matched = true
      let value = app[field]
      if (filters && /default:\s*''/.test(filters)) {
        if (value === undefined || value === null || value === '') value = ''
      }
      obj[key] = value === undefined || value === null ? '' : value
    }
    if (!matched) {
      throw new Error('no `key: {{ app.field }}` pairs found in the Liquid loop')
    }
    // the store link is a literal template expression, not a data column
    const linkMatch = loopBody.match(/link\s*:\s*"([^"]*\{\{\s*app\.(\w+)\s*\}\}[^"]*)"/)
    if (linkMatch) {
      obj.link = linkMatch[1].replace(/\{\{\s*app\.(\w+)\s*\}\}/g, (_, f) => app[f] ?? '')
    }
    items.push(obj)
  }
  return items
}

const rendered = renderLoop()
console.log(`[verify-render] Liquid loop produced ${rendered.length} entries from ${catalog.length} catalog rows`)

// ---- 2. run the page's own sanitize logic -------------------------------

// Pull the three helpers straight out of index.html so this script can never
// drift from the page it verifies.
function extractFunction(name) {
  const re = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n  \\}`)
  const m = indexHtml.match(re)
  if (!m) throw new Error(`function ${name}() not found in index.html`)
  return m[0]
}

const helpers = [
  extractFunction('isFreePrice'),
  extractFunction('normalizeName'),
  extractFunction('sanitizeApps'),
].join('\n\n')

const sandbox = {
  console,
  result: null,
}
vm.createContext(sandbox)
vm.runInContext(
  `${helpers}\nresult = sanitizeApps(${JSON.stringify(rendered)});`,
  sandbox,
  { timeout: 5000 }
)
const visible = sandbox.result

console.log(`[verify-render] front-end renders ${visible.length} cards`)
console.log(`[verify-render] catalog holds ${catalog.length} entries`)

// ---- 3. assertions ------------------------------------------------------

if (rendered.length !== catalog.length) {
  fail(`Liquid loop rendered ${rendered.length} of ${catalog.length} catalog rows`)
}

if (visible.length !== catalog.length) {
  const visibleNames = new Set(visible.map((a) => a.name))
  const dropped = catalog.filter((a) => !visibleNames.has(a.name)).map((a) => a.name)
  fail(
    `front-end renders ${visible.length} of ${catalog.length} cards — ` +
      `dropped: ${dropped.join(', ') || '(name mismatch)'}`
  )
} else {
  console.log(`PASS  every catalog entry renders as a card`)
}

// ---- 4. free apps must be present and labelled --------------------------

const freeEntries = catalog.filter((a) => /免费|免費|free/i.test(String(a.price || '')))
const visibleFree = visible.filter((a) => /免费|免費|free/i.test(String(a.price || '')))
console.log(
  `[verify-render] free entries: ${freeEntries.length} in catalog, ${visibleFree.length} visible`
)
if (freeEntries.length !== visibleFree.length) {
  fail(
    `${freeEntries.length - visibleFree.length} free app(s) are hidden by the front-end ` +
      '(they must render with a 免费 badge)'
  )
} else if (freeEntries.length) {
  console.log(`PASS  all ${freeEntries.length} free app(s) are visible`)
}

// ---- 5. every card has a working store link ----------------------------

// The base link is `https://apps.microsoft.com/detail/<productId>`; locale
// params (`?hl=…&gl=…`) are appended at render time by localizedStoreLink()
// based on the active UI language, so here we only assert the base is valid.
const badLinks = visible.filter(
  (a) => !/^https:\/\/apps\.microsoft\.com\/detail\/[A-Za-z0-9]+(\?.*)?$/.test(a.link)
)
if (badLinks.length) {
  fail(
    `${badLinks.length} card(s) have a malformed store link: ` +
      badLinks.map((a) => `${a.name} -> ${a.link}`).join(', ')
  )
} else {
  console.log(`PASS  all ${visible.length} store links are well-formed`)
}

// ---- 6. every card has an image and a description -----------------------

const noImage = visible.filter((a) => !String(a.image || '').trim())
const noDesc = visible.filter((a) => !String(a.desc || '').trim())
if (noImage.length) fail(`${noImage.length} card(s) have no image: ${noImage.map((a) => a.name).join(', ')}`)
else console.log(`PASS  all ${visible.length} cards have an image`)
if (noDesc.length) fail(`${noDesc.length} card(s) have no description: ${noDesc.map((a) => a.name).join(', ')}`)
else console.log(`PASS  all ${visible.length} cards have a description`)

console.log('')
if (failures.length) {
  console.error(`RENDER VERIFY FAILED — ${failures.length} problem(s):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('RENDER VERIFY OK')
