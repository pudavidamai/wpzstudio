# Windows Store Product Sync Skill

## Purpose

Synchronize the local WPZ Studio website with the current public products under the WPZStudio publisher account on Microsoft Store.

## When To Use

Use this workflow when any of the following is true:

- A new app has been published on Microsoft Store under WPZStudio.
- An existing app has changed name, cover image, price label, category, or store link.
- The local website is missing products that are already live online.
- The local website still shows placeholder products or stale product metadata.
- You need to commit the synchronized website changes and publish them.

## Source Of Truth

The source of truth is the current online publisher listing:

- https://apps.microsoft.com/search/publisher?name=WPZStudio&hl=zh-CN&gl=CN

If the publisher search page does not fully load in a non-browser fetch, use a browser-capable path and inspect each live product card or detail page as needed. Do not treat local placeholders as truth when they conflict with the online store.

## Required Outputs

After the workflow finishes:

- Every currently live WPZStudio Microsoft Store product is represented on the local website.
- Removed or unpublished products are either removed from the active catalog or clearly handled as intentional exceptions.
- Placeholder entries with empty store links are either completed from the online store or removed.
- Store links point to the correct Microsoft Store detail pages.
- The git changes are committed on the current branch and pushed to origin/master.

## Local Files To Update

Primary update targets:

- index.html
  - Update the `apps` array near the top-level script block.
  - Keep each product object complete: `name`, `category`, `price`, `desc`, `descEn`, `image`, `link`.
  - This file controls the current homepage app catalog.

- README.md
- README.en.md
- README.de.md
- README.fr.md
- README.ja.md
- README.ko.md
  - Update the representative product lists when the live catalog materially changes.
  - Keep category groupings aligned with the current homepage catalog.

Secondary review target:

- _posts/2014-3-3-Hello-World.html
  - This file contains an older hardcoded product showcase.
  - If it is still published and visibly stale, sync or trim it so the site does not present conflicting product information.

## Sync Rules

1. Read all currently visible products from the WPZStudio publisher page.
2. For each live product, capture at minimum:
   - Product name
   - Microsoft Store detail link
   - Cover image URL if available
   - Price label shown publicly
   - Best-fit category for this site
3. Compare the live product set against the local `apps` array in index.html.
4. Add products that exist online but not locally.
5. Update products whose names, links, images, or price labels differ.
6. Remove clearly fake, placeholder, or unpublished entries unless there is an explicit reason to keep them.
7. Keep product descriptions concise and marketing-safe.
8. Preserve the existing bilingual pattern:
   - `desc` for Chinese
   - `descEn` for English
9. Reuse the existing site category vocabulary unless a new category is required:
   - 高效工作
   - 实用程序与工具
   - 开发人员工具
   - 教育
   - 娱乐
   - 照片与视频
10. Keep product names exactly aligned with the live Microsoft Store listing unless there is a deliberate, documented localization choice.

## Execution Steps

### 1. Collect The Online Catalog

- Open the publisher page.
- Enumerate all visible product cards.
- Follow detail pages when the publisher listing omits data needed for synchronization.
- Build a normalized product list for comparison.

### 2. Update The Homepage Catalog

- Edit index.html.
- Replace stale values inside the `apps` array.
- Ensure all live apps have valid `link` values.
- Fill `image` when the store exposes a stable cover URL.
- Keep the array sorted in a stable, human-maintainable way, preferably by product name.

### 3. Update Supporting Copy

- Review the multilingual README files.
- Update the category product summaries if the catalog changed enough to make the current lists misleading.
- Review the legacy showcase post and remove contradictions with the active homepage catalog.

### 4. Validate Before Commit

- Confirm every app card on the homepage can open a real Microsoft Store page.
- Confirm there are no leftover placeholder links such as empty strings or `#`.
- Confirm no removed product still appears in active site copy unless intentionally retained.
- Confirm product count and category grouping roughly match the online publisher catalog.
- Review the git diff for only the intended sync changes.

### 5. Commit And Publish

Use a focused commit message, for example:

```text
sync: refresh Microsoft Store product catalog
```

Then publish with the repository's normal flow:

```powershell
git add index.html README.md README.en.md README.de.md README.fr.md README.ja.md README.ko.md _posts/2014-3-3-Hello-World.html
git commit -m "sync: refresh Microsoft Store product catalog"
git push origin master
```

If only a subset of those files changed, commit only the files that were actually updated.

## Guardrails

- Do not invent products that are not live on Microsoft Store.
- Do not keep placeholder products with missing links just to pad the catalog.
- Do not rewrite unrelated layout, styling, or site structure during a sync pass.
- Do not change product categories casually; prefer continuity unless the existing category is clearly wrong.
- Do not publish if the working tree contains unrelated changes that should not be included in the sync commit.

## Completion Checklist

- Online WPZStudio products were fully enumerated.
- Local homepage catalog matches the live store.
- Supporting product summaries were reviewed and updated where needed.
- Placeholder or stale product entries were resolved.
- Changes were validated.
- Changes were committed and pushed.