# WPZ Studio — Microsoft Store Catalog Sync (Spec)

## Purpose

Keep the WPZ Studio GitHub Pages site (https://pudavidamai.github.io/wpzstudio/)
representing exactly the products that are live under the **WPZStudio**
publisher account on the Microsoft Store (`PublisherId == 26137630`), with
current title / price / category / icon / description.

## When To Use

- A new app has been published under WPZStudio.
- An existing app changed name, cover, price, category, or store link.
- The site is missing live products or still shows stale/placeholder metadata.
- You want to refresh metadata and publish.

## Source Of Truth

The **Microsoft DisplayCatalog v7.0** response for each productId, filtered by
publisher:

```
https://displaycatalog.mp.microsoft.com/v7.0/products/<productId>?market=CN&locale=zh-CN
```

The authoritative productId set is `tools/apps-seed.json`. A product is "live"
iff DisplayCatalog returns 200 **and** `Properties.PublisherId == 26137630`.
Do not treat the browser publisher page as machine truth — MS Store's React
virtual-DOM makes scraping lossy (see the companion skill's pitfalls).

## Architecture (this is what actually runs)

The catalog is data-driven; nobody hand-edits the product list:

```
publisher API  ──fetch-publisher-markets.mjs──►  .publisher-markets.json
     │                                                   │
     │            build-seed-from-publisher.mjs          │
     ▼                                                   ▼
apps-seed.json  ──fetch-catalog.mjs (v7.0 DisplayCatalog)──►  _data/wpz_apps.yml + .json
     ▲                                                                  │
     │ validate-pending.mjs (adds new ids)                             ▼
     │                                                        index.html Liquid loop
apps-seed-pending.txt ──add-apps.yml──► commits to master ──►  rendered site
```

- `tools/apps-seed.json` — productId registry (the set to sync). ~73 entries.
- `tools/fetch-catalog.mjs` — regenerate `_data/wpz_apps.{json,yml}` from seed + DisplayCatalog.
- `tools/scripts/fetch-publisher-markets.mjs` — enumerate the publisher's full
  catalog per market (CN / US / HK) from the Store's publisher-search endpoint,
  then gate every id on DisplayCatalog `PublisherId == 26137630`.
- `tools/scripts/build-seed-from-publisher.mjs` — rebuild the seed from that
  dump: union with the current seed, dedupe by product identity (same
  normalized title AND package family name; newest release wins), copy zh/en
  descriptions and the CN price, recover the icon
  from DisplayCatalog for products the storefront listing omits.
- `tools/scripts/doctor.mjs` — catalog integrity gate (10 checks).
- `tools/scripts/verify-render.mjs` — proves the Liquid loop + front-end JS
  render exactly one card per catalog entry (free apps included).
- `tools/scripts/sync-report.mjs` — diff working `_data` vs `git HEAD`; prints `N→M (+new/-removed/changed/dead)`.
- `tools/scripts/seed-pending-add.mjs` — append a productId to `apps-seed-pending.txt` (validated, de-duped).
- `tools/scripts/validate-pending.mjs` — (CI) validate pending ids against DisplayCatalog + PublisherId, append to `apps-seed.json`.
- `.github/workflows/sync-catalog.yml` — weekly cron + dispatch: fetch-catalog → open a **PR** if `_data` changed.
- `.github/workflows/add-apps.yml` — push touching `tools/apps-seed-pending.txt`: validate → seed → fetch-catalog → commit to **master**.

`index.html` renders `site.data.wpz_apps` through a Liquid `for` loop over
`site.data.wpz_apps`; it has no hardcoded `apps` array. The `README.*` files
are prose only (no product tables). Neither is edited during a catalog sync.

> Markdown files in this site are rendered by Jekyll, so a literal Liquid tag
> in prose is parsed as a real tag and **breaks the Pages build**
> ("Liquid syntax error (line N): Expected id but found end_of_string").
> Describe such examples in words instead of writing the braces.
>
> GitHub Pages builds with `liquid.error_mode: strict`, so a Liquid error is
> fatal there, while a plain local `jekyll build` only warns. Reproduce the
> Pages behaviour locally with `--config _config.yml,tools/_config.strict.yml`.

## Local verification

```bash
cd tools
npm run doctor        # 10 catalog-integrity checks
node scripts/verify-render.mjs   # one card per catalog entry
```

Both gates are mutation-tested: reintroducing the old free-app filter, dropping
a seed row, placeholder pricing, a missing asset, a missing category label and
a wrong Liquid data key each make them exit non-zero.

## Required Outputs

After a sync:
- Every live WPZStudio product is present in `_data/wpz_apps.yml`; nothing dead
  or unpublished remains (or it is clearly an intentional exception).
- `sync-report` shows the expected `N→M` with no unexpected removed/dead.
- Changes are committed and either merged (sync-catalog PR) or pushed to master.
- GitHub Pages redeploys automatically after the push/merge.

## Sync Rules

1. Only surface products whose DisplayCatalog `PublisherId == 26137630`.
2. Prefer DisplayCatalog values for `title` / icon / `price`; keep hand-curated
   seed `category` (the site uses 简体 vocabulary) unless clearly wrong.
3. Site category vocabulary (reuse, don't invent): `高效工作 / 实用程序与工具 /
   开发人员工具 / 教育 / 娱乐 / 照片与视频 / 书籍与参考`.
4. Category is locale-localized. Use `market=CN&locale=zh-CN`. HK (`生產力`) and
   US (`Productivity`) labels are the same category in another locale — not a change.
5. **Price source is the CN market** (`market=CN`), rendered verbatim —
   `¥14.00`, `免费下载`. The site is zh-CN targeted, so the CN storefront
   amount is the one the visitor compares against. Do NOT hardcode a currency
   symbol, and do NOT reuse another market's digits under a different symbol:
   AirBridge is `¥14.00` in CN but `HK$15.00` in HK, so a mislabelled amount
   is a real price change, not a label difference.
6. `"Free"` / `"免费下载"` / `"Included"` are equivalent — not a diff; keep local style.
   Zero-priced products are rendered with the 简体 `免费下载` label and ARE
   shown as cards — the front-end must never filter them out silently.
7. Preserve the bilingual pattern (`description` zh, `descriptionEn` en).
8. Keep product names aligned with the live listing unless a documented
   localization choice says otherwise.
9. Only collapse entries that share a normalized title AND the same package
   family name. Different productIds with different package family names are
   distinct live products even if their store copy is identical — keep them
   all (e.g. an app re-published under a new identity while the old listing
   stays live). When they are true re-listings of the same app, keep the
   newest release and drop the older id.
10. A product missing from the storefront listing is NOT dead: free/trial-only
    listings are omitted there. Keep it and recover its icon from DisplayCatalog.
11. A sync commit touches only `_data/*` (and `apps-seed.json` /
    `apps-seed-pending.txt` when adding an app) — never unrelated layout/styling.

## Execution

### A. Refresh existing catalog
Recommended (CI → PR):
```bash
gh workflow run sync-catalog.yml -R pudavidamai/wpzstudio   # opens a PR if _data changed
```
Local:
```bash
cd d:/projects/wpzstudio && git pull origin master
node tools/fetch-catalog.mjs && node tools/scripts/sync-report.mjs   # pnpm --dir tools sync
git add _data/wpz_apps.json _data/wpz_apps.yml
git commit -m "sync: refresh Microsoft Store catalog (<N>→<M> products)"
git push origin master
```

### B. Add a new app (zero-touch)
```bash
node tools/scripts/seed-pending-add.mjs <productId>
git add tools/apps-seed-pending.txt && git commit -m "add: <app>" && git push origin master
# add-apps.yml validates PublisherId, seeds, regenerates _data, commits to master.
```

## Guardrails

- Do not invent products not live on the store; do not keep link-less placeholders
  just to pad the count.
- Do not change categories casually; prefer continuity.
- Do not commit if the working tree has unrelated changes.
- `sync-catalog` produces a **PR** (merge it); `add-apps` pushes to **master**
  directly and needs Actions "read and write" permission — if `_data` didn't
  update, check the run log (push soft-fails to an artifact without perms).

## Completion Checklist

- [ ] `sync-report` / PR diff shows the expected `N→M`; no unexpected removed/dead.
- [ ] All kept productIds return 200 with `PublisherId == 26137630`.
- [ ] `_data/wpz_apps.{json,yml}` regenerated; `index.html` / READMEs untouched for data.
- [ ] Committed with a real `N→M` in the message; merged (sync-catalog) or pushed (master).
- [ ] Pages rebuilt/deployed (confirm via the deployment or the live site).

## Companion

The operational "how" (trigger phrases, endpoint details, pitfalls) lives in
the `wpzstudio-sync` skill (`C:/Users/wupin/.qoder-cn/skills/wpzstudio-sync/`).
This file is the repo-side spec. When they disagree, the live repo
(`tools/`, `.github/workflows/`, `_data/`) wins.
