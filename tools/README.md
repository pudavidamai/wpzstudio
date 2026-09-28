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
pnpm --dir tools sync         # requires pnpm
# Or directly:
node tools/fetch-catalog.mjs
```

The script writes into `../_data/` by default. Override the output target
with `WPZSTUDIO_ROOT=/path/to/jekyll-root`.

## Adding a new app

1. Open Partner Center → product detail, copy the 12-char productId from
   the URL.
2. Append an entry to `tools/apps-seed.json`:

   ```json
   {
     "slug": "my-new-app",
     "name": "MyNewApp",
     "productId": "9XXXXXXXXXXX",
     "category": "高效工作",
     "price": "HK$15.00",
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
| `price` | **Used as-is** unless the value is empty, missing, or `"待同步"` — in which case DisplayCatalog's `DisplaySkuAvailabilities[].Sku.MarketProperties[].Price` is consulted (CNY preferred). |
| `description` | Used as-is. Falls back to DisplayCatalog `LocalizedProperties[0].ProductDescription` if empty. |
| `descriptionEn` | Used as-is (no fallback). Optional. |
| `fallbackCover` | Used only if DisplayCatalog returns no Logo ≥ 200px. |

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