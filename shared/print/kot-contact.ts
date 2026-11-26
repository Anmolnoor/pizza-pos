/** Customer contact facts a kitchen ticket header prints when the merchant opts in. */

import { stripControlBytes } from './detail-lines';

/** One labelled header line; `concept` names an existing print label. */
export interface KotContactLine {
  readonly concept:
    | 'print.numberShort'
    | 'print.deliverySlip.address'
    | 'print.deliverySlip.deliveryNote';
  readonly text: string;
}

/** One line of text: a stored line break becomes a space, so the two parts do not run together. */
const text = (value: unknown): string =>
  typeof value === 'string' ? stripControlBytes(value.replace(/\s+/g, ' ')).trim() : '';

/**
 * Contact lines for a raw order: the customer's phone number when the order
 * has one, then the delivery address and delivery note of a delivery order.
 * `show` is the `kot_show_customer_contact` setting: `true` prints them, `'delivery'`
 * prints them on delivery orders only, and anything else prints none.
 */
export function kotContactLines(order: unknown, show: unknown): KotContactLine[] {
  const row = (order ?? {}) as {
    type?: unknown;
    delivery_address?: unknown;
    delivery_note?: unknown;
    customer?: { phone?: unknown } | null;
  };
  const phone = text(row.customer?.phone);
  const isDelivery = text(row.type) === 'delivery';
  if (show !== true && !(show === 'delivery' && isDelivery)) return [];
  const lines: KotContactLine[] = [
    { concept: 'print.numberShort', text: phone },
    { concept: 'print.deliverySlip.address', text: isDelivery ? text(row.delivery_address) : '' },
    { concept: 'print.deliverySlip.deliveryNote', text: isDelivery ? text(row.delivery_note) : '' },
  ];
  return lines.filter((line) => line.text.length > 0);
}

/**
 * `PICKUP 6:30 PM` or `DELIVERY 6:30 PM` for a scheduled takeaway or delivery order, in the
 * store's time zone and the locale's clock format; null for any other order.
 */
export function kotScheduleLine(order: unknown, locale: string, timeZone?: string): string | null {
  const row = (order ?? {}) as { type?: unknown; scheduled_for?: unknown };
  const type = text(row.type);
  const word = type === 'takeaway' ? 'PICKUP' : type === 'delivery' ? 'DELIVERY' : null;
  // A stored instant is UTC, with or without the zone written out.
  const at = new Date(text(row.scheduled_for).replace(/^(\S+) (\S+)$/, '$1T$2Z'));
  if (!word || Number.isNaN(at.getTime())) return null;
  const time = new Intl.DateTimeFormat(`${locale}-u-nu-latn`, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(at);
  // Intl separates the day period with a narrow no-break space, which a thermal code page lacks.
  return `${word} ${time.replace(/\s/g, ' ')}`;
}
