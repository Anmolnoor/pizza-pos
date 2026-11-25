/** Customer contact facts a kitchen ticket header prints when the merchant opts in. */

/** One labelled header line; `concept` names an existing print label. */
export interface KotContactLine {
  readonly concept:
    | 'print.numberShort'
    | 'print.deliverySlip.address'
    | 'print.deliverySlip.deliveryNote';
  readonly text: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Contact lines for a raw order: the customer's phone number when the order
 * has one, then the delivery address and delivery note of a delivery order.
 * Empty unless `enabled`, the `kot_show_customer_contact` setting.
 */
export function kotContactLines(order: unknown, enabled: boolean): KotContactLine[] {
  if (!enabled) return [];
  const row = (order ?? {}) as {
    type?: unknown;
    delivery_address?: unknown;
    delivery_note?: unknown;
    customer?: { phone?: unknown; country_code?: unknown } | null;
  };
  const number = text(row.customer?.phone);
  const countryCode = text(row.customer?.country_code);
  const phone =
    number && countryCode && !number.startsWith(countryCode) ? `${countryCode} ${number}` : number;
  const isDelivery = text(row.type) === 'delivery';
  const lines: KotContactLine[] = [
    { concept: 'print.numberShort', text: phone },
    { concept: 'print.deliverySlip.address', text: isDelivery ? text(row.delivery_address) : '' },
    { concept: 'print.deliverySlip.deliveryNote', text: isDelivery ? text(row.delivery_note) : '' },
  ];
  return lines.filter((line) => line.text.length > 0);
}
