#!/usr/bin/env node
/**
 * Reads `packages/poe1-divination-cards/data/prohibited-library-weights.csv`
 * and enriches the existing `cards-{league}.json` files and `cards.json`
 * with `weight` and `from_boss` fields.
 *
 * - League-specific files use weights from their respective CSV column.
 * - `cards.json` uses weights from the latest (rightmost) active league.
 *
 * Cards that exist in the JSON but not in the CSV will get
 * `weight: null` and `from_boss: false`.
 *
 * Usage:
 *   node poe1-generate-weights.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
  `Found ${leagueColumns.length} active league(s): ${leagueColumns.map((c) => c.name).join(", ")}`,
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
// 4. Helper to enrich a cards JSON file with weights from a given league
// ---------------------------------------------------------------------------

function enrichCardsFile(filePath, leagueName) {
  if (!existsSync(filePath)) {
    console.warn(`  ⚠ ${filePath} does not exist – skipping.`);
    return;
  }

  const cards = JSON.parse(readFileSync(filePath, "utf-8"));
  let enriched = 0;

  for (const card of cards) {
    const csvEntry = csvCards.get(card.name);

    if (csvEntry) {
      card.weight = csvEntry.weights.get(leagueName) ?? null;
      card.from_boss = csvEntry.from_boss;
      enriched++;
    } else {
      card.weight = null;
      card.from_boss = false;
    }
  }

  writeFileSync(filePath, JSON.stringify(cards, null, 2) + "\n", "utf-8");
  const filename = filePath.split(/[\\/]/).pop();
  console.log(
    `  ✔ ${filename}  (${enriched}/${cards.length} cards matched weights)`,
  );
}

// ---------------------------------------------------------------------------
// 5. Enrich each cards-{league}.json
// ---------------------------------------------------------------------------
for (const col of leagueColumns) {
  enrichCardsFile(join(PKG_DATA_DIR, `cards-${col.name}.json`), col.name);
}

// ---------------------------------------------------------------------------
// 6. Enrich cards.json using the latest (rightmost) active league
// ---------------------------------------------------------------------------
const latestLeague = leagueColumns[leagueColumns.length - 1];
console.log(`\nUsing latest league "${latestLeague.name}" for cards.json`);
enrichCardsFile(join(PKG_DATA_DIR, "cards.json"), latestLeague.name);

console.log("\nDone.");
