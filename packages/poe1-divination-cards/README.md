# @navali/poe1-divination-cards

Path of Exile 1 divination card data and images, scraped from the [PoE Wiki](https://www.poewiki.net/wiki/List_of_divination_cards).

Data-only package — no runtime dependencies, no code. Just `cards.json` and card art images.

## Installation

```sh
pnpm add @navali/poe1-divination-cards
```

## What's inside

```
@navali/poe1-divination-cards/
└── data/
    ├── cards.json
    └── images/
        ├── The_Doctor.png
        ├── Rain_of_Chaos.png
        ├── House_of_Mirrors.png
        └── ...
```

## Card schema

Each entry in `cards.json`:

| Field          | Type     | Example                 |
| -------------- | -------- | ----------------------- |
| `name`         | `string` | `"The Doctor"`          |
| `stack_size`   | `number` | `8`                     |
| `description`  | `string` | `"Headhunter"`          |
| `reward_html`  | `string` | `"<em>Headhunter</em>"` |
| `art_src`      | `string` | `"The_Doctor.png"`      |
| `flavour_html` | `string` | `"<em>...</em>"`        |

## Usage in an Electron app

### Main process — loading the JSON

```ts
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Resolve the absolute path to cards.json inside node_modules
const cardsJsonPath = require.resolve("@navali/poe1-divination-cards/cards.json");

// Read it however you like
const cards = JSON.parse(readFileSync(cardsJsonPath, "utf-8"));
```

For **packaged builds**, you'll still need `extraResource` in your Forge config
since `node_modules` gets pruned. Point it at the resolved package directory:

```ts
// forge.config.ts
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const poe1DataDir = dirname(require.resolve("@navali/poe1-divination-cards/cards.json"));

const config: ForgeConfig = {
  packagerConfig: {
    extraResource: [
      poe1DataDir, // copies data/ contents into resources/data/
      // ...
    ],
  },
};
```

Then in your service, resolve based on `app.isPackaged`:

```ts
if (app.isPackaged) {
  this.poe1CardsJsonPath = join(process.resourcesPath, "data", "cards.json");
} else {
  const require = createRequire(import.meta.url);
  this.poe1CardsJsonPath = require.resolve("@navali/poe1-divination-cards/cards.json");
}
```

### Renderer — loading card images with Vite

Since `import.meta.glob` can't reach into `node_modules`, add a Vite alias:

```ts
// vite.renderer.config.mts
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const poe1PkgDir = dirname(require.resolve("@navali/poe1-divination-cards/cards.json"));

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
  // The glob keys will be like "@poe1/images/The_Doctor.png"
  const key = `@poe1/images/${artSrc}`;
  return cardImages[key]?.default ?? "";
}
```

## License

MIT