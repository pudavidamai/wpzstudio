// Generate localized (ja/ko/de/fr) product descriptions from the Chinese
// `description` field in `_data/wpz_apps.json`, using the free MyMemory
// translation API. Results are cached to `_data/wpz_apps_i18n.json` keyed by
// productId, so this script is safe to re-run (it skips already-translated
// entries) and the main catalog sync (fetch-catalog.mjs) never overwrites it.
//
// Resilient: splits texts longer than the API's 500-char limit into chunks,
// retries transient / rate-limit errors with backoff, and skips (rather than
// aborts) any entry it cannot translate so a partial run still persists.
//
// Usage: node tools/translate-i18n.mjs
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const appsPath = path.join(root, "_data", "wpz_apps.json");
const outPath = path.join(root, "_data", "wpz_apps_i18n.json");

const LANGS = ["ja", "ko", "de", "fr"];
const PAIRS = { ja: "zh|ja", ko: "zh|ko", de: "zh|de", fr: "zh|fr" };
const MAX_CHARS = 450; // stay under MyMemory's 500-char query limit

const apps = JSON.parse(fs.readFileSync(appsPath, "utf-8"));
let i18n = fs.existsSync(outPath)
  ? JSON.parse(fs.readFileSync(outPath, "utf-8"))
  : {};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Split into chunks <= MAX_CHARS, preferring sentence boundaries.
function splitChunks(text) {
  const segs = text.match(/[^。！？!?\n]+[。！？!?\n]?/g) || [text];
  const parts = [];
  let buf = "";
  for (const s of segs) {
    if ((buf + s).length <= MAX_CHARS) {
      buf += s;
    } else {
      if (buf) parts.push(buf);
      if (s.length > MAX_CHARS) {
        for (let i = 0; i < s.length; i += MAX_CHARS) {
          parts.push(s.slice(i, i + MAX_CHARS));
        }
        buf = "";
      } else {
        buf = s;
      }
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

function translateOnce(text, pair) {
  return new Promise((resolve, reject) => {
    const q = encodeURIComponent(text);
    const url = `https://api.mymemory.translated.net/get?q=${q}&langpair=${pair}`;
    const req = https.get(
      url,
      { headers: { "User-Agent": "wpzstudio-i18n/1.0" } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (d.trimStart().startsWith("<")) {
            reject(new Error("HTML:" + d.slice(0, 60)));
            return;
          }
          try {
            const j = JSON.parse(d);
            if (
              j.responseStatus === 200 &&
              j.responseData &&
              j.responseData.translatedText
            ) {
              resolve(j.responseData.translatedText);
            } else if (j.responseStatus === 429 || j.responseStatus === 403) {
              const det =
                (j.responseDetails || "") +
                (j.responseData && j.responseData.translatedText
                  ? j.responseData.translatedText
                  : "");
              // "ALL AVAILABLE FREE TRANSLATIONS" => daily quota exhausted: stop.
              // Any other 429/403 => transient rate-limit: let caller retry.
              if (/ALL AVAILABLE FREE TRANSLATIONS/i.test(det)) {
                reject(new Error("QUOTA:" + j.responseStatus));
              } else {
                reject(new Error("RETRY:" + j.responseStatus));
              }
            } else {
              reject(
                new Error(
                  "API:" +
                    (j.responseStatus || "unknown") +
                    " " +
                    JSON.stringify(j).slice(0, 120)
                )
              );
            }
          } catch (e) {
            reject(new Error("PARSE:" + d.slice(0, 60)));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("TIMEOUT")));
  });
}

async function translate(text, pair) {
  const chunks = splitChunks(text);
  const out = [];
  for (const chunk of chunks) {
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        out.push(await translateOnce(chunk, pair));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (e.message.startsWith("QUOTA")) throw e; // daily/rate quota — bail
        await sleep(attempt === 1 ? 1500 : 4000 * attempt);
      }
    }
    if (lastErr) throw lastErr;
    await sleep(300); // small gap between chunks of the same text
  }
  return out.join("");
}

let count = 0;
let skipped = 0;
let failed = 0;

for (const app of apps) {
  const pid = app.productId;
  if (!pid) continue;
  const src = app.description;
  if (!src || !src.trim()) continue;
  if (!i18n[pid]) i18n[pid] = {};

  for (const lang of LANGS) {
    if (i18n[pid][lang]) {
      skipped++;
      continue;
    }
    try {
      const t = await translate(src, PAIRS[lang]);
      i18n[pid][lang] = t;
      count++;
      fs.writeFileSync(outPath, JSON.stringify(i18n, null, 2));
      await sleep(1000); // pace under ~1 req/s to avoid 429
    } catch (e) {
      failed++;
      console.error(`FAIL ${pid} ${lang}: ${e.message}`);
      if (e.message.startsWith("QUOTA")) {
        console.error("Quota/rate-limit hit — stopping. Re-run later to resume.");
        process.exit(2);
      }
      await sleep(1500);
    }
  }
}

console.log(`Done. translated=${count} skipped=${skipped} failed=${failed}`);
