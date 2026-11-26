/** A sold pizza or deal line whose recipe or note changes keeps the money it was sold at. */
import type Database from 'better-sqlite3';

type Addon = { id?: unknown; quantity?: unknown } | null | undefined;

const addonKey = (addons: Addon[]): string =>
  addons
    .filter(Boolean)
    .map((addon) => `${addon?.id} x${Number(addon?.quantity) || 1}`)
    .sort()
    .join('\n');

/**
 * True when a replacement names the product, variant, quantity and add-ons the sold line already
 * has, on a product a menu load made, and sets no price of its own: only the recipe or the note
 * can differ.
 */
export function changesRecipeOnly(
  db: Database.Database,
  replacement: {
    product_id?: unknown;
    variant_id?: unknown;
    quantity?: unknown;
    addons?: Addon[] | null;
    price_override?: unknown;
  },
  sold: { product_id: unknown; variant_id?: unknown; quantity: unknown },
  soldAddons: { addon_id: unknown; quantity: unknown }[],
): boolean {
  return (
    replacement.product_id === sold.product_id &&
    String(replacement.variant_id ?? '').trim() === String(sold.variant_id ?? '') &&
    Number(replacement.quantity) === Number(sold.quantity) &&
    (replacement.price_override ?? null) === null &&
    addonKey(Array.isArray(replacement.addons) ? replacement.addons : []) ===
      addonKey(soldAddons.map((addon) => ({ id: addon.addon_id, quantity: addon.quantity }))) &&
    !!db.prepare('SELECT 1 FROM pizza_products WHERE product_id = ?').get(sold.product_id)
  );
}

/** Gives the line that replaced a sold one the sold line's tax, when both are worth the same. */
export function carrySoldTax(
  db: Database.Database,
  soldId: number | bigint | string,
  newId: number | bigint | string,
): void {
  db.prepare(
    `UPDATE order_items SET (tax_amount, tax_breakdown, tax_snapshot, tax_type, total) =
       (SELECT tax_amount, tax_breakdown, tax_snapshot, tax_type, total FROM order_items WHERE id = @sold)
     WHERE id = @new AND subtotal = (SELECT subtotal FROM order_items WHERE id = @sold)`,
  ).run({ sold: soldId, new: newId });
}
