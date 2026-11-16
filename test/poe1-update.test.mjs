import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  cards.map((card) => ({ ...card, weight: 999, from_boss: card.name === "Disabled" })),
  null,
  2,
);
const covensCards = JSON.stringify(
  cards.map((card) => ({
    ...card,
    weight: card.name === "Excluded" ? 0 : 999,
    from_boss: card.name === "Disabled",
  })),
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
  for (const card of cards) {
    await fs.writeFile(path.join(dataDir, "images", card.art_src), "cached image");
  }

  const table = (rows) => `<table class="wikitable"><tr><th>Item</th><th>Stack size</th><th>Description</th></tr>${rows.map((card) => `<tr><td><a>${card.name}</a></td><td>1</td><td>${scenario.rewardDisabled && card.is_disabled ? "Disabled" : "Reward"}</td></tr>`).join("")}</table>`;
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
  await fs.appendFile(new URL("./network.jsonl", import.meta.url), JSON.stringify(url.href) + "\\n");
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
    return Response.json({ games: { poe1: { leagues: scenario.missingLeague ? [{ name: "Mirage", url: "/mirage.json" }] : [{ name: "Covens", url: scenario.detailUrl ?? "/covens.json" }] } } });
  }
  if (url.href === "https://wraeclast.cards/covens.json") {
    if (scenario.detailDown) return new Response("", { status: 503 });
    return Response.json(scenario.payload ?? { game: "poe1", league: { name: "Covens", observed_total: 100 }, cards: [
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
  const runScript = (script, args) => spawnSync(process.execPath, [script, ...args], {
    cwd: directory, env, encoding: "utf8",
  });
  const run = (args = []) => runScript("poe1-scrape-all-divination-cards.mjs", args);
  const weights = (args = []) => runScript("poe1-generate-weights.mjs", args);
  const setCurrent = async (raw = covensCards) => {
    await fs.writeFile(path.join(dataDir, "cards-Covens.json"), raw);
    await fs.writeFile(path.join(dataDir, "cards.json"), raw);
  };
  const read = async (name) => fs.readFile(path.join(dataDir, name), "utf8");
  const network = async () => (await fs.readFile(path.join(directory, "network.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  return { directory, dataDir, run, weights, setCurrent, read, network };
}

test("scraping selects Covens without requesting weights or carrying weights from history", async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /Auto-detected league from Supabase: Covens/);
  const raw = await f.read("cards-Covens.json");
  assert.equal(await f.read("cards.json"), raw);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards-Allflame.json"), rawCards);
  const actual = JSON.parse(raw);
  assert.deepEqual(actual.map((card) => card.weight), [null, null, null, null]);
  assert.equal(actual.at(-1).from_boss, true);
  assert.ok((await f.network()).every((url) => !url.includes("wraeclast.cards")));
  const requests = (await fs.readFile(path.join(f.directory, "requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const [leagueRequest] = requests.filter((request) => request.path === "/functions/v1/v2-get-leagues");
  assert.equal(leagueRequest.game, "poe1");
  assert.equal(leagueRequest.appVersion, null);
});

test("new leagues inherit metadata from the current snapshot instead of alphabetical history", async (t) => {
  const f = await fixture(t, { rewardDisabled: true });
  const current = cards.map((card) => ({
    ...card,
    description: "Current reward",
    reward_html: "<em>Current reward</em>",
    weight: 123,
    from_boss: card.name === "Observed",
  }));
  const currentRaw = JSON.stringify(current, null, 2);
  await f.setCurrent(currentRaw);

  const result = f.run(["--league", "Next"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const raw = await f.read("cards-Next.json");
  const actual = JSON.parse(raw);
  assert.deepEqual(actual.map((card) => card.from_boss), [true, false, false, false]);
  assert.deepEqual(actual.map((card) => card.weight), [null, null, null, null]);
  assert.equal(actual.at(-1).description, "Current reward");
  assert.equal(actual.at(-1).reward_html, "<em>Current reward</em>");
  assert.equal(await f.read("cards.json"), raw);
  assert.equal(await f.read("cards-Covens.json"), currentRaw);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards-Allflame.json"), rawCards);
});

test("a missing current snapshot does not select an arbitrary historical predecessor", async (t) => {
  const f = await fixture(t);
  await fs.rm(path.join(f.dataDir, "cards.json"));
  const result = f.run(["--league", "Next"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const actual = JSON.parse(await f.read("cards-Next.json"));
  assert.deepEqual(actual.map((card) => card.from_boss), [false, false, false, false]);
  assert.deepEqual(actual.map((card) => card.weight), [null, null, null, null]);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards-Allflame.json"), rawCards);
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

test("scraping preserves same-league weights and boss flags while updating metadata", async (t) => {
  const f = await fixture(t, { indexDown: true });
  const existing = cards.map((card, index) => ({
    ...card,
    description: "Old reward",
    weight: [17, null, 0, 123][index],
    from_boss: index === 0,
  }));
  await f.setCurrent(JSON.stringify(existing));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const actual = JSON.parse(await f.read("cards-Covens.json"));
  assert.deepEqual(actual.map((card) => card.weight), [17, null, 0, 123]);
  assert.deepEqual(actual.map((card) => card.from_boss), [true, false, false, false]);
  assert.ok(actual.every((card) => card.description === "Reward"));
  assert.equal(await f.read("cards.json"), await f.read("cards-Covens.json"));
  assert.ok((await f.network()).every((url) => !url.includes("wraeclast.cards")));
});

test("newly scraped cards start with null weights even if an older league has a weight", async (t) => {
  const f = await fixture(t);
  await f.setCurrent(JSON.stringify(JSON.parse(covensCards).slice(1)));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const actual = JSON.parse(await f.read("cards-Covens.json"));
  assert.deepEqual(actual.map((card) => card.weight), [null, 999, 0, 999]);
});

test("standalone weight updates change only weights using community estimates without a CSV", async (t) => {
  const f = await fixture(t);
  await f.setCurrent();
  const result = f.weights();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Using current league "Covens" for weights/);
  const actual = JSON.parse(await f.read("cards-Covens.json"));
  assert.deepEqual(actual.map((card) => card.weight), [42, null, 0, 0]);
  const withoutWeights = (data) => data.map(({ weight, ...card }) => card);
  assert.deepEqual(withoutWeights(actual), withoutWeights(JSON.parse(covensCards)));
  assert.equal(await f.read("cards.json"), await f.read("cards-Covens.json"));
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards-Allflame.json"), rawCards);
  assert.ok((await f.network()).every((url) => new URL(url).hostname === "wraeclast.cards"));
  const second = f.weights();
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.deepEqual(JSON.parse(await f.read("cards.json")), actual);
});

test("weight updates clear stale nonzero weights for cards absent from community data", async (t) => {
  const f = await fixture(t);
  const current = JSON.parse(covensCards);
  current.find((card) => card.name === "Excluded").weight = 888;
  await f.setCurrent(JSON.stringify(current));
  const result = f.weights();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(await f.read("cards.json")).map((card) => card.weight), [42, null, null, 0]);
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

test("the scraper league override works when auto-detection is unavailable", async (t) => {
  const f = await fixture(t, { leagueDown: true });
  const result = f.run(["--league", "Covens"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards.json"), await f.read("cards-Covens.json"));
});

test("standalone weight generation refuses ambiguous snapshots before fetching or writing", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dataDir, "cards-Covens.json"), mirageCards);
  const result = f.weights();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not uniquely match/);
  assert.equal(await f.read("cards.json"), mirageCards);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards-Covens.json"), mirageCards);
  await assert.rejects(fs.readFile(path.join(f.directory, "network.jsonl")), { code: "ENOENT" });
});

test("a standalone league override disambiguates identical current snapshots", async (t) => {
  const f = await fixture(t);
  await f.setCurrent();
  await fs.writeFile(path.join(f.dataDir, "cards-Allflame.json"), covensCards);
  const result = f.weights(["-l", "Covens"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(await f.read("cards-Allflame.json"), covensCards);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
  assert.equal(await f.read("cards.json"), await f.read("cards-Covens.json"));
});

test("a standalone override cannot select a historical snapshot that differs from cards.json", async (t) => {
  const f = await fixture(t);
  await f.setCurrent();
  const result = f.weights(["--league", "Mirage"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /It must match cards.json/);
  assert.equal(await f.read("cards.json"), covensCards);
  assert.equal(await f.read("cards-Mirage.json"), mirageCards);
});

const payload = (cards, league = "Covens") => ({ game: "poe1", league: { name: league }, cards });
for (const [name, scenario, message] of [
  ["index outage", { indexDown: true }, /request failed: 503/],
  ["missing league", { missingLeague: true }, /No Wraeclast Cards weights/],
  ["league outage", { detailDown: true }, /request failed: 503/],
  ["empty dataset", { payload: payload([]) }, /nonempty cards array/],
  ["malformed dataset", { payload: payload({}) }, /nonempty cards array/],
  ["wrong league", { payload: payload([{ name: "Observed", community_estimated_weight: 42 }], "Mirage") }, /does not match/],
  ["negative estimate", { payload: payload([{ name: "Observed", community_estimated_weight: -1 }]) }, /Invalid community_estimated_weight/],
  ["missing estimate", { payload: payload([{ name: "Observed", reference_weight: 999 }]) }, /Invalid community_estimated_weight/],
  ["duplicate card", { payload: payload(Array(2).fill({ name: "Observed", community_estimated_weight: 42 })) }, /duplicate card name/],
  ["cross-origin detail", { detailUrl: "https://other.example/weights.json" }, /Refusing cross-origin/],
]) {
  test(`weight update preserves every snapshot on ${name}`, async (t) => {
    const f = await fixture(t, scenario);
    await f.setCurrent();
    const result = f.weights();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(await f.read("cards.json"), covensCards);
    assert.equal(await f.read("cards-Covens.json"), covensCards);
    assert.equal(await f.read("cards-Mirage.json"), mirageCards);
    assert.equal(await f.read("cards-Allflame.json"), rawCards);
  });
}
