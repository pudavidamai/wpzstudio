#!/usr/bin/env node
/**
 * Add one or more productIds to tools/apps-seed-pending.txt.
 *
 *   node tools/scripts/seed-pending-add.mjs <productId> [<productId> ...]
 *   node tools/scripts/seed-pending-add.mjs --dry-run <productId> ...
 *
 * Each productId is normalized to uppercase, validated against
 * apps-seed.json (skip duplicates), and appended as a new line.
 * Blank lines and `#` comments in the pending file are preserved.
 *
 * Exit codes:
 *   0  success (all ids written, or all skipped cleanly)
 *   1  invalid argument (bad id format, no ids given, file unreadable)
 *   2  write failed
 *
 * Does NOT call DisplayCatalog — that's the CI's job (validate-pending.mjs).
 * Does NOT git commit / push — the add-apps workflow picks up the file.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = path.resolve(__dirname, '..')
const PENDING_PATH = path.join(TOOLS_DIR, 'apps-seed-pending.txt')
const SEED_PATH = path.join(TOOLS_DIR, 'apps-seed.json')

const ID_RE = /^[A-Za-z0-9]{12,16}$/
const dryRun = process.argv.includes('--dry-run')
const ids = process.argv.slice(2).filter(a => !a.startsWith('--'))

function die(msg, code = 1) {
  console.error(`[seed-add] ${msg}`)
  process.exit(code)
}

if (ids.length === 0) {
  die('usage: node tools/scripts/seed-pending-add.mjs [--dry-run] <productId> [<productId> ...]', 1)
}

const normalized = []
for (const raw of ids) {
  if (!ID_RE.test(raw)) {
    die(`invalid productId format: "${raw}" (expected 12-16 alphanumeric chars)`, 1)
  }
  normalized.push(raw.toUpperCase())
}

const seed = JSON.parse(await fs.readFile(SEED_PATH, 'utf8').catch(() => '[]'))
const seeded = new Set(seed.map(s => String(s.productId || '').toUpperCase()))

const existingPending = (await fs.readFile(PENDING_PATH, 'utf8').catch(() => ''))
const pendingIds = new Set(
  existingPending.split('\n')
    .map(l => l.trim().split(/\s+/)[0])
    .filter(t => ID_RE.test(t))
    .map(t => t.toUpperCase())
)

const toWrite = []
const skipped = []
for (const id of normalized) {
  if (seeded.has(id)) {
    skipped.push({ id, reason: 'already in apps-seed.json' })
    continue
  }
  if (pendingIds.has(id)) {
    skipped.push({ id, reason: 'already in pending file' })
    continue
  }
  toWrite.push(id)
  pendingIds.add(id)  // de-dup within the same call
}

console.log(`[seed-add] requested=${ids.length} new=${toWrite.length} skipped=${skipped.length}`)
for (const s of skipped) console.log(`[seed-add]   skip ${s.id} (${s.reason})`)
for (const id of toWrite)  console.log(`[seed-add]   add  ${id}`)

if (toWrite.length === 0) {
  console.log('[seed-add] nothing to write — exiting 0')
  process.exit(0)
}

if (dryRun) {
  console.log('[seed-add] --dry-run: would append:')
  for (const id of toWrite) console.log(`  ${id}`)
  process.exit(0)
}

const sep = existingPending.endsWith('\n') || existingPending === '' ? '' : '\n'
const append = sep + toWrite.join('\n') + '\n'

try {
  await fs.appendFile(PENDING_PATH, append, 'utf8')
  console.log(`[seed-add] wrote ${toWrite.length} line(s) to ${path.relative(process.cwd(), PENDING_PATH)}`)
} catch (err) {
  die(`write failed: ${err.message}`, 2)
}
