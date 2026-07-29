# Fateweaver

Fateweaver maintains the data published as
[`@navali/poe1-divination-cards`](https://www.npmjs.com/package/@navali/poe1-divination-cards).
It collects Path of Exile 1 divination-card metadata and artwork from PoE Wiki,
then enriches the card snapshots with community-estimated Stacked Deck weights.

This repository is primarily a maintainer tool. For instructions on consuming
the published package, see the
[package README](packages/poe1-divination-cards/README.md).

## Setup

The expected Node.js and pnpm versions are declared in `package.json`.

```sh
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env` and configure the Supabase league provider:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
APP_VERSION_HEADER=fateweaver: 0.0.0
```

The scraper stores the anonymous Supabase refresh token in the gitignored
`.supabase-session.json` file. Later runs refresh and reuse that session instead
of creating another anonymous user.

## Updating the current league

Run the complete update:

```sh
pnpm scrape:poe1
```

The command:

1. Detects the current PoE 1 league through the Supabase `v2-get-leagues`
   function. The checked-in `leagues.json` is the offline fallback.
2. Fetches the rendered divination-card list through the PoE Wiki MediaWiki API.
3. Parses active and disabled cards, reward descriptions, flavour text, and
   artwork.
4. Writes a league snapshot such as `cards-Allflame.json` and updates
   `cards.json`.
5. Loads `community_estimated_weight` from
   [Wraeclast Cards](https://wraeclast.cards/data/drop-rates/index.json) for the
   current league snapshot.
6. Uses `prohibited-library-weights.csv` as the offline weight fallback and as
   the source of `from_boss`.

Wraeclast Cards references this package for card metadata and its
`reference_weight`. Fateweaver deliberately ignores `reference_weight` and
only consumes the independently observed `community_estimated_weight`.

### Override league detection

To force a league name, run the scraper and weight generator separately:

```sh
node --env-file-if-exists=.env poe1-scrape-all-divination-cards.mjs --league Allflame
node poe1-generate-weights.mjs
```

The short form `-l Allflame` is also supported. Avoid forwarding the option to
`pnpm scrape:poe1`: because that script chains two Node commands, forwarded
arguments would be attached to the second command instead of the scraper.

## Generated data

Generated files live under `packages/poe1-divination-cards/data/`:

```text
data/
├── cards.json
├── cards-Allflame.json
├── cards-Mirage.json
├── cards-Keepers.json
├── prohibited-library-weights.csv
└── images/
```

- `cards.json` is identical to the current league snapshot.
- `cards-<League>.json` files preserve league-specific data.
- Existing images are reused; only missing artwork is downloaded.
- Disabled cards receive weight `0`.
- Cards without a current community estimate retain `null`.

Generated JSON and new artwork are intended to be committed.

## Verification

Before committing an update, run:

```sh
pnpm install --frozen-lockfile
pnpm scrape:poe1
node --check poe1-scrape-all-divination-cards.mjs
node --check poe1-generate-weights.mjs
git diff --check
git status --short
```

Review the diff for:

- the expected league filename;
- a plausible active and disabled card count;
- newly added or newly disabled cards;
- missing artwork and `null` weight warnings;
- unintended changes to historical snapshots.

## Releasing

Releases are automated by semantic-release when relevant changes reach `main`.
Do not manually edit the package version.

The commit type determines the version bump:

| Commit type | Release | Intended use |
| --- | --- | --- |
| `feat` | Minor | First data release for a new PoE league |
| `fix` | Patch | Scraper or data correction |
| `perf` | Patch | Performance improvement |
| `data` | Patch | Same-league data or weight refresh |
| `refactor` | Patch | Internal restructuring |
| Breaking change | Minor | Breaking package change |

For example, when the package is at `3.28.2`, this commit:

```text
feat(data): add Allflame league snapshot
```

produces version `3.29.0`, keeping the package minor version aligned with PoE
3.29. Later Allflame refreshes should use a patch-producing commit:

```text
data(poe1): refresh Allflame card weights
```

The release workflow publishes the package to npm, creates the matching GitHub
release and tag, and commits the updated package version as
`chore(release): ... [skip ci]`.

## Data sources and licensing

- Card metadata and artwork: [PoE Wiki](https://www.poewiki.net/)
- Current league detection: Supabase `v2-get-leagues`
- Observed drop weights: [Wraeclast Cards](https://wraeclast.cards/data/drop-rates/index.json)
- Offline weights and boss metadata: Prohibited Library CSV

The scraper and tooling are MIT licensed. Path of Exile card data and artwork
remain the intellectual property of Grinding Gear Games. See the
[package license](packages/poe1-divination-cards/LICENSE.md) for details.
