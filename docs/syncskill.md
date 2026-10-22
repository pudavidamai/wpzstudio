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
apps-seed.json  ──fetch-catalog.mjs (v7.0 DisplayCatalog)──►  _data/wpz_apps.yml + .json
     ▲                                                                  │
     │ validate-pending.mjs (adds new ids)                             ▼
     │                                                        index.html {% for %}
apps-seed-pending.txt ──add-apps.yml──► commits to master ──►  rendered site
```

- `tools/apps-seed.json` — productId registry (the set to sync). ~54 entries.
- `tools/fetch-catalog.mjs` — regenerate `_data/wpz_apps.{json,yml}` from seed + DisplayCatalog.
- `tools/scripts/sync-report.mjs` — diff working `_data` vs `git HEAD`; prints `N→M (+new/-removed/changed/dead)`.
- `tools/scripts/seed-pending-add.mjs` — append a productId to `apps-seed-pending.txt` (validated, de-duped).
- `tools/scripts/validate-pending.mjs` — (CI) validate pending ids against DisplayCatalog + PublisherId, append to `apps-seed.json`.
- `.github/workflows/sync-catalog.yml` — weekly cron + dispatch: fetch-catalog → open a **PR** if `_data` changed.
- `.github/workflows/add-apps.yml` — push touching `apps-seed-pending.txt`: validate → seed → fetch-catalog → commit to **master**.

`index.html` renders `site.data.wpz_apps` via `{%- for app in site.data.wpz_apps -%}`;
it has no hardcoded `apps` array. The `README.*` files are prose only (no
product tables). Neither is edited during a catalog sync.

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
   开发人员工具 / 教育 / 娱乐 / 照片与视频`.
4. Category is locale-localized. Use `market=CN&locale=zh-CN`. HK (`生產力`) and
   US (`Productivity`) labels are the same category in another locale — not a change.
5. Currency label ≠ price: site `HK$14.00` vs store `¥14.00` with equal digits is
   a label difference, not a price diff. Only a digit shift is real.
6. `"Free"` / `"免费下载"` / `"Included"` are equivalent — not a diff; keep local style.
7. Preserve the bilingual pattern (`description` zh, `descriptionEn` en).
8. Keep product names aligned with the live listing unless a documented
   localization choice says otherwise.
9. A sync commit touches only `_data/*` (and `apps-seed.json` / `apps-seed-pending.txt`
   when adding an app) — never unrelated layout/styling.

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
