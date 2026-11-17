# @navali/poe1-divination-cards

Path of Exile 1 divination card data and images, scraped from the [PoE Wiki](https://www.poewiki.net/wiki/List_of_divination_cards).

Data-only package — no runtime dependencies, no code. Just card data, card art images, and community-sourced weight data.

## Installation

```sh
pnpm add @navali/poe1-divination-cards
```

## What's inside

```
@navali/poe1-divination-cards/
└── data/
    ├── cards.json                          # current league snapshot
    ├── cards-Covens.json                   # Covens league snapshot
    ├── cards-Allflame.json                 # Allflame league snapshot
    ├── cards-Mirage.json                   # Mirage league snapshot
    ├── cards-Keepers.json                  # Keepers league snapshot
    └── images/
        ├── The_Doctor.png
        ├── Rain_of_Chaos.png
        ├── House_of_Mirrors.png
        └── ...
```

## Card schema

Each entry in `cards.json` / `cards-<League>.json`:

| Field          | Type      | Example                 | Description                                |
| -------------- | --------- | ----------------------- | ------------------------------------------ |
| `name`         | `string`  | `"The Doctor"`          | Card name                                  |
| `stack_size`   | `number`  | `8`                     | Number of cards needed for a full set       |
| `description`  | `string`  | `"Headhunter"`          | Plain-text reward description               |
| `reward_html`  | `string`  | `"<em>Headhunter</em>"` | Reward description with HTML formatting     |
| `art_src`      | `string`  | `"The_Doctor.png"`      | Filename of the card art in `images/`       |
| `flavour_html` | `string`  | `"<em>...</em>"`        | Flavour text with HTML formatting           |
| `is_disabled`  | `boolean` | `false`                 | Whether the card is currently disabled      |
| `weight`       | `number \| null` | `26`            | Estimated relative Stacked Deck weight      |
| `from_boss`    | `boolean` | `false`                 | Whether the card is marked boss-restricted  |

`cards.json` is always a copy of the latest league's data. League-specific files (`cards-Mirage.json`, etc.) are preserved as historical snapshots.

Weights are updated separately from wiki scraping using the observed
`community_estimated_weight` published by
[Wraeclast Cards](https://wraeclast.cards/data/drop-rates/index.json).
`reference_weight` is ignored because it references this package. There is no
CSV fallback. Scraping preserves existing same-league weights; new cards start
with `null`. Weight refreshes clamp numeric weights to a minimum of `1`,
including disabled cards, while unknown estimates remain `null`. For cards
absent from the observed dataset, existing minimum weights are retained and
legacy zeros are raised to `1`.
`from_boss` flags are retained metadata and are not refreshed by the weight
updater. New flags default to `false` when no existing metadata is available.

## Usage

### Importing card data

```ts
import cards from "@navali/poe1-divination-cards/data/cards.json" assert { type: "json" };

// Or a specific league snapshot
import allflameCards from "@navali/poe1-divination-cards/data/cards-Allflame.json" assert { type: "json" };
```

### Electron app — main process

```ts
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

const cardsJsonPath = require.resolve(
  "@navali/poe1-divination-cards/data/cards.json",
);

const cards = JSON.parse(readFileSync(cardsJsonPath, "utf-8"));
```

For **packaged builds**, you'll need `extraResource` in your Forge config
since `node_modules` gets pruned:

```ts
// forge.config.ts
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const poe1DataDir = dirname(
  require.resolve("@navali/poe1-divination-cards/data/cards.json"),
);

const config: ForgeConfig = {
  packagerConfig: {
    extraResource: [poe1DataDir],
  },
};
```

Then resolve based on `app.isPackaged`:

```ts
if (app.isPackaged) {
  this.poe1CardsJsonPath = join(process.resourcesPath, "data", "cards.json");
} else {
  const require = createRequire(import.meta.url);
  this.poe1CardsJsonPath = require.resolve(
    "@navali/poe1-divination-cards/data/cards.json",
  );
}
```

### Electron app — renderer with Vite

Since `import.meta.glob` can't reach into `node_modules`, add a Vite alias:

```ts
// vite.renderer.config.mts
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const poe1PkgDir = dirname(
  require.resolve("@navali/poe1-divination-cards/data/cards.json"),
);

export default defineConfig({
  resolve: {
    alias: {
      "@poe1/images": join(poe1PkgDir, "images"),
    },
  },
});
```

Then glob the images in your component:

```tsx
const cardImages = import.meta.glob<{ default: string }>(
  "@poe1/images/*.png",
  { eager: true },
);

function getCardImage(artSrc: string): string {
  const key = `@poe1/images/${artSrc}`;
  return cardImages[key]?.default ?? "";
}
```

## Versioning

This package follows the Path of Exile 1 game version for its major and minor version numbers:

| Semver component | Meaning | Example |
| ---------------- | ------- | ------- |
| **Major.Minor** | PoE 1 league/game version | `3.29.x` = league version 3.29 (Allflame) |
| **Patch** | Package fixes within that league | `3.28.1`, `3.28.2`, … |

When a new league launches (e.g., 3.29), a `feat:` commit bumps the minor version to `3.29.0`.
Bug fixes and data corrections within a league use `fix:` commits, which bump the patch version only.

> **Note:** Version `3.28.0` exists only as a Git tag — the first version published to npm under this scheme is `3.28.1`.

## Attribution

- **Card data & artwork** — All divination card data, descriptions, flavour text, and artwork are the intellectual property of [Grinding Gear Games](https://www.grindinggear.com/). Sourced from the [PoE Wiki](https://www.poewiki.net).
- **Drop weight data** — Current weight refreshes use community estimates from [Wraeclast Cards](https://wraeclast.cards/data/drop-rates/index.json). Historical weights and retained boss metadata include contributions from **@Nerdyjoe** and the [Prohibited Library](https://discord.gg/cf7Uah46ek) community through empirical testing.

## License

See [LICENSE.md](./LICENSE.md) for full details.

- **Scraper code & tooling** — MIT
- **Card data, descriptions & artwork** — Proprietary, © Grinding Gear Games
- **Card weight data** — Community-sourced via Wraeclast Cards, with historical contributions from @Nerdyjoe & the Prohibited Library community

This package is not affiliated with, endorsed by, or associated with Grinding Gear Games.
