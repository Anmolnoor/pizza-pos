/** What a recipe's extras and added toppings are charged as: FloCafe add-ons a menu load makes. */
import type { OrderLineRecipe } from './types';

/** One topping on a whole pizza, at the menu's topping price. */
export const TOPPING_ADDON = 'ad-topping';
/** One topping on one half of a half and half, at half that price. */
export const HALF_TOPPING_ADDON = 'ad-topping-half';
/** The most toppings added to one pizza or one half. */
export const MAX_ADDED_TOPPINGS = 10;

/**
 * How many of each topping add-on one of a line carries: every extra and every added topping of
 * a whole pizza counts as a whole topping, and every one on a half as a half topping. A deal adds
 * up its pizzas. A recipe that is not one, or is malformed, counts for nothing.
 */
export function toppingCounts(recipe: OrderLineRecipe | null | undefined): {
  whole: number;
  half: number;
} {
  const counts = { whole: 0, half: 0 };
  const pizzas = recipe?.kind === 'deal' ? recipe.pizzas : recipe?.kind === 'pizza' ? [recipe] : [];
  for (const pizza of Array.isArray(pizzas) ? pizzas : []) {
    const size = (list: unknown) => (Array.isArray(list) ? list.length : 0);
    counts.whole += size(pizza?.whole?.extra) + size(pizza?.whole?.added);
    for (const half of Array.isArray(pizza?.halves) ? pizza.halves : [])
      counts.half += size(half?.extra) + size(half?.added);
  }
  return counts;
}
