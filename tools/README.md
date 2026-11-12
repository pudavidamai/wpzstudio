# wpzstudio-tools

Sync utilities for the [WPZ Studio](https://github.com/pudavidamai/wpzstudio)
GitHub Pages site. This subdirectory lives inside the wpzstudio Jekyll repo
itself (so Actions workflows can mutate `_data/` in-place without a
cross-repo PR), but Jekyll is configured to skip it during build
(see `_config.yml` `exclude:`).

## What it does

`fetch-catalog.mjs` reads `apps-seed.json`, calls the Microsoft Store
public `displaycatalog.mp.microsoft.com/v7.0/products/<id>` endpoint for
each known productId, and writes two files into `../_data/`:

- `wpz_apps.json` — machine-readable twin (used by Jekyll's site.data)
- `wpz_apps.yml` — human-editable source of truth

The Jekyll site renders the catalog from `site.data.wpz_apps`, so a sync
is effectively a deploy.

## Usage

```bash
# From the wpzstudio repo root:
pnpm --dir tools sync         # regenerate _data AND print the sync diff report
pnpm --dir tools report       # just diff the current _data against git HEAD (no fetch)
pnpm --dir tools seed:add 9PCLL2BP6V0D   # append a productId to apps-seed-pending.txt

# Or directly:
node tools/fetch-catalog.mjs
node tools/scripts/sync-report.mjs [--fetch] [--json] [--quiet]
```

`sync` now runs `fetch-catalog.mjs` (regenerate `_data/wpz_apps.{json,yml}`
from Microsoft DisplayCatalog) **then** `sync-report.mjs`, which compares the
freshly-written `_data/wpz_apps.json` against the committed copy (`git HEAD`)
and prints an at-a-glance diff:

```
→ 72→73   (+1 new, -0 removed, 0 changed, 0 dead)
New products:
  + MeshForge (9N85SFLW79JF)  [开发人员工具]  ¥18.00
Changed products:
  ~ AirBridge (9PF1C6SGDNJ4): price "¥14.00" → "¥15.00"
```

> Prices come from the **CN** storefront and are rendered verbatim. The
> labels are `¥` for CN and `HK$` for HK; the old bug was shipping CN
> amounts under an `HK$` label.

Use that output to decide whether the sync is clean, and to quote the real
numbers in the commit message. `--json` also writes the structured diff to
`tools/wpz-sync-diff.json` (gitignored). `--before <git-ref>` / `--after <path>`
let you diff arbitrary snapshots.

> The site renders the catalog from `site.data.wpz_apps` (the Jekyll
> `_data/wpz_apps.yml`). `index.html` only contains a Liquid `for` loop over it
> — there is no hardcoded `apps` array to hand-edit anymore, and the localized
> README files are prose only (no product tables). A "sync" is therefore just
> regenerate `_data` → commit `_data/wpz_apps.{json,yml}` → push.

The script writes into `../_data/` by default. Override the output target
with `WPZSTUDIO_ROOT=/path/to/jekyll-root`.

## Adding a new app

The publisher listing is the source of truth, so the common path is a full
rebuild rather than a hand edit:

```bash
cd tools
npm run publisher:fetch   # -> .publisher-markets.json (CN/US/HK, ownership-gated)
npm run seed:rebuild      # -> rebuilds apps-seed.json from that dump
npm run sync              # -> fetch-catalog.mjs + sync-report
```

`build-seed-from-publisher.mjs` unions the listing with the current seed, so a
product the storefront listing omits (free / trial-only listings) is kept
rather than dropped. Only re-listings of the same app (same normalized title
AND package family name) are collapsed to the newest release — distinct
productIds with different package family names all stay in the catalog. The
icon for a listing-omitted product is recovered from DisplayCatalog.

To add a single app by hand instead:

1. Open Partner Center → product detail, copy the 12-char productId from
   the URL.
2. Append an entry to `tools/apps-seed.json`:

   ```json
   {
     "slug": "my-new-app",
     "name": "MyNewApp",
     "productId": "9XXXXXXXXXXX",
     "category": "高效工作",
     "price": "¥15.00",
     "description": "中文描述…",
     "descriptionEn": "English description…",
     "fallbackCover": ""
   }
   ```
3. Run `node tools/fetch-catalog.mjs`.
4. Commit `_data/wpz_apps.json` + `_data/wpz_apps.yml` (and the new seed
   entry) and push.

## Field semantics

| Field | Used by fetch-catalog as |
|---|---|
| `productId` | DisplayCatalog lookup key. **Required.** |
| `name` | Display name on the Jekyll site (also used as the slug source). |
| `slug` | Reserved for future per-app page routes. |
| `category` | Used directly (zh category). Falls back to DisplayCatalog `Properties.Category` if empty. |
| `price` | **Used as-is** unless the value is empty, missing, or `"待同步"` — in which case DisplayCatalog's `DisplaySkuAvailabilities[].Sku.MarketProperties[].Price` is consulted (CNY preferred). The CN storefront amount is the source of truth: `¥15.00`, never `HK$15.00` over a CN number. |
| `description` | Used as-is. Falls back to DisplayCatalog `LocalizedProperties[0].ProductDescription` if empty. |
| `descriptionEn` | Used as-is (no fallback). Optional. |
| `fallbackCover` | Used only if DisplayCatalog returns no Logo ≥ 200px. |

## Verification

```bash
cd tools
npm run doctor                       # 10 catalog-integrity checks
node scripts/verify-render.mjs       # one card per catalog entry
```

`doctor.mjs` fails when the seed and `_data` disagree, when a product is
duplicated, when a price is a placeholder, when the front-end filters free
apps out of the grid, when a category lacks a zh or en label, or when a
referenced asset is missing.

`verify-render.mjs` evaluates the Liquid `for` loop over
`site.data.wpz_apps` against `_data/wpz_apps.json` and pushes the result
through the page's own `sanitizeApps()`, so it proves the visitor sees exactly
one card per catalog entry — free apps included.

## Automated sync

Two workflows in `.github/workflows/`:

- `sync-catalog.yml` — runs `node tools/fetch-catalog.mjs` on a weekly
  cron (Monday 03:00 UTC = Beijing 11:00). Refreshes price/title/
  description/icon from Microsoft DisplayCatalog for any productIds
  already in the seed. No seed mutation.

- `add-apps.yml` — runs `node tools/scripts/validate-pending.mjs` when
  `tools/apps-seed-pending.txt` is added or modified on the repo. See
  "Adding a new app (zero-touch)" below.

Both workflows commit directly to `master`, which triggers GitHub Pages
to rebuild and deploy.

### One-time setup (required for both)

Repo Settings → Actions → General → Workflow permissions:
- ✅ "Read and write permissions"
- (Optional) ✅ "Allow GitHub Actions to create and approve pull
  requests" — only needed if you also want workflows to open PRs.

## Adding a new app (zero-touch)

1. From the Microsoft Store URL of your new app, copy the 12-character
   productId (e.g. `9N55B01777XD`).
2. Append it to `tools/apps-seed-pending.txt`, one per line. Optional
   custom-name and inline comments:

   ```
   # Comments start with '#' — one per line
   9N55B01777XD                       # Quick Paste Pro
   9P2Q745TG8L8 = My Cool App         # explicit override
   9PF1C6SGDNJ4
   ```
3. `git add tools/apps-seed-pending.txt && git commit -m 'add: new app(s)' && git push`
4. The `add-apps` workflow validates each productId against Microsoft
   DisplayCatalog, rejects anything that isn't published by WPZStudio
   (publisherId `26137630`) or already in the seed, then appends new
   entries to `tools/apps-seed.json`, regenerates
   `_data/wpz_apps.{json,yml}` via `fetch-catalog.mjs`, removes
   `apps-seed-pending.txt`, and commits everything to `master`.

You should see the new app on https://pudavidamai.github.io/wpzstudio/
within ~2 minutes of the push.

For manual dispatch (re-runs without re-pushing the file):

```bash
gh workflow run add-apps.yml -R pudavidamai/wpzstudio
```