# Fateweaver

Fateweaver maintains the data published as
[`@navali/poe1-divination-cards`](https://www.npmjs.com/package/@navali/poe1-divination-cards).
It collects Path of Exile 1 divination-card metadata and artwork from PoE Wiki.
A separate command updates community-estimated Stacked Deck weights from
Wraeclast Cards.

This repository is primarily a maintainer tool. For instructions on consuming
the published package, see the
[package README](packages/poe1-divination-cards/README.md).

## Setup

The expected Node.js and pnpm versions are declared in `package.json`.

```sh
pnpm install --frozen-lockfile
```

Configure the Supabase league provider in `.env`:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

The `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` names are also
supported. `APP_VERSION_HEADER` is optional telemetry; omitting it does not
prevent league detection. The scraper stores its anonymous Supabase session
in the gitignored `.supabase-session.json` and reuses it on subsequent runs.

## Updating the current league

Update card metadata and artwork:

```sh
pnpm scrape:poe1
```

The command:

1. Detects the current PoE 1 league through Supabase `v2-get-leagues`, using
   `isCurrent` when supplied or the newest active non-Standard league by
   `startAt`. Detection failures stop the update before writing card data;
   stale local league lists are never used as a fallback.
2. Fetches the rendered divination-card list through the PoE Wiki MediaWiki API.
3. Parses active and disabled cards, reward descriptions, flavour text, and
   artwork.
4. Preserves existing weights from the selected league's snapshot. New cards
   and new league snapshots start with `null` weights, including disabled
   cards, until the separate weight update runs. Older leagues' weights are
   never carried forward. Existing `from_boss` flags are retained, with metadata
   from the pre-scrape `cards.json` used for cards absent from the selected
   snapshot; new flags default to `false`. New leagues also carry forward
   disabled card descriptions from that current snapshot, without guessing a
   predecessor from alphabetical league filenames.
5. Writes a league snapshot such as `cards-Covens.json` and updates
   `cards.json`. Scraping never requests or recalculates weights.

### Update only weights

```sh
pnpm weights:poe1
```

This command updates only `weight` in the current league snapshot and
`cards.json`, using `community_estimated_weight` from
[Wraeclast Cards](https://wraeclast.cards/data/drop-rates/index.json). It does
not scrape the wiki or need Supabase credentials. Other fields, including
`from_boss`, and historical snapshots remain untouched.

Numeric weights have a minimum of `1`, including disabled cards. Cards without
an estimate receive `null`. For cards absent from the observed dataset,
existing minimum weights are retained and legacy zeros are raised to `1`. If the
source is unavailable, has no matching league, or returns invalid data, the
command fails before writing either file and existing weights remain intact.
There is no CSV fallback.

Wraeclast Cards references this package for card metadata and its
`reference_weight`. Fateweaver deliberately ignores `reference_weight` and
only consumes the independently observed `community_estimated_weight`.

### Override league detection

To force a league name when scraping:

```sh
pnpm scrape:poe1 --league Covens
```

The short form `-l Covens` is also supported by both commands. The weight
updater identifies the current league by matching `cards.json` to exactly one
league snapshot. If multiple snapshots are identical, select the current one:

```sh
pnpm weights:poe1 --league Covens
```

The selected snapshot must match `cards.json`; the override cannot update an
unrelated historical snapshot. The scraper no longer accepts `--weights`.

### Daily weight releases

The `Release` GitHub Actions workflow refreshes weights every day at **05:17 UTC**
(`17 5 * * *`) once these workflows are on `main`. It can also be started manually
from the Actions tab. The schedule avoids the start-of-hour load, but GitHub's
scheduled runs can still be delayed or dropped. If a daily run is missing, start
the workflow manually. See GitHub's
[schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

The workflow finds the current PoE 1 league marked `historical: false` in the
Wraeclast Cards index, then runs `pnpm weights:poe1 --league <name>`. After a
successful update, it commits the current snapshot and that league's snapshot
with the UTC date:

```text
fix(data,poe1): 11/17/2026
```

After the dated commit is pushed, the same workflow publishes the next patch
version.
An empty commit is created when the weights are unchanged, so active leagues
still receive a daily release. This uses the existing `GITHUB_TOKEN` and npm
publishing setup; no extra token or Supabase credentials are needed. The release
job runs in the same workflow because pushes using `GITHUB_TOKEN`
[do not trigger another push workflow](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs).

If there is no active league, the workflow skips the update and release.
Source failures or ambiguous active leagues fail the run before creating a
commit. A new league must first be scraped and committed so its snapshot matches
`cards.json`; the daily workflow does not scrape card metadata.

## Generated data

Generated files live under `packages/poe1-divination-cards/data/`:

```text
data/
├── cards.json
├── cards-Covens.json
├── cards-Allflame.json
├── cards-Mirage.json
├── cards-Keepers.json
└── images/
```

- `cards.json` is identical to the current league snapshot.
- `cards-<League>.json` files preserve league-specific data.
- Existing images are reused; only missing artwork is downloaded.
- Weight changes are made only by `pnpm weights:poe1`.
- `from_boss` flags are retained metadata; neither command refreshes them
  from an external source.

Generated JSON and new artwork are intended to be committed.

## Verification

Before committing an update, run:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm scrape:poe1
pnpm weights:poe1
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
- Historical weights and retained boss metadata: @Nerdyjoe and the Prohibited
  Library community

The scraper and tooling are MIT licensed. Path of Exile card data and artwork
remain the intellectual property of Grinding Gear Games. See the
[package license](packages/poe1-divination-cards/LICENSE.md) for details.
