#!/usr/bin/env node
/**
 * Updates only `weight` in the current league snapshot and `cards.json` using
 * Wraeclast Cards' observed `community_estimated_weight`. Historical snapshots
 * and all other card fields remain untouched. `reference_weight` is ignored
 * because Wraeclast Cards sources it from this package. Numeric weights have
 * a minimum of 1; unknown estimates remain null.
 *
 * Usage:
 *   pnpm weights:poe1 [--league <name>]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DATA_DIR = join(__dirname, "packages", "poe1-divination-cards", "data");
const WRAECLAST_INDEX_URL = "https://wraeclast-cards.pages.dev/data/drop-rates/index.json";
const USER_AGENT =
  "fateweaver/0.0.0 (https://github.com/navali-creations/fateweaver)";

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(
      `Wraeclast Cards request failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

async function loadCommunityWeights(leagueName) {
  const index = await fetchJson(WRAECLAST_INDEX_URL);
  const leagues = index.games?.poe1?.leagues;
  if (!Array.isArray(leagues)) {
    throw new Error("Wraeclast Cards index does not contain games.poe1.leagues");
  }
  const league = leagues.find(
    (candidate) =>
      typeof candidate?.name === "string" &&
      candidate.name.toLowerCase() === leagueName.toLowerCase(),
  );
  if (!league?.url) {
    throw new Error(`No Wraeclast Cards weights for "${leagueName}"`);
  }

  const detailUrl = new URL(league.url, WRAECLAST_INDEX_URL);
  if (detailUrl.origin !== new URL(WRAECLAST_INDEX_URL).origin) {
    throw new Error(`Refusing cross-origin detail URL ${detailUrl}`);
  }
  const data = await fetchJson(detailUrl);
  if (
    data.game !== "poe1" ||
    typeof data.league?.name !== "string" ||
    data.league.name.toLowerCase() !== leagueName.toLowerCase()
  ) {
    throw new Error(
      `Wraeclast Cards response does not match PoE 1 league "${leagueName}"`,
    );
  }
  if (!Array.isArray(data.cards) || data.cards.length === 0) {
    throw new Error(
      "Wraeclast Cards league response does not contain a nonempty cards array",
    );
  }

  const weights = new Map();
  for (const card of data.cards) {
    if (
      typeof card?.name !== "string" ||
      !card.name.trim() ||
      weights.has(card.name)
    ) {
      throw new Error(
        "Wraeclast Cards response contains an invalid or duplicate card name",
      );
    }
    const weight = card.community_estimated_weight;
    if (weight !== null && (!Number.isFinite(weight) || weight < 0)) {
      throw new Error(`Invalid community_estimated_weight for "${card.name}"`);
    }
    weights.set(card.name, weight);
  }
  return weights;
}

async function main(cliArgs) {
  const currentPath = join(PKG_DATA_DIR, "cards.json");
  const currentRaw = readFileSync(currentPath, "utf-8");
  const cards = JSON.parse(currentRaw);
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error("cards.json must contain a nonempty cards array");
  }
  const matchingSnapshots = readdirSync(PKG_DATA_DIR).filter((filename) => {
    const match = /^cards-(.+)\.json$/.exec(filename);
    return (
      match &&
      (!cliArgs.league || match[1] === cliArgs.league.trim()) &&
      readFileSync(join(PKG_DATA_DIR, filename), "utf-8") === currentRaw
    );
  });
  if (matchingSnapshots.length !== 1) {
    throw new Error(
      "Could not uniquely match cards.json to a league snapshot; refusing to update weights. " +
        "Use --league <name> to select the current snapshot explicitly. It must match cards.json.",
    );
  }
  const [snapshotFilename] = matchingSnapshots;
  const leagueName = /^cards-(.+)\.json$/.exec(snapshotFilename)[1];
  console.log(`Using current league "${leagueName}" for weights`);

  // Fetch and validate before changing either file. Source failures leave the
  // existing weights intact so a retry never needs an offline fallback.
  const weights = await loadCommunityWeights(leagueName);
  let estimated = 0;
  for (const card of cards) {
    if (card.is_disabled) {
      card.weight = 1;
    } else if (weights.has(card.name)) {
      card.weight = weights.get(card.name);
    } else {
      // Retain minimum weights for absent cards, including legacy zeros.
      // Other stale weights are cleared; missing estimates remain unknown.
      card.weight = card.weight === 0 || card.weight === 1 ? 1 : null;
    }
    if (card.weight !== null) {
      card.weight = Math.max(1, card.weight);
      estimated++;
    }
  }

  const output = JSON.stringify(cards, null, 2) + "\n";
  if (currentRaw.replace(/\r\n/g, "\n") !== output) {
    writeFileSync(join(PKG_DATA_DIR, snapshotFilename), output, "utf-8");
    writeFileSync(currentPath, output, "utf-8");
  }
  console.log(
    `Updated ${snapshotFilename} and cards.json (${estimated}/${cards.length} cards have weights; Wraeclast Cards)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: cliArgs } = parseArgs({
    options: { league: { type: "string", short: "l" } },
  });
  main(cliArgs).catch((error) => {
    console.error(`Weight update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
