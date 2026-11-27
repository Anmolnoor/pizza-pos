/**
 * Pay at pickup / Pay on delivery: when the button shows, the note it adds, the order request it
 * sends, and which way a press goes when an earlier attempt is still saved.
 *
 * Run: npm run test:pizza-pay-later
 */
const { assertEqualOrThrow, loadFrontend, runCases } = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');

loadFrontend();
const {
  buildPostpaidOrderPayload,
  finishEarlierMessage,
  payLaterKind,
  payLaterKindFor,
  payLaterNote,
  payLaterNoteOverflow,
  resolvePlaceRoute,
  unscheduledPostpaidFingerprints,
} = require('../frontend/src/lib/pizza/pay-later');
const { cartItemToOrderItem } = require('../frontend/src/lib/cart-order-item');

const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(
    isDeepStrictEqual(actual, expected),
    true,
    `${message} (got ${JSON.stringify(actual)})`,
  );

const MARKER = 'Pay at pickup';

const cart = (extra: Record<string, unknown> = {}) => ({
  items: [
    {
      product: { id: 'pz-garden' },
      variant: { id: 'pz-garden-l' },
      quantity: 1,
      addons: [],
      special_instructions: '',
    },
  ],
  orderType: 'takeaway',
  tableId: null,
  customerId: 7,
  guestCount: 1,
  deliveryAddress: '',
  expectedPaymentMethod: '',
  expectedPaymentMethodId: null,
  deliveryNote: '',
  onlinePlatform: '',
  externalOrderId: '',
  orderNotes: 'extra napkins',
  scheduledFor: '2026-11-28T18:30',
  waivedChargeIds: new Set<string>(),
  optedInChargeIds: new Set<string>(),
  ...extra,
});

/** The order request the POS page built inline before this change, key for key. */
const legacyPayload = (c: ReturnType<typeof cart>, scheduledFor: string | undefined) => ({
  table_id: c.tableId,
  customer_id: c.customerId,
  type: c.orderType,
  guest_count: c.guestCount,
  special_instructions: c.orderNotes || undefined,
  online_platform: undefined,
  external_order_id: undefined,
  delivery_address: c.orderType === 'delivery' ? c.deliveryAddress || undefined : undefined,
  expected_payment_method:
    c.orderType === 'delivery' ? c.expectedPaymentMethod || undefined : undefined,
  expected_payment_method_id:
    c.orderType === 'delivery' ? (c.expectedPaymentMethodId ?? undefined) : undefined,
  delivery_note: c.orderType === 'delivery' ? c.deliveryNote || undefined : undefined,
  scheduled_for: scheduledFor,
  waived_charge_ids: [],
  opted_in_charge_ids: [],
  items: c.items.map(cartItemToOrderItem),
});

const shown = (extra: Record<string, unknown> = {}) =>
  payLaterKind({
    pizza: true,
    billingType: 'prepaid',
    orderType: 'takeaway',
    editing: false,
    multiCounterEnabled: false,
    ...extra,
  });

const route = (extra: Record<string, unknown> = {}) =>
  resolvePlaceRoute({
    payLater: false,
    eligible: true,
    prepaidMatch: false,
    postpaidMatchMarked: false,
    postpaidMatchPlain: false,
    storageError: false,
    ...extra,
  });

runCases('pizza-pay-later', {
  'the button shows for a pizza pickup or delivery order in prepaid billing only'() {
    same(shown(), 'pickup', 'takeaway is pickup');
    same(shown({ orderType: 'delivery' }), 'delivery', 'delivery');
    same(shown({ orderType: 'dine_in' }), null, 'no dine in');
    same(shown({ orderType: 'online' }), null, 'no online order');
    same(shown({ pizza: false }), null, 'not on the upstream POS');
    same(shown({ billingType: 'postpaid' }), null, 'postpaid already places unpaid');
    same(shown({ editing: true }), null, 'not while adding to an order');
    same(shown({ multiCounterEnabled: true }), null, 'not with multi-counter');
    same(payLaterKindFor('takeaway'), 'pickup', 'the marker follows the order type');
    same(payLaterKindFor('dine_in'), null, 'no marker for dine in');
  },

  'the note puts the marker before what the cashier typed'() {
    same(payLaterNote('', MARKER), 'Pay at pickup', 'marker alone');
    same(payLaterNote('  ', MARKER), 'Pay at pickup', 'blank note is no note');
    same(payLaterNote('no onions', MARKER), 'Pay at pickup · no onions', 'marker then note');
  },

  'a note that would pass 200 characters with the marker says by how much'() {
    const fits = 'x'.repeat(200 - 'Pay at pickup · '.length);
    same(payLaterNoteOverflow(fits, MARKER), 0, 'exactly 200 fits');
    same(payLaterNoteOverflow(`${fits}y`, MARKER), 1, '201 is one over');
    same(payLaterNoteOverflow('', MARKER), 0, 'no note fits');
  },

  'the order request is the one the page built, and the marker changes only the note'() {
    const c = cart();
    const plain = buildPostpaidOrderPayload(c, { scheduledOrdersEnabled: true });
    same(
      JSON.stringify(plain),
      JSON.stringify(legacyPayload(c, '2026-11-28T18:30')),
      'unmarked equals the legacy request, key order included',
    );
    const marked = buildPostpaidOrderPayload(c, { scheduledOrdersEnabled: true, marker: MARKER });
    same(
      JSON.stringify(marked),
      JSON.stringify({ ...plain, special_instructions: 'Pay at pickup · extra napkins' }),
      'marked differs only in the note',
    );
    same(
      buildPostpaidOrderPayload(c, { scheduledOrdersEnabled: false }).scheduled_for,
      undefined,
      'no slot when scheduled orders are off',
    );
  },

  'the unscheduled fingerprints match the page’s past-slot check, plain and marked'() {
    const c = cart();
    const { plain, marked } = unscheduledPostpaidFingerprints(c, {
      scheduledOrdersEnabled: true,
      marker: MARKER,
    });
    same(plain, JSON.stringify(legacyPayload(c, undefined)), 'plain has no slot');
    same(
      marked,
      JSON.stringify({
        ...legacyPayload(c, undefined),
        special_instructions: 'Pay at pickup · extra napkins',
      }),
      'marked has no slot and the marker',
    );
    same(
      unscheduledPostpaidFingerprints(c, { scheduledOrdersEnabled: true }).marked,
      undefined,
      'no marker, no marked fingerprint',
    );
  },

  'a saved attempt that matches decides first, whatever the button'() {
    same(
      route({ storageError: true, postpaidMatchMarked: true }),
      'storage-error',
      'storage first',
    );
    same(route({ postpaidMatchMarked: true }), 'replay-marked', 'Place Order replays pay later');
    same(
      route({ payLater: true, postpaidMatchMarked: true }),
      'replay-marked',
      'and so does Pay later',
    );
    same(
      route({ eligible: false, postpaidMatchMarked: true }),
      'replay-marked',
      'after a switch to postpaid billing too',
    );
    same(route({ payLater: true, postpaidMatchPlain: true }), 'replay-plain', 'plain stays plain');
    same(route({ postpaidMatchPlain: true }), 'replay-plain', 'from Place Order as well');
    same(
      route({ payLater: true, prepaidMatch: true }),
      'resume-prepaid',
      'an unpaid prepaid checkout for this cart is finished, not doubled',
    );
    same(route({ prepaidMatch: true }), 'default', 'Place Order resumes it the usual way');
    same(route({ payLater: true }), 'fresh-pay-later', 'a fresh pay later');
    same(route({ payLater: true, eligible: false }), 'default', 'not eligible now');
    same(route(), 'default', 'Place Order with nothing saved');
  },

  'the finish-first message names the order when it is known'() {
    same(
      finishEarlierMessage({ order: { order_number: 'A-12' } }),
      { key: 'finishPaymentForOrder', values: { number: 'A-12' } },
      'known order',
    );
    same(finishEarlierMessage({}), { key: 'finishEarlierCheckout', values: {} }, 'order unknown');
    same(finishEarlierMessage(null), { key: 'finishEarlierCheckout', values: {} }, 'no attempt');
  },
});
