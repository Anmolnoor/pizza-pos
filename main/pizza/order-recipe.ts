/** The recipe on an order line: checked at the API, kept across edits, printed as detail lines. */
import type Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { RecipeError, validateRecipe } from '../../shared/pizza/recipe';
import { ticketLines } from '../../shared/pizza/ticket';
import type { OrderLineRecipe, PizzaCatalog } from '../../shared/pizza/types';

const WRONG_ITEM = 'The recipe is for a different item. Remove it and add it again';

function isRecipe(value: unknown): value is OrderLineRecipe {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return kind === 'pizza' || kind === 'deal';
}

function readCatalog(db: Database.Database): PizzaCatalog {
  const row = db.prepare('SELECT catalog FROM pizza_menu WHERE id = 1').get() as {
    catalog: string;
  };
  return JSON.parse(row.catalog);
}

function agreedRecipe(
  db: Database.Database,
  productId: string,
  variantId: string | undefined,
  raw: unknown,
): unknown {
  const product = db
    .prepare('SELECT menu_id, kind FROM pizza_products WHERE product_id = ?')
    .get(productId) as { menu_id: string; kind: 'pizza' | 'half-and-half' | 'deal' } | undefined;
  if (!product) {
    if (isRecipe(raw))
      throw new RecipeError(
        'This item does not take a pizza or deal recipe. Remove it and add it again',
      );
    return raw;
  }
  const pickHalves = 'Pick the two halves';
  if (!raw) {
    if (product.kind === 'pizza') return raw;
    throw new RecipeError(product.kind === 'deal' ? 'Pick what goes in this deal' : pickHalves);
  }

  const recipe = validateRecipe(readCatalog(db), raw);
  if (recipe.kind === 'deal') {
    if (product.kind !== 'deal' || recipe.dealId !== product.menu_id)
      throw new RecipeError(WRONG_ITEM);
    return recipe;
  }
  if (product.kind === 'deal') throw new RecipeError(WRONG_ITEM);
  if (product.kind === 'half-and-half') {
    if (!recipe.halves) throw new RecipeError(pickHalves);
  } else if (!recipe.whole) {
    throw new RecipeError('A half and half is its own item. Choose Half & Half instead');
  } else if (recipe.whole.pizzaId !== product.menu_id) {
    throw new RecipeError(WRONG_ITEM);
  }
  if (variantId !== `${productId}-${recipe.sizeId}`)
    throw new RecipeError('The size does not match this item. Pick the size again');
  return recipe;
}

/**
 * Checks the recipe on an incoming order line against the menu and the line's own product and
 * variant, and leaves it normalised in `modifier_selection`. A refusal is a `RecipeError`
 * answered with 400. A product that is not a pizza or a deal keeps what it sent.
 */
export function checkLineRecipe(
  db: Database.Database,
  line: { product_id: string; modifier_selection?: unknown },
  variantId: string | undefined,
): void {
  try {
    line.modifier_selection = agreedRecipe(db, line.product_id, variantId, line.modifier_selection);
  } catch (error) {
    throw error instanceof RecipeError ? Object.assign(error, { statusCode: 400 }) : error;
  }
}

/** A replacement that sends no recipe keeps the one stored on the line, while the product stays. */
export function keepStoredRecipe(
  replacement: { product_id?: unknown; modifier_selection?: unknown },
  stored: { product_id: string; modifier_selection?: string | null },
): void {
  if (replacement.modifier_selection == null && replacement.product_id === stored.product_id)
    replacement.modifier_selection = JSON.parse(stored.modifier_selection ?? 'null');
}

/**
 * Order items with `detailLines` written from each line's recipe, for a printer laying out
 * `columns` characters. A line with no recipe, or one that cannot be read, is left as it is.
 */
export function withRecipeDetailLines<T>(items: T, columns: number): T {
  if (!Array.isArray(items)) return items;
  let catalog: PizzaCatalog | undefined;
  return items.map((item) => {
    try {
      const raw = item?.modifier_selection;
      const recipe = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!isRecipe(recipe)) return item;
      catalog ??= readCatalog(getDatabase());
      return { ...item, detailLines: ticketLines(catalog, recipe, columns).detailLines };
    } catch {
      return item;
    }
  }) as T;
}
