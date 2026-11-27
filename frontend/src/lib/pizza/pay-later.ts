/**
 * Pay at pickup / Pay on delivery: a pizza order placed now, sent to the kitchen, and paid later
 * from Orders -> Unpaid. It goes through the POS page's postpaid order request with a marker at
 * the front of the order note, so the kitchen ticket, the order card and the delivery slip say so.
 */
import { cartItemToOrderItem } from '@/lib/cart-order-item';
import { resolveRetryScheduledFor, type CartStateForFingerprint } from '@/lib/order-attempt';

export type PayLaterKind = 'pickup' | 'delivery';

/** What a press asks of the POS page's order placement. */
export interface PlaceOptions {
  payLater?: boolean;
}

/** The note boxes' `maxLength` and the server's default `max_order_notes_length`. */
export const PAY_LATER_NOTE_LIMIT = 200;
const SEPARATOR = ' · ';

export const payLaterKindFor = (orderType: string): PayLaterKind | null =>
  orderType === 'takeaway' ? 'pickup' : orderType === 'delivery' ? 'delivery' : null;

/** Whether the pizza cart offers the button: prepaid billing, a new pickup or delivery order. */
export function payLaterKind(state: {
  pizza: boolean;
  billingType: string;
  orderType: string;
  editing: boolean;
  multiCounterEnabled: boolean;
}): PayLaterKind | null {
  if (!state.pizza || state.billingType !== 'prepaid' || state.editing) return null;
  if (state.multiCounterEnabled) return null;
  return payLaterKindFor(state.orderType);
}

export const payLaterNote = (note: string, marker: string): string =>
  note.trim() ? `${marker}${SEPARATOR}${note}` : marker;

/** How many characters the cashier's note has to lose for the marker to fit; 0 when it fits. */
export const payLaterNoteOverflow = (note: string, marker: string, limit = PAY_LATER_NOTE_LIMIT) =>
  Math.max(0, payLaterNote(note, marker).length - limit);

/**
 * The postpaid `POST /orders` body, built the one way for sending and for matching a saved
 * attempt. With a marker, only the order note changes. Its slot is the cart's; the page puts a
 * saved attempt's slot back after a match.
 */
export function buildPostpaidOrderPayload(
  cart: CartStateForFingerprint,
  options: { scheduledOrdersEnabled: boolean; marker?: string },
) {
  const notes = options.marker
    ? payLaterNote(cart.orderNotes ?? '', options.marker)
    : cart.orderNotes;
  return {
    table_id: cart.tableId,
    customer_id: cart.customerId,
    type: cart.orderType,
    guest_count: cart.guestCount,
    special_instructions: notes || undefined,
    online_platform: cart.orderType === 'online' ? cart.onlinePlatform || undefined : undefined,
    external_order_id: cart.orderType === 'online' ? cart.externalOrderId || undefined : undefined,
    delivery_address: cart.orderType === 'delivery' ? cart.deliveryAddress || undefined : undefined,
    expected_payment_method:
      cart.orderType === 'delivery' ? cart.expectedPaymentMethod || undefined : undefined,
    expected_payment_method_id:
      cart.orderType === 'delivery' ? (cart.expectedPaymentMethodId ?? undefined) : undefined,
    delivery_note: cart.orderType === 'delivery' ? cart.deliveryNote || undefined : undefined,
    scheduled_for: resolveRetryScheduledFor({
      orderType: cart.orderType,
      scheduledOrdersEnabled: options.scheduledOrdersEnabled,
      cartScheduledFor: cart.scheduledFor,
    }),
    waived_charge_ids: Array.from(cart.waivedChargeIds),
    opted_in_charge_ids: Array.from(cart.optedInChargeIds),
    items: cart.items.map(cartItemToOrderItem),
  };
}

/** The request with no slot, plain and (given a marker) marked, for the page's past-slot check. */
export function unscheduledPostpaidFingerprints(
  cart: CartStateForFingerprint,
  options: { scheduledOrdersEnabled: boolean; marker?: string },
) {
  const unscheduled = { ...cart, scheduledFor: '' };
  const plain = JSON.stringify(
    buildPostpaidOrderPayload(unscheduled, {
      scheduledOrdersEnabled: options.scheduledOrdersEnabled,
    }),
  );
  const marked = options.marker
    ? JSON.stringify(buildPostpaidOrderPayload(unscheduled, options))
    : undefined;
  return { plain, marked };
}

export type PlaceRoute =
  | 'storage-error'
  | 'replay-marked'
  | 'replay-plain'
  | 'resume-prepaid'
  | 'fresh-pay-later'
  | 'default';

/**
 * Which way a press on the pizza cart goes. A saved postpaid attempt that matches this cart is
 * replayed as it was sent, whichever button and billing mode, so a lost response never becomes a
 * second order; a pay-later press on a cart with an unfinished prepaid checkout resumes that.
 */
export function resolvePlaceRoute(input: {
  payLater: boolean;
  eligible: boolean;
  prepaidMatch: boolean;
  postpaidMatchMarked: boolean;
  postpaidMatchPlain: boolean;
  storageError: boolean;
}): PlaceRoute {
  if (input.storageError) return 'storage-error';
  if (input.postpaidMatchMarked) return 'replay-marked';
  if (input.postpaidMatchPlain) return 'replay-plain';
  if (!input.payLater) return 'default';
  if (input.prepaidMatch) return 'resume-prepaid';
  return input.eligible ? 'fresh-pay-later' : 'default';
}

export function finishEarlierMessage(
  attempt: { order?: { order_number?: string | number } } | null,
): { key: 'finishPaymentForOrder' | 'finishEarlierCheckout'; values: Record<string, string> } {
  const number = attempt?.order?.order_number;
  return number != null && number !== ''
    ? { key: 'finishPaymentForOrder', values: { number: String(number) } }
    : { key: 'finishEarlierCheckout', values: {} };
}
