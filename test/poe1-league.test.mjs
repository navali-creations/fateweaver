import assert from "node:assert/strict";
import test from "node:test";

import { resolveLeague, selectCurrentLeague } from "../poe1-scrape-all-divination-cards.mjs";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const current = (overrides = {}) => ({
  id: "Covens",
  leagueId: "Covens",
  name: "Covens",
  game: "poe1",
  isActive: true,
  startAt: "2026-11-13T19:00:00Z",
  endAt: null,
  ...overrides,
});

test("selects the latest active PoE 1 league regardless of response order", () => {
  const leagues = [
    current({ game: "poe2" }),
    current({ leagueId: "Standard", name: "Standard" }),
    current({ name: "Mirage", startAt: "2026-03-06T19:00:00Z" }),
    current({ name: "Allflame", startAt: "2026-07-24T19:00:00Z" }),
    current({ name: "Future League", startAt: "2026-12-01T19:00:00Z" }),
    current({ name: "Ended League", endAt: "2026-11-14T12:00:00Z" }),
    current({ name: "Inactive League", isActive: false }),
    current(),
  ];
  assert.equal(selectCurrentLeague(leagues, NOW), "Covens");
  assert.equal(selectCurrentLeague(leagues.toReversed(), NOW), "Covens");
});

test("automatically selects a later league without a hardcoded league name", () => {
  assert.equal(
    selectCurrentLeague([current({ name: "Next League" })], NOW),
    "Next League",
  );
});

test("rejects missing, malformed, expired, future, and ambiguous current leagues", () => {
  for (const leagues of [
    {},
    [],
    [null],
    [current({ isActive: false })],
    [current({ leagueId: undefined })],
    [current({ name: undefined })],
    [current({ startAt: "invalid" })],
    [current({ startAt: "2026-12-01T00:00:00Z" })],
    [current({ endAt: "invalid" })],
    [current({ endAt: "2026-11-01T00:00:00Z" })],
    [current(), current({ name: "Other League" })],
    [current(), current({ name: "Other League", startAt: "2026-11-13T20:00:00+01:00" })],
  ]) {
    assert.throws(() => selectCurrentLeague(leagues, NOW));
  }
});

test("honours explicit current flags and rejects missing or ambiguous current flags", () => {
  const leagues = [
    current({ name: "Other League", startAt: "2026-11-14T01:00:00Z", isCurrent: false }),
    current({ isCurrent: true }),
  ];
  assert.equal(selectCurrentLeague(leagues, NOW), "Covens");
  assert.throws(() => selectCurrentLeague([current({ isCurrent: false })], NOW));
  assert.throws(() => selectCurrentLeague([
    current({ isCurrent: true }), current({ name: "Other League", isCurrent: true }),
  ], NOW));
});

test("an explicit league bypasses network detection and rejects unsafe filenames", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("must not request a league for an explicit override");
  });
  assert.equal(await resolveLeague(" Covens "), "Covens");
  for (const invalid of [" ", "../Mirage", "..\\Mirage", "Covens."]) {
    await assert.rejects(resolveLeague(invalid));
  }
});

test("configuration errors stay visible instead of returning the stale Mirage snapshot", async (t) => {
  const previousUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
  });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("must fail before sending a request");
  });
  await assert.rejects(resolveLeague(), (error) => {
    assert.match(error.message, /Refusing to use a stale snapshot/);
    assert.match(error.cause.message, /Supabase URL is not configured/);
    return true;
  });
});
