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

`.github/workflows/sync-catalog.yml` runs this script on a weekly cron
(Monday 03:00 UTC) and opens a PR if the catalog changed. See the
workflow file for the setup steps (GitHub Actions permission:
"Allow GitHub Actions to create and approve pull requests").

For manual dispatch: from the GitHub UI → "Run workflow", or via CLI:

```bash
gh workflow run sync-catalog.yml -R pudavidamai/wpzstudio
```