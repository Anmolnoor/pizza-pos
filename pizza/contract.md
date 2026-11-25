# Contract

What every lane builds against. The types are in `shared/pizza/types.ts`; this page adds the function signatures, the tables, the mapping onto FloCafe's own catalogue, and who owns which files. Change this page and the types in the same commit, and tell the other lanes.

## The menu file

A shop's menu is one JSON file in the shape of `tests/fixtures/pizza-sample-menu.json` (type `MenuFile`). That fixture is made up. A real shop's file is not kept in this repository; it is loaded into the POS at install and whenever it changes.

Rules the format carries:

- Every pizza costs the size price in `sizes.pizza`; there is no per-pizza price.
- A pizza's `description` is its ingredient list, separated by commas and a final `&`. An empty description means no removable ingredients.
- The side with id `dip` defines the dips: its modifier options, each at that side's price. The side with id `wings` defines the wing flavours a deal can ask for.
- A drink is sold in every entry of the drinks category's `variants`. `pst: true` on that category means drinks carry provincial sales tax.
- A deal has a fixed price and a list of picks. A `pop` pick is any cans adding up to its count. A `choice` pick is answered with one of its options, which then becomes a `pop` or `2l` pick.
- Prices in the file are dollars. The catalogue holds whole cents.

## Pure functions (`shared/pizza/`, lane A)

```ts
// menu.ts
export class MenuError extends Error { readonly path: string }
export function parseMenuFile(raw: unknown): PizzaCatalog;      // validates; throws MenuError naming the bad entry
export function ingredientsOf(description: string): string[];   // "Ham, pineapple, cheese & tomato sauce" -> ["Ham", "Pineapple", "Cheese", "Tomato sauce"]
export function toCents(dollars: number): number;                // rejects values that are not whole cents

// recipe.ts
export class RecipeError extends Error {}                        // message is one a cashier can act on
export function validateRecipe(catalog: PizzaCatalog, raw: unknown): OrderLineRecipe; // normalised copy
export function recipeKey(recipe: OrderLineRecipe): string;      // same recipe, same key, whatever the tap order
export function dealPickCount(deal: CatalogDeal): { pizzas: { sizeId: string }[]; pops: number; wingFlavour: boolean; choice: boolean };

// ticket.ts
export function ticketLines(catalog: PizzaCatalog, recipe: OrderLineRecipe, columns: number): TicketLines;
```

Recipe rules:

- A pizza recipe has exactly one of `whole` and `halves`. Both halves may be the same pizza only if their removals differ; otherwise it is normalised to `whole`.
- `removed` entries must be ingredients of that pizza. Duplicates are dropped and the list is sorted, so the key is stable.
- A deal recipe has one pizza recipe per pizza pick, each with the deal's size; its pops add up to the pick's count; a `choice` deal has either `pops` or `twoLitre`, never both.
- A recipe never changes the price. A pizza costs its size price, a half and half costs the size price, a deal costs the deal price.

Ticket text, at 42 and 48 columns. Detail lines are ready-wrapped at commas and never end in a lone `+` or `NO`:

```text
heading:  LARGE GARDEN
detail:   NO OLIVES, NO ONIONS
          WELL DONE, SQUARE CUT

heading:  LARGE HALF & HALF
detail:   1ST: ISLAND
            NO PINEAPPLE
          2ND: CLASSIC PEPPERONI

heading:  LARGE PIZZAS & WINGS
detail:   1) LARGE GARDEN
             NO OLIVES
          2) LARGE HALF & HALF
             1ST: ISLAND
             2ND: PLAIN CHEESE
          3) LARGE CLASSIC PEPPERONI
          WINGS: SWEET CHILI
```

Quantity (`2x`) is added by the print layer, not by `ticketLines`.

## How a menu maps onto FloCafe's catalogue (lane B2, `main/pizza/menu-import.ts`)

```ts
export function importMenu(db: Database, catalog: PizzaCatalog): { created: number; updated: number; unchanged: number };
```

| Menu | FloCafe |
| :--- | :--- |
| Category `pizzas` | Category "Pizzas"; one product per pizza; one variant per size at the size price |
| Half and half | One extra product "Half & Half" in "Pizzas" with the same size variants |
| Dips | An add-on group "Dips" (optional, several allowed) linked to the "Pizzas" category, one add-on per dip at its price |
| Side with a modifier | A product plus a required single-choice add-on group at price 0 |
| Side without | A product |
| Drinks | Category "Drinks"; one product per drink; one variant per drink variant; the `soda` tax category when `drinksPst` |
| Deals | Category "Deals"; one product per deal at the deal price |

Ids are derived from menu ids (`pz-<id>`, `sd-<id>`, `dr-<id>`, `dl-<id>`, `pz-half-and-half`), so importing the same file twice changes nothing and a changed price updates one row. Category colours are colour names. Money is converted from cents with `getCurrencyMinorUnitFactor`.

## Tables (lane B1, `main/pizza/migrations.ts`)

Created by the pizza migration list, which has its own counter (decision D3). Every statement is idempotent.

```sql
CREATE TABLE IF NOT EXISTS pizza_products (
  product_id  TEXT PRIMARY KEY,
  menu_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('pizza', 'half-and-half', 'deal')),
  ingredients TEXT,            -- JSON string array, kind 'pizza'
  picks       TEXT,            -- JSON MenuDealPick array, kind 'deal'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quick_buttons (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  color       TEXT,
  customer_id TEXT,            -- null: a shop-wide button
  product_id  TEXT NOT NULL,
  variant_id  TEXT,
  recipe      TEXT,            -- JSON OrderLineRecipe
  addons      TEXT,            -- JSON, the cart's add-on shape
  note        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

## Order lines (lane E, after A and B)

- A recipe travels as `modifier_selection` on the order line. The server validates and normalises it with `validateRecipe` against the catalogue built from `pizza_products` and FloCafe's own tables, at order create, add items and replacement edit.
- A recipe is optional on a pizza product: a plain pizza is just the product, its size variant and its dips. A half-and-half product and a deal product require one.
- The line's product and variant must agree with the recipe: `sizeId` matches the variant; `halves` only on the half-and-half product; `dealId` matches the deal product.
- A replacement edit that sends no recipe keeps the stored one.
- Print data gets `detailLines` and the heading from `ticketLines`.

## Lanes and file ownership

| Lane | Builds | Owns |
| :--- | :--- | :--- |
| A, core | `parseMenuFile`, `validateRecipe`, `recipeKey`, `ticketLines` | `shared/pizza/*.ts` except `types.ts`; `tests/pizza-menu.test.ts`, `tests/pizza-recipe.test.ts`, `tests/pizza-ticket.test.ts` |
| B1, tables | The pizza migration list and its two tables | `main/pizza/migrations.ts`; the hook in `main/db.ts`; `tests/pizza-migrations.test.ts` |
| C, shop mode | The `pizza` setup profile, BC tax, wizard pre-fill, the English-only strings file | `main/pizza/setup-profile.ts`; hooks in `main/routes/auth.ts`, `main/setup/seed-data.ts`, `frontend/src/app/setup/page.tsx`, `frontend/src/lib/i18n/`; `tests/pizza-setup-profile.test.ts`, `tests/pizza-tax-bc.test.ts`, `tests/pizza-i18n.test.ts` |
| B2, import | `importMenu` and its route | `main/pizza/menu-import.ts`, `main/routes/pizza.ts`; `tests/pizza-menu-import.test.ts` |
| E, order lines | Recipe validation at the API, print wiring, kitchen display | `main/pizza/order-recipe.ts`; hooks in `main/routes/orders.ts`, the print data builders and the kitchen display views |
| F, POS screens | Pizza sheet, deal configurator, quick buttons, "Customize 1", category popups | `frontend/src/components/pos/pizza/`; hooks in the POS page and cart files |

Every lane adds its `test:pizza-*` scripts at the end of the `"test"` chain in `package.json`; whoever merges second resolves that one-line conflict by keeping both.
