#!/usr/bin/env node
/**
 * Enriches the current `cards-{league}.json` snapshot and `cards.json` with
 * `weight` and `from_boss` fields. Historical snapshots remain untouched.
 *
 * - Weights prefer Wraeclast Cards' observed `community_estimated_weight`.
 * - The checked-in Prohibited Library CSV is the offline weight fallback and
 *   remains the source of `from_boss`.
 * - `reference_weight` is deliberately ignored because Wraeclast Cards sources
 *   that field from this package.
 *
 * Usage:
 *   node poe1-generate-weights.mjs
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PKG_DATA_DIR = join(
  __dirname,
  "packages",
  "poe1-divination-cards",
  "data",
);

const CSV_PATH = join(PKG_DATA_DIR, "prohibited-library-weights.csv");
const WRAECLAST_INDEX_URL =
  "https://wraeclast.cards/data/drop-rates/index.json";
const USER_AGENT =
  "fateweaver/0.0.0 (https://github.com/navali-creations/fateweaver)";

// ---------------------------------------------------------------------------
// 1. Read & parse the CSV
// ---------------------------------------------------------------------------
const raw = readFileSync(CSV_PATH, "utf-8");
const lines = raw
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

if (lines.length < 3) {
  console.error("CSV has fewer than 3 lines – nothing to do.");
  process.exit(1);
}

// Parse CSV cells (handles commas inside quoted fields, just in case)
function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current); // last field
  return cells;
}

const header = parseCsvLine(lines[0]);

// ---------------------------------------------------------------------------
// 2. Determine the "active" league columns and locate the Ritual column
// ---------------------------------------------------------------------------

const RITUAL_COL_IDX = header.indexOf("Ritual");
if (RITUAL_COL_IDX === -1) {
  console.error('Could not find "Ritual" column in CSV header.');
  process.exit(1);
}

const ALL_SAMPLES = "All samples";
const allSamplesIdx = header.indexOf(ALL_SAMPLES);
if (allSamplesIdx === -1) {
  console.error(`Could not find "${ALL_SAMPLES}" column in CSV header.`);
  process.exit(1);
}

// Fixed metadata columns that are never leagues
const META_COLUMNS = new Set([
  "patch",
  "Bucket",
  "Faustus",
  "Ritual",
  "Ultimatum",
  "Sample Size",
]);

// A patch column looks like "3.18", "3.19", etc.
const isPatchColumn = (name) => /^\d+(\.\d+)*$/.test(name);

/** @type {{ name: string; idx: number }[]} */
const leagueColumns = [];

for (let i = 0; i < allSamplesIdx; i++) {
  const name = header[i];
  if (META_COLUMNS.has(name)) continue;
  if (isPatchColumn(name)) continue;
  leagueColumns.push({ name, idx: i });
}

if (leagueColumns.length === 0) {
  console.error("No active league columns found before 'All samples'.");
  process.exit(1);
}

console.log(
  `Found ${leagueColumns.length} league weight column(s): ${leagueColumns.map((c) => c.name).join(", ")}`,
);

// ---------------------------------------------------------------------------
// 3. Build a lookup: card_name -> { weight per league, from_boss }
// ---------------------------------------------------------------------------

/**
 * @type {Map<string, { from_boss: boolean; weights: Map<string, number> }>}
 */
const csvCards = new Map();

for (let r = 1; r < lines.length; r++) {
  const cells = parseCsvLine(lines[r]);
  const cardName = cells[0];

  // Skip the "Sample Size" metadata row and empty names
  if (cardName === "Sample Size" || !cardName) continue;

  const fromBoss =
    (cells[RITUAL_COL_IDX] ?? "").trim().toLowerCase() === "boss";

  /** @type {Map<string, number>} */
  const weights = new Map();

  for (const col of leagueColumns) {
    const rawVal = (cells[col.idx] ?? "").trim();
    if (rawVal === "") continue;

    const weight = Number(rawVal);
    if (Number.isNaN(weight)) {
      console.warn(
        `  ⚠ Skipping non-numeric weight "${rawVal}" for card "${cardName}" in league "${col.name}"`,
      );
      continue;
    }

    weights.set(col.name, weight);
  }

  csvCards.set(cardName, { from_boss: fromBoss, weights });
}

// ---------------------------------------------------------------------------
// 4. Wraeclast Cards community-weight source
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function loadCommunityWeights(leagueNames) {
  const datasets = new Map();

  try {
    const index = await fetchJson(WRAECLAST_INDEX_URL);
    const indexedLeagues = index.games?.poe1?.leagues;
    if (!Array.isArray(indexedLeagues)) {
      throw new Error("index does not contain games.poe1.leagues");
    }

    await Promise.all(
      [...leagueNames].map(async (leagueName) => {
        const league = indexedLeagues.find(
          (candidate) =>
            candidate.name?.toLowerCase() === leagueName.toLowerCase(),
        );
        if (!league?.url) return;

        try {
          const detailUrl = new URL(league.url, WRAECLAST_INDEX_URL);
          if (detailUrl.origin !== new URL(WRAECLAST_INDEX_URL).origin) {
            throw new Error(`refusing cross-origin detail URL ${detailUrl}`);
          }

          const data = await fetchJson(detailUrl);
          if (!Array.isArray(data.cards)) {
            throw new Error("league response does not contain a cards array");
          }

          const weights = new Map(
            data.cards.map((card) => [
              card.name,
              Number.isFinite(card.community_estimated_weight)
                ? card.community_estimated_weight
                : null,
            ]),
          );
          const estimateCount = [...weights.values()].filter(
            Number.isFinite,
          ).length;
          datasets.set(leagueName, { weights });
          console.log(
            `  ✔ ${leagueName}: ${estimateCount} community estimates from ${Number(data.league?.observed_total ?? 0).toLocaleString("en-US")} observations`,
          );
        } catch (error) {
          console.warn(
            `  ⚠ Could not load Wraeclast Cards weights for "${leagueName}": ${error.message}`,
          );
        }
      }),
    );
  } catch (error) {
    console.warn(
      `  ⚠ Could not load Wraeclast Cards index; using CSV weights (${error.message})`,
    );
  }

  return datasets;
}

// ---------------------------------------------------------------------------
// 5. Helpers to enrich card JSON
// ---------------------------------------------------------------------------

const latestWeightLeague = leagueColumns[leagueColumns.length - 1].name;
const weightLeagueNames = new Set(leagueColumns.map((column) => column.name));
const warnedFallbackLeagues = new Set();

function resolveWeightLeague(snapshotLeague) {
  if (weightLeagueNames.has(snapshotLeague)) return snapshotLeague;

  if (!warnedFallbackLeagues.has(snapshotLeague)) {
    warnedFallbackLeagues.add(snapshotLeague);
    console.warn(
      `  ⚠ No "${snapshotLeague}" CSV weight column; "${latestWeightLeague}" is available only as the offline/known-zero fallback`,
    );
  }
  return latestWeightLeague;
}

function enrichCardsFile(filePath, snapshotLeague, communityData) {
  if (!existsSync(filePath)) {
    console.warn(`  ⚠ ${filePath} does not exist – skipping.`);
    return;
  }

  const existing = readFileSync(filePath, "utf-8");
  const cards = JSON.parse(existing);
  let enriched = 0;
  const csvLeague = communityData
    ? weightLeagueNames.has(snapshotLeague)
      ? snapshotLeague
      : latestWeightLeague
    : resolveWeightLeague(snapshotLeague);

  for (const card of cards) {
    const csvEntry = csvCards.get(card.name);
    const csvWeight = csvEntry?.weights.get(csvLeague) ?? null;
    let weight;

    if (communityData) {
      if (card.is_disabled) {
        weight = 0;
      } else if (communityData.weights.has(card.name)) {
        weight = communityData.weights.get(card.name);
      } else {
        // Cards intentionally excluded from Stacked Decks are absent from the
        // observed dataset. Preserve a known zero, but not a stale nonzero.
        weight = csvWeight === 0 ? 0 : null;
      }
    } else {
      weight = csvWeight;
    }

    card.weight = weight;
    card.from_boss = csvEntry?.from_boss ?? false;
    if (weight !== null) enriched++;
  }

  const output = JSON.stringify(cards, null, 2) + "\n";
  if (existing.replace(/\r\n/g, "\n") !== output) {
    writeFileSync(filePath, output, "utf-8");
  }
  const filename = filePath.split(/[\\/]/).pop();
  const source = communityData ? "Wraeclast Cards" : `CSV ${csvLeague}`;
  console.log(
    `  ✔ ${filename}  (${enriched}/${cards.length} cards have weights; ${source})`,
  );
}

// ---------------------------------------------------------------------------
// 6. Find the current snapshot before modifying any files
// ---------------------------------------------------------------------------
const currentPath = join(PKG_DATA_DIR, "cards.json");
const currentRaw = readFileSync(currentPath, "utf-8");
const leagueSnapshots = readdirSync(PKG_DATA_DIR)
  .map((filename) => {
    const match = /^cards-(.+)\.json$/.exec(filename);
    return match
      ? {
          name: match[1],
          path: join(PKG_DATA_DIR, filename),
        }
      : null;
  })
  .filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name));

const currentSnapshot = leagueSnapshots.find(
  (snapshot) => readFileSync(snapshot.path, "utf-8") === currentRaw,
);

// ---------------------------------------------------------------------------
// 7. Load community weights for the current snapshot
// ---------------------------------------------------------------------------
if (!currentSnapshot) {
  throw new Error(
    "Could not match cards.json to a league snapshot; refusing to update weights",
  );
}

const currentLeague = currentSnapshot.name;
console.log(`\nUsing current league "${currentLeague}" for weights`);

console.log("\nLoading Wraeclast Cards community weights...");
const communityWeights = await loadCommunityWeights(new Set([currentLeague]));
const currentCommunityWeights = communityWeights.get(currentLeague);

// ---------------------------------------------------------------------------
// 8. Enrich only the current league snapshot and cards.json
// ---------------------------------------------------------------------------
enrichCardsFile(
  currentSnapshot.path,
  currentLeague,
  currentCommunityWeights,
);

enrichCardsFile(
  currentPath,
  currentLeague,
  currentCommunityWeights,
);

console.log("\nDone.");
