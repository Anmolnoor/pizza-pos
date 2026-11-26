/**
 * The order types the POS switch offers, in the switch's own order: the ones
 * the store's `pos_order_types` setting names, plus the type of the order
 * being added to. A setting that names none of them hides nothing.
 */
export function offeredOrderTypes<T extends string>(
  all: readonly T[],
  allowed: readonly string[],
  existing?: string | null,
): T[] {
  const narrowed = all.some((type) => allowed.includes(type));
  return all.filter((type) => !narrowed || allowed.includes(type) || type === existing);
}
