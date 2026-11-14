import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const cards = ["Observed", "Unobserved", "Excluded", "Disabled"].map((name) => ({
  name,
  stack_size: 1,
  description: "Reward",
  reward_html: "Reward",
  art_src: `${name}.png`,
  flavour_html: "Flavour",
  is_disabled: name === "Disabled",
}));
const rawCards = JSON.stringify(cards, null, 2);
const mirageCards = JSON.stringify(
  cards.map((card) => ({ ...card, weight: 999, from_boss: false })),
  null,
  2,
);

async function fixture(t, scenario = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "fateweaver-test-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("fateweaver-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const dataDir = path.join(directory, "packages/poe1-divination-cards/data");
  await fs.mkdir(path.join(dataDir, "images"), { recursive: true });
  await fs.symlink(path.join(ROOT, "node_modules"), path.join(directory, "node_modules"), "junction");
  for (const name of [
    "poe1-scrape-all-divination-cards.mjs",
    "poe1-generate-weights.mjs",
  ]) {
    await fs.copyFile(path.join(ROOT, name), path.join(directory, name));
  }
  await fs.writeFile(path.join(directory, "scenario.json"), JSON.stringify(scenario));
  // Reproduce the stale local snapshot that must never drive auto-detection.
  await fs.writeFile(path.join(directory, "leagues.json"), JSON.stringify([
    { game: "poe1", name: "Mirage", league_id: "Mirage", is_active: true },
  ]));
  await fs.writeFile(path.join(dataDir, "cards.json"), mirageCards);
  await fs.writeFile(path.join(dataDir, "cards-Mirage.json"), mirageCards);
  // Identical metadata must not trick the generator into selecting Allflame.
  await fs.writeFile(path.join(dataDir, "cards-Allflame.json"), rawCards);
  const csvLeague = scenario.csvLeague ?? "Mirage";
  await fs.writeFile(path.join(dataDir, "prohibited-library-weights.csv"),
    `patch,Ritual,${csvLeague},All samples\n` +
    "Observed,,111,111\nUnobserved,,222,222\nExcluded,,0,0\nDisabled,boss,333,333\n");
  for (const card of cards) {
    await fs.writeFile(path.join(dataDir, "images", card.art_src), "cached image");
  }

  const table = (rows) => `<table class="wikitable"><tr><th>Item</th><th>Stack size</th><th>Description</th></tr>${rows.map((card) => `<tr><td><a>${card.name}</a></td><td>1</td><td>Reward</td></tr>`).join("")}</table>`;
  const html = table(cards.filter((card) => !card.is_disabled)) +
    table(cards.filter((card) => card.is_disabled)) + cards.map((card) =>
      `<div class="item-box -divicard"><div class="divicard-header">${card.name}</div><div class="divicard-art"><img src="/${card.art_src}"></div><div class="divicard-flavour"><span>Flavour</span></div></div>`).join("");
  await fs.writeFile(path.join(directory, "wiki.html"), html);
  const mockPath = path.join(directory, "mock-fetch.mjs");
  await fs.writeFile(mockPath, `
import fs from "node:fs/promises";
const scenario = JSON.parse(await fs.readFile(new URL("./scenario.json", import.meta.url)));
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.hostname === "fateweaver-test.supabase.co") {
    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body);
    await fs.appendFile(new URL("./requests.jsonl", import.meta.url), JSON.stringify({ path: url.pathname, query: url.search, game: body.game, appVersion: headers.get("x-app-version") }) + "\\n");
    if (url.pathname.startsWith("/auth/v1/")) {
      return Response.json({ access_token: "test-access-token", refresh_token: "test-refresh-token", user: { id: "test-anonymous-user" } });
    }
    if (url.pathname !== "/functions/v1/v2-get-leagues" || body.game !== "poe1") throw new Error("wrong league endpoint or game");
    if (scenario.leagueDown) return new Response("", { status: 503 });
    return Response.json({ leagues: [
      { leagueId: "Standard", name: "Standard", game: "poe1", isActive: true, startAt: "2013-01-23T21:00:00Z", endAt: null },
      { leagueId: "Mirage", name: "Mirage", game: "poe1", isActive: true, startAt: "2019-01-01T00:00:00Z", endAt: null },
      { leagueId: "Covens", name: "Covens", game: "poe1", isActive: true, startAt: "2020-01-01T00:00:00Z", endAt: null }
    ] });
  }
  if (url.hostname === "www.poewiki.net") {
    return Response.json({ parse: { text: await fs.readFile(new URL("./wiki.html", import.meta.url), "utf8") } });
  }
  if (url.hostname === "wraeclast.cards" && url.pathname.endsWith("index.json")) {
    if (scenario.indexDown) return new Response("", { status: 503 });
    return Response.json({ games: { poe1: { leagues: scenario.community ? [{ name: "Covens", url: "/covens.json" }] : [{ name: "Mirage", url: "/mirage.json" }] } } });
  }
  if (url.href === "https://wraeclast.cards/covens.json") {
    return Response.json({ league: { observed_total: 100 }, cards: [
      { name: "Observed", community_estimated_weight: 42, reference_weight: 999 },
      { name: "Unobserved", community_estimated_weight: null, reference_weight: 888 },
      { name: "Disabled", community_estimated_weight: 123 }
    ] });
  }
  throw new Error("Unexpected network request: " + url);
};
`);
  const env = {
    ...process.env,
    SUPABASE_URL: "https://fateweaver-test.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    APP_VERSION_HEADER: scenario.appVersion ?? "",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(mockPath).href}`,
  };
  const run = (args = []) => spawnSync(process.execPath, ["poe1-scrape-all-divination-cards.mjs", "--weights", ...args], {
    cwd: directory, env, encoding: "utf8",
  });
  const read = async (name) => fs.readFile(path.join(dataDir, name), "utf8");
  return { directory, dataDir, env, run, read };
}

test("the full update calls Supabase without an optional app header, selects Covens, and preserves history", async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /Auto-detected league from Supabase: Covens/);
  assert.match(result.stdout, /Using current league "Covens" for weights/);
  const raw = await f.read("cards-Covens.json");
  assert.equal(await f.read("cards.json"), raw);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards-Allflame.json"), rawCards);
  const actual = JSON.parse(raw);
  assert.deepEqual(actual.map((card) => card.weight), [null, null, null, 0]);
  assert.equal(actual.at(-1).from_boss, true);
  const requests = (await fs.readFile(path.join(f.directory, "requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const [leagueRequest] = requests.filter((request) => request.path === "/functions/v1/v2-get-leagues");
  assert.equal(leagueRequest.game, "poe1");
  assert.equal(leagueRequest.appVersion, null);
});

test("configured app telemetry is forwarded and the anonymous session is reused", async (t) => {
  const f = await fixture(t, { appVersion: "fateweaver: 0.0.0" });
  const first = f.run();
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const second = f.run();
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stderr, /Reused stored Supabase session/);
  const requests = (await fs.readFile(path.join(f.directory, "requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(requests.filter((request) => request.path === "/auth/v1/signup").length, 1);
  assert.equal(requests.filter((request) => request.query === "?grant_type=refresh_token").length, 1);
  const leagues = requests.filter((request) => request.path === "/functions/v1/v2-get-leagues");
  assert.equal(leagues.length, 2);
  assert.ok(leagues.every((request) => request.appVersion === "fateweaver: 0.0.0"));
});

test("community estimates use Covens data and ignore historical and reference weights", async (t) => {
  const f = await fixture(t, { community: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const actual = JSON.parse(await f.read("cards-Covens.json"));
  assert.deepEqual(actual.map((card) => card.weight), [42, null, null, 0]);
});

test("offline weights use a matching Covens CSV column and keep disabled weights zero", async (t) => {
  const f = await fixture(t, { indexDown: true, csvLeague: "Covens" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const actual = JSON.parse(await f.read("cards-Covens.json"));
  assert.deepEqual(actual.map((card) => card.weight), [111, 222, 0, 0]);
});

test("league detection failure leaves every snapshot untouched despite stale leagues.json", async (t) => {
  const f = await fixture(t, { leagueDown: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to use a stale snapshot/);
  assert.match(result.stderr, /Supabase league request failed \(503\)/);
  assert.equal(await f.read("cards.json"), mirageCards);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards-Allflame.json"), rawCards);
  await assert.rejects(f.read("cards-Covens.json"), { code: "ENOENT" });
});

test("the league override reaches both steps when auto-detection is unavailable", async (t) => {
  const f = await fixture(t, { leagueDown: true });
  const result = f.run(["--league", "Covens"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Using current league "Covens" for weights/);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards.json"), await f.read("cards-Covens.json"));
});

test("standalone weight generation refuses ambiguous snapshots before writing", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dataDir, "cards-Covens.json"), mirageCards);
  assert.throws(() => execFileSync(process.execPath, ["poe1-generate-weights.mjs"], {
    cwd: f.directory, env: f.env, stdio: "pipe",
  }), (error) => {
    assert.match(error.stderr.toString(), /Could not uniquely match/);
    return true;
  });
  assert.equal(await f.read("cards.json"), mirageCards);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards-Covens.json"), mirageCards);
});
