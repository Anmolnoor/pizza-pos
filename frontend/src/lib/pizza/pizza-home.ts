import { cartVariantUnitPrice } from '@/lib/cart-price';
import { activeVariants } from '@/lib/product-variants';
import type { Product, ProductVariant } from '@/lib/types';

type Priced = Pick<Product, 'price' | 'variants'>;

/**
 * The price most pizzas share at each size, by size name in menu order, as the cart charges it.
 * A size has none when no price is shared by two pizzas or two prices tie.
 */
export function standardPrices(pizzas: Priced[], online: boolean): Map<string, number> {
  const counts = new Map<string, Map<number, number>>();
  for (const product of pizzas)
    for (const variant of activeVariants(product.variants)) {
      const prices = counts.get(variant.name) ?? new Map<number, number>();
      const price = cartVariantUnitPrice({ product, variant }, online);
      prices.set(price, (prices.get(price) ?? 0) + 1);
      counts.set(variant.name, prices);
    }
  const standard = new Map<string, number>();
  for (const [size, prices] of counts) {
    const [first, second] = [...prices].sort((a, b) => b[1] - a[1]);
    if (first[1] >= 2 && first[1] !== second?.[1]) standard.set(size, first[0]);
  }
  return standard;
}

/** The price a size button shows: null when it is the standard price for its size. */
export function tilePrice(
  product: Priced,
  variant: ProductVariant,
  standard: ReadonlyMap<string, number>,
  online: boolean,
): number | null {
  const price = cartVariantUnitPrice({ product, variant }, online);
  return standard.get(variant.name) === price ? null : price;
}

const LABELS = new Map([
  ['small', 'S'],
  ['medium', 'M'],
  ['large', 'L'],
  ['extra large', 'XL'],
]);

/**
 * The short label of each size button, by size name: S, M, L or XL, or the size's own name.
 * Sizes that would share a label keep their own names, so no two buttons read the same.
 */
export function sizeLabels(names: Iterable<string>): Map<string, string> {
  const unique = [...new Set(names)];
  const short = (name: string) => LABELS.get(name.trim().toLowerCase()) ?? name;
  const uses = new Map<string, number>();
  for (const name of unique) uses.set(short(name), (uses.get(short(name)) ?? 0) + 1);
  return new Map(unique.map((name) => [name, uses.get(short(name))! > 1 ? name : short(name)]));
}
