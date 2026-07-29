import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAGE_URL = "https://www.poewiki.net/wiki/List_of_divination_cards";
const API_URL = "https://www.poewiki.net/api.php";
const SUPABASE_LEAGUES_FUNCTION = "v2-get-leagues";
const USER_AGENT =
  "fateweaver/0.0.0 (https://github.com/navali-creations/fateweaver)";
const MAX_PROVIDER_RESPONSE_BYTES = 128 * 1024;
const SUPABASE_SESSION_PATH = path.join(
  __dirname,
  ".supabase-session.json",
);
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
 *  2. Supabase v2-get-leagues
 *  3. Checked-in leagues.json
 *  4. Fall back to generic "cards.json" (no league suffix)
 */
async function resolveLeague() {
  if (cliArgs.league) return cliArgs.league;

  try {
    const league = await resolveLeagueFromSupabase();
    console.error(`  ✓ Auto-detected league from Supabase: ${league}`);
    return league;
  } catch (error) {
    console.error(
      `  ⚠ Supabase league lookup failed; falling back to leagues.json (${error.message})`,
    );
  }

  // Fall back to the checked-in league snapshot.
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

async function resolveLeagueFromSupabase() {
  const supabaseUrl = normalizeSupabaseUrl(
    process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "",
  );
  const publishableKey = (
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    ""
  ).trim();
  if (!publishableKey) {
    throw new Error("Supabase publishable key is not configured");
  }
  const appVersionHeader = process.env.APP_VERSION_HEADER?.trim();
  if (!appVersionHeader) {
    throw new Error("APP_VERSION_HEADER is not configured");
  }

  const accessToken = await getSupabaseAccessToken(
    supabaseUrl,
    publishableKey,
  );

  const leagueResponse = await fetch(
    `${supabaseUrl}/functions/v1/${SUPABASE_LEAGUES_FUNCTION}`,
    {
      body: JSON.stringify({ game: "poe1" }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        apikey: publishableKey,
        "x-app-version": appVersionHeader,
      },
      method: "POST",
      signal: AbortSignal.timeout(15000),
    },
  );
  const data = await parseProviderJson(
    leagueResponse,
    "Supabase league request failed",
  );
  const activeLeagues = data.leagues.filter(
    (league) => league.game === "poe1" && league.isActive,
  );
  if (activeLeagues.length === 0) {
    throw new Error("Supabase returned no active PoE 1 leagues");
  }

  const hasCurrentFlags = activeLeagues.some((league) =>
    Object.hasOwn(league, "isCurrent"),
  );
  if (hasCurrentFlags) {
    const current = activeLeagues.filter(
      (league) => league.isCurrent === true,
    );
    if (current.length !== 1) {
      throw new Error(
        `Supabase returned ${current.length} current PoE 1 leagues`,
      );
    }
    return current[0].name.trim();
  }

  const nonStandard = activeLeagues.filter(
    (league) =>
      league.leagueId.toLowerCase() !== "standard" &&
      league.name.toLowerCase() !== "standard",
  );
  const candidates = nonStandard.length > 0 ? nonStandard : activeLeagues;
  return candidates
    .reduce((current, league) =>
      getTimestampSortValue(league.startAt) >
      getTimestampSortValue(current.startAt)
        ? league
        : current,
    )
    .name.trim();
}

async function getSupabaseAccessToken(supabaseUrl, publishableKey) {
  const storedSession = await loadSupabaseSession();
  if (storedSession?.supabase_url === supabaseUrl) {
    const refreshResponse = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        body: JSON.stringify({
          refresh_token: storedSession.refresh_token,
        }),
        headers: createSupabaseAuthHeaders(publishableKey),
        method: "POST",
        signal: AbortSignal.timeout(15000),
      },
    );

    if (![400, 401, 403].includes(refreshResponse.status)) {
      const auth = await parseProviderJson(
        refreshResponse,
        "Supabase session refresh failed",
      );
      await saveSupabaseSession(supabaseUrl, auth, storedSession.user_id);
      console.error("  ✓ Reused stored Supabase session");
      return auth.access_token;
    }

    await fs.rm(SUPABASE_SESSION_PATH, { force: true });
  }

  const authResponse = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    body: JSON.stringify({
      data: {},
      gotrue_meta_security: {},
    }),
    headers: createSupabaseAuthHeaders(publishableKey),
    method: "POST",
    signal: AbortSignal.timeout(15000),
  });
  const auth = await parseProviderJson(
    authResponse,
    "Supabase anonymous authentication failed",
  );
  await saveSupabaseSession(supabaseUrl, auth);
  console.error("  ✓ Created and saved anonymous Supabase session");
  return auth.access_token;
}

function createSupabaseAuthHeaders(publishableKey) {
  return {
    Authorization: `Bearer ${publishableKey}`,
    "Content-Type": "application/json",
    apikey: publishableKey,
  };
}

async function loadSupabaseSession() {
  try {
    return JSON.parse(await fs.readFile(SUPABASE_SESSION_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      await fs.rm(SUPABASE_SESSION_PATH, { force: true });
    }
    return null;
  }
}

async function saveSupabaseSession(supabaseUrl, auth, fallbackUserId = null) {
  await fs.writeFile(
    SUPABASE_SESSION_PATH,
    JSON.stringify(
      {
        supabase_url: supabaseUrl,
        refresh_token: auth.refresh_token,
        user_id: auth.user?.id ?? fallbackUserId,
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
}

function normalizeSupabaseUrl(value) {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("Supabase URL is not configured");
  }

  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Supabase URL is invalid");
  }

  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    url.hostname,
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("Supabase URL must use HTTPS");
  }

  return normalized;
}

async function parseProviderJson(response, failureMessage) {
  if (!response.ok) {
    throw new Error(`${failureMessage} (${response.status})`);
  }

  const declaredSize = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredSize) &&
    declaredSize > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new Error(`${failureMessage}: response is too large`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error(`${failureMessage}: response is too large`);
  }

  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new Error(`${failureMessage}: invalid JSON response`);
  }
}

function getTimestampSortValue(value) {
  if (typeof value !== "string") return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

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
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
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

  // MediaWiki's parse API returns header cells in a regular <tr>, without
  // wrapping them in <thead>.
  const $headerRow = $table
    .find("tr")
    .filter((_, tr) => $(tr).children("th").length > 0)
    .first();
  const headerTexts = $headerRow
    .children("th")
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

  console.error("\nStep 2: Fetching card data from PoE Wiki API...");
  const apiUrl = new URL(API_URL);
  apiUrl.search = new URLSearchParams({
    action: "parse",
    page: "List_of_divination_cards",
    prop: "text",
    format: "json",
    formatversion: "2",
  });
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(
      `PoE Wiki API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(
      `PoE Wiki API error: ${payload.error.code}: ${payload.error.info}`,
    );
  }

  const html = payload.parse?.text;
  if (typeof html !== "string") {
    throw new Error("PoE Wiki API response did not contain parsed page HTML");
  }

  console.error(
    `  ✓ Parsed HTML received, size: ${(html.length / 1024).toFixed(2)} KB`,
  );

  const $ = cheerio.load(html);

  // ------------------------------------------------------------------
  // Step 3: Parse ALL tables on the page
  // ------------------------------------------------------------------
  console.error("\nStep 3: Finding and parsing all tables...");

  const $tables = $("table.wikitable");
  console.error(`  ✓ Found ${$tables.length} wikitable(s)`);
  if ($tables.length === 0) {
    throw new Error("PoE Wiki response did not contain any card tables");
  }

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
  if (allCards.length === 0 || byName.size !== allCards.length) {
    throw new Error(
      `Invalid card data: parsed ${allCards.length} rows with ${byName.size} unique names`,
    );
  }
  if (
    previousCards.length > 0 &&
    allCards.length < Math.floor(previousCards.length * 0.8)
  ) {
    throw new Error(
      `Refusing to replace ${previousCards.length} previous cards with only ${allCards.length} parsed cards`,
    );
  }

  // ------------------------------------------------------------------
  // Step 4: Enrich from inline hoverboxes (images + flavour text)
  // ------------------------------------------------------------------
  console.error("\nStep 4: Finding card art and flavour text...");
  const $divinationCards = $(".item-box.-divicard");
  console.error(`  ✓ Found ${$divinationCards.length} card hoverboxes`);
  if ($divinationCards.length === 0) {
    throw new Error("PoE Wiki response did not contain any card hoverboxes");
  }

  const downloadPromises = [];
  let foundImages = 0;
  let matchedCards = 0;
  let skippedExisting = 0;

  for (const divi of $divinationCards.toArray()) {
    const $divi = $(divi);
    const $header = $divi.find(".divicard-header").first();
    const name = $header.text().replace(/\s+/g, " ").trim();
    if (!name) continue;

    const target = byName.get(name);
    if (!target) continue;

    matchedCards++;

    const imgSrc = $divi.find(".divicard-art img").first().attr("src");
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
        const downloadPromise = downloadImage(imgUrl, filePath).catch((err) => {
          console.warn(`  ✗ Art download failed for "${name}": ${err.message}`);
        });
        downloadPromises.push(downloadPromise);
      }
    }

    const $flavour = $divi.find(".divicard-flavour").first();
    if ($flavour.length) {
      const inner = (
        $flavour.find("span").first().html() ??
        $flavour.html() ??
        ""
      ).trim();
      target.flavour_html = inner;
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

  console.error(`\nStep 5: Summary`);
  console.error(`  Total cards: ${allCards.length}`);
  console.error(`  Matched cards from hoverboxes: ${matchedCards}`);
  console.error(`  Images found: ${foundImages}`);
  console.error(`  Already downloaded (skipped): ${skippedExisting}`);
  console.error(`  New downloads queued: ${downloadPromises.length}`);
  if (matchedCards < Math.floor(allCards.length * 0.8)) {
    throw new Error(
      `Only ${matchedCards} of ${allCards.length} cards matched hoverbox data`,
    );
  }

  console.error(`\nStep 6: Downloading ${downloadPromises.length} images...`);
  if (downloadPromises.length > 0) {
    await Promise.allSettled(downloadPromises);
    console.error(`  ✓ Download complete!`);
  } else {
    console.error(`  ⚠ No new images to download!`);
  }

  // ------------------------------------------------------------------
  // Step 7: Write output
  // ------------------------------------------------------------------
  console.error("\nStep 7: Writing JSON...");

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
