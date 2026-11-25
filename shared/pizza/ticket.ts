/**
 * Spike stand-in for the pizza core's ticket formatter: reads pre-formatted
 * detail lines out of an order line's `modifier_selection`.
 */
export function pizzaDetailLines(modifierSelection: unknown): string[] {
  const lines = (modifierSelection as { detailLines?: unknown } | null | undefined)?.detailLines;
  return Array.isArray(lines)
    ? lines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    : [];
}
