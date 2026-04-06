import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import * as cheerio from "cheerio";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAGE_URL = "https://www.poewiki.net/wiki/List_of_divination_cards";
const PKG_DATA_DIR = path.resolve(
  __dirname,
  "packages/poe1-divination-cards/data",
);
const OUT_IMAGES_DIR = path.join(PKG_DATA_DIR, "images");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  options: {
    league: { type: "string", short: "l" },
  },
  strict: false,
  allowPositionals: true,
});

/**
 * Resolve the league name:
 *  1. Explicit `-l <league>` flag
 *  2. Auto-detect from leagues.json (latest active poe1 league)
 *  3. Fall back to generic "cards.json" (no league suffix)
 */
async function resolveLeague() {
  if (cliArgs.league) return cliArgs.league;

  // Try to auto-detect from leagues.json
  const leaguesPath = path.join(__dirname, "leagues.json");
  try {
    const raw = await fs.readFile(leaguesPath, "utf-8");
    const leagues = JSON.parse(raw);
    const active = leagues
      .filter(
        (l) => l.game === "poe1" && l.is_active && l.league_id !== "Standard",
      )
      .sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
    if (active.length > 0) {
      console.error(
        `  ✓ Auto-detected league from leagues.json: ${active[0].name}`,
      );
      return active[0].name;
    }
  } catch {
    // leagues.json doesn't exist or is invalid — that's fine
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a filename-safe slug, but keep it readable */
function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

function absUrl(src) {
  if (!src) return null;
  try {
    return new URL(src, PAGE_URL).toString();
  } catch {
    return null;
  }
}

async function downloadImage(url, filePath) {
  console.error(`  Downloading: ${path.basename(filePath)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url} (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);
  console.error(`  ✓ Saved: ${path.basename(filePath)}`);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function guessExtFromUrl(url) {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname);
    if (ext && ext.length <= 5) return ext;
  } catch {}
  return ".png";
}

/**
 * Try to find the most recent previous league file so we can carry forward
 * descriptions for disabled cards.
 */
async function loadPreviousLeagueCards(currentLeagueFilename) {
  const files = await fs.readdir(PKG_DATA_DIR);
  const leagueFiles = files
    .filter(
      (f) =>
        /^cards-.+\.json$/.test(f) &&
        f !== "cards.json" &&
        f !== currentLeagueFilename,
    )
    .sort();

  // Walk backwards through the sorted files, loading each until we find one
  // with content. The "current" league file might already exist but be empty.
  for (let i = leagueFiles.length - 1; i >= 0; i--) {
    try {
      const raw = await fs.readFile(
        path.join(PKG_DATA_DIR, leagueFiles[i]),
        "utf-8",
      );
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        console.error(
          `  ✓ Loaded previous league data from: ${leagueFiles[i]} (${data.length} cards)`,
        );
        return data;
      }
    } catch {
      // skip unreadable files
    }
  }

  console.error(
    "  ⚠ No previous league data found — disabled card descriptions may be lost",
  );
  return [];
}

// ---------------------------------------------------------------------------
// Table parsing helpers
// ---------------------------------------------------------------------------

function findColumnIndices($, $table) {
  let idxItem = 0;
  let idxStack = 1;
  let idxDesc = 2;

  const headerTexts = $table
    .find("thead tr")
    .first()
    .find("th")
    .toArray()
    .map((th) => $(th).text().trim().toLowerCase());

  const findIdx = (names) => {
    for (const n of names) {
      const i = headerTexts.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };

  const iItem = findIdx(["item"]);
  const iStack = findIdx(["stack size", "stacksize", "stack"]);
  const iDesc = findIdx(["description"]);

  if (iItem !== -1) idxItem = iItem;
  if (iStack !== -1) idxStack = iStack;
  if (iDesc !== -1) idxDesc = iDesc;

  return { idxItem, idxStack, idxDesc, headerTexts };
}

/**
 * Parse rows from a wikitable into card objects.
 * Returns an array of { name, stack_size, description, reward_html, art_src, flavour_html }
 */
function parseTableRows($, $table, { idxItem, idxStack, idxDesc }) {
  const rows = [];

  $table.find("tbody tr").each((_, tr) => {
    const $tds = $(tr).find("td");
    if ($tds.length < 3) return;

    const $nameTd = $tds.eq(idxItem);
    const name = $nameTd.find("a").first().text().trim();
    if (!name) return;

    const $stackTd = $tds.eq(idxStack);
    const sortStack = $stackTd.attr("data-sort-value");
    const stack_size = Number.parseInt(sortStack ?? $stackTd.text().trim(), 10);
    if (!Number.isFinite(stack_size)) return;

    const $descTd = $tds.eq(idxDesc);
    const sortReward = $descTd.attr("data-sort-value");
    const reward_html = (sortReward ?? $descTd.html() ?? "").trim();
    const description = $descTd.text().replace(/\s+/g, " ").trim();

    rows.push({
      name,
      stack_size,
      description,
      reward_html,
      art_src: slugify(name),
      flavour_html: "",
    });
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const league = await resolveLeague();
  const leagueSuffix = league ? `-${league}` : "";
  const outJsonPath = path.join(PKG_DATA_DIR, `cards${leagueSuffix}.json`);
  const outCurrentPath = path.join(PKG_DATA_DIR, "cards.json");

  console.error("Step 1: Creating output directories...");
  await fs.mkdir(OUT_IMAGES_DIR, { recursive: true });
  console.error(`  ✓ Images dir: ${OUT_IMAGES_DIR}`);
  console.error(`  ✓ JSON path:  ${outJsonPath}`);
  if (league) {
    console.error(`  ✓ League:     ${league}`);
  }

  // Load previous league data for carrying forward disabled card descriptions
  console.error("\nStep 1b: Loading previous league data...");
  const currentLeagueFilename = league ? `cards-${league}.json` : null;
  const previousCards = await loadPreviousLeagueCards(currentLeagueFilename);
  const previousByName = new Map(previousCards.map((c) => [c.name, c]));

  console.error("\nStep 2: Launching headless browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const resourceType = req.resourceType();
    if (["font", "stylesheet"].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  console.error(`  ✓ Browser launched`);

  console.error("\nStep 3: Fetching page from PoE Wiki...");
  try {
    await page.goto(PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    console.error(`  ✓ Page loaded (DOM ready)`);

    console.error("  Waiting for main table...");
    await page.waitForSelector("table.wikitable", { timeout: 10000 });
    console.error(`  ✓ Table found`);

    console.error("  Waiting 5 seconds for dynamic content...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.error(`  ✓ Wait complete`);

    const html = await page.content();
    console.error(
      `  ✓ HTML extracted, size: ${(html.length / 1024).toFixed(2)} KB`,
    );

    await browser.close();
    console.error(`  ✓ Browser closed`);

    const $ = cheerio.load(html);

    // ------------------------------------------------------------------
    // Step 4: Parse ALL tables on the page
    // ------------------------------------------------------------------
    console.error("\nStep 4: Finding and parsing all tables...");

    const $tables = $("table.wikitable");
    console.error(`  ✓ Found ${$tables.length} wikitable(s)`);

    // The page structure is:
    //   <h2> Divination cards </h2>
    //     <table> ... main active cards ... </table>
    //   <h3> Drop-disabled </h3>
    //     <p> ... explanation ... </p>
    //     <table> ... drop-disabled cards (still have rewards) ... </table>
    //     <p> ... explanation about reward-disabled ... </p>
    //     <table> ... reward-disabled cards (description says "Disabled") ... </table>

    const allCards = [];
    const byName = new Map();

    // Determine the category for each table.
    // The wiki page has a consistent structure:
    //   Table 1: active/droppable cards (has 4 columns incl. droplevel)
    //   Table 2: drop-disabled cards (3 columns, real rewards still shown)
    //   Table 3: reward-disabled cards (3 columns, description says "Disabled")
    // We use table index as the primary signal and validate with content checks.
    $tables.each((tableIdx, tableEl) => {
      const $table = $(tableEl);
      const indices = findColumnIndices($, $table);

      let category = "active";

      if (tableIdx > 0) {
        // Any table beyond the first is a disabled table.
        // Check if any row has description "Disabled" to distinguish the two types.
        let hasDisabledRows = false;
        $table.find("tbody tr").each((_, tr) => {
          const $tds = $(tr).find("td");
          if ($tds.length >= 3) {
            const descText = $tds.eq(indices.idxDesc).text().trim();
            if (descText === "Disabled") hasDisabledRows = true;
          }
        });

        category = hasDisabledRows ? "reward-disabled" : "drop-disabled";
      }

      console.error(
        `  Table ${tableIdx + 1}: ${indices.headerTexts.join(", ")} → category: ${category}`,
      );

      const rows = parseTableRows($, $table, indices);

      for (const row of rows) {
        if (category === "active") {
          row.is_disabled = false;
        } else if (category === "drop-disabled") {
          row.is_disabled = true;
        } else if (category === "reward-disabled") {
          row.is_disabled = true;

          // The wiki shows "Disabled" as description — carry forward from previous league
          if (
            row.description === "Disabled" ||
            row.reward_html === "Disabled"
          ) {
            const prev = previousByName.get(row.name);
            if (prev) {
              console.error(
                `    ✓ Carrying forward description for disabled card: ${row.name}`,
              );
              row.description = prev.description;
              row.reward_html = prev.reward_html;
              // Also carry forward flavour if we have it
              if (prev.flavour_html) {
                row.flavour_html = prev.flavour_html;
              }
              // Carry forward art_src
              if (prev.art_src) {
                row.art_src = prev.art_src;
              }
            } else {
              console.error(
                `    ⚠ No previous data for disabled card: ${row.name} — description will remain "Disabled"`,
              );
            }
          }
        }

        allCards.push(row);
        byName.set(row.name, row);
      }
    });

    console.error(`  ✓ Total cards parsed: ${allCards.length}`);
    console.error(
      `    Active: ${allCards.filter((c) => !c.is_disabled).length}`,
    );

    // ------------------------------------------------------------------
    // Step 5: Enrich from hoverbox (images + flavour text)
    // ------------------------------------------------------------------
    console.error("\nStep 5: Looking for hoverbox with card images...");
    const $hover = $(".hoverbox-display-container").first();

    if (!$hover.length) {
      console.error("  ⚠ No .hoverbox-display-container found!");
    } else {
      console.error(`  ✓ Found .hoverbox-display-container`);
      const $spans = $hover.children("span");
      console.error(`  ✓ Found ${$spans.length} span children`);
    }

    const downloadPromises = [];
    let foundImages = 0;
    let matchedCards = 0;
    let processedSpans = 0;
    let skippedExisting = 0;

    if ($hover.length) {
      for (const span of $hover.children("span").toArray()) {
        const $span = $(span);
        processedSpans++;

        const $divi = $span.find('[class$="-divicard"]').first().length
          ? $span.find('[class$="-divicard"]').first()
          : $span.find('[class*="divicard"]').first();

        if (!$divi.length) continue;

        const $header = $span.find(".divicard-header").first();
        const name = $header.text().replace(/\s+/g, " ").trim();
        if (!name) continue;

        const target = byName.get(name);
        if (!target) continue;

        matchedCards++;

        let imgSrc = $header.find("img").first().attr("src");
        if (!imgSrc) imgSrc = $divi.find("img").first().attr("src");
        if (!imgSrc) imgSrc = $span.find("img").first().attr("src");

        const imgUrl = absUrl(imgSrc);

        if (!imgSrc) {
          // Skip silently
        } else if (!imgUrl) {
          console.error(`  [${name}] Could not parse img URL from: ${imgSrc}`);
        } else {
          foundImages++;
          const ext = guessExtFromUrl(imgUrl);
          const filename = `${slugify(name)}${ext}`;
          const filePath = path.join(OUT_IMAGES_DIR, filename);

          target.art_src = filename;

          const exists = await fileExists(filePath);
          if (exists) {
            skippedExisting++;
          } else {
            const downloadPromise = downloadImage(imgUrl, filePath).catch(
              (err) => {
                console.warn(
                  `  ✗ Art download failed for "${name}": ${err.message}`,
                );
              },
            );
            downloadPromises.push(downloadPromise);
          }
        }

        const $flavour = $span.find(".divicard-flavour").first();
        if ($flavour.length) {
          const inner = (
            $flavour.find("span").first().html() ??
            $flavour.html() ??
            ""
          ).trim();
          target.flavour_html = inner;
        }
      }
    }

    // For disabled cards that weren't in the hoverbox, try to carry forward
    // art_src and flavour from previous league data
    for (const card of allCards) {
      if (card.is_disabled) {
        const prev = previousByName.get(card.name);
        if (prev) {
          if (!card.flavour_html && prev.flavour_html) {
            card.flavour_html = prev.flavour_html;
          }
          // If art_src is still just the slugified name (no extension), use previous
          if (prev.art_src && !card.art_src.includes(".")) {
            card.art_src = prev.art_src;
          }
        }
      }
    }

    console.error(`\nStep 6: Summary`);
    console.error(`  Total cards: ${allCards.length}`);
    console.error(`  Processed spans: ${processedSpans}`);
    console.error(`  Matched cards from hoverbox: ${matchedCards}`);
    console.error(`  Images found: ${foundImages}`);
    console.error(`  Already downloaded (skipped): ${skippedExisting}`);
    console.error(`  New downloads queued: ${downloadPromises.length}`);

    console.error(`\nStep 7: Downloading ${downloadPromises.length} images...`);
    if (downloadPromises.length > 0) {
      await Promise.allSettled(downloadPromises);
      console.error(`  ✓ Download complete!`);
    } else {
      console.error(`  ⚠ No new images to download!`);
    }

    // ------------------------------------------------------------------
    // Step 8: Write output
    // ------------------------------------------------------------------
    console.error("\nStep 8: Writing JSON...");

    const output = JSON.stringify(allCards, null, 2);

    // Write league-specific file
    await fs.writeFile(outJsonPath, output);
    console.error(`  ✓ Written to: ${outJsonPath}`);

    // Also write/overwrite cards.json as the "current" data
    if (outJsonPath !== outCurrentPath) {
      await fs.writeFile(outCurrentPath, output);
      console.error(`  ✓ Also written to: ${outCurrentPath}`);
    }

    console.error("\n✓ Done!");
  } catch (error) {
    await browser.close();
    throw error;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
