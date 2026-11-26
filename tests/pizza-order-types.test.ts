/**
 * The order types the POS switch offers: the store's `pos_order_types` setting
 * narrows them, the first one offered is the default for a new order, and an
 * order that already has a hidden type keeps it.
 *
 * Run: npm run test:pizza-order-types
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  runCases,
} = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');

const frontend = loadFrontend();
const { offeredOrderTypes } = require('../frontend/src/lib/pizza/order-types');

const ALL = ['dine_in', 'takeaway', 'delivery', 'online'];
const COUNTER = ['takeaway', 'delivery'];
const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(isDeepStrictEqual(actual, expected), `${message} (got ${JSON.stringify(actual)})`);
const store = () => frontend.posSettings.usePosSettingsStore.getState();

runCases('pizza-order-types', {
  'Case 1: with no setting every type is offered, as upstream does': () => {
    same(offeredOrderTypes(ALL, []), ALL, 'an empty setting hides nothing');
    same(offeredOrderTypes(ALL, ['curbside']), ALL, 'a setting that names no known type too');
  },

  'Case 2: a counter store offers takeaway and delivery, takeaway first': () => {
    same(offeredOrderTypes(ALL, COUNTER), COUNTER, 'dine-in and online are hidden');
    same(offeredOrderTypes(ALL, ['delivery', 'takeaway']), COUNTER, 'in the switch order');
    same(
      offeredOrderTypes(['takeaway', 'delivery', 'online'], ['dine_in', 'online']),
      ['online'],
      'a type the store never had is not brought back',
    );
  },

  'Case 3: an order that already has a hidden type keeps it on the switch': () => {
    same(offeredOrderTypes(ALL, COUNTER, 'dine_in'), ['dine_in', ...COUNTER], 'dine-in order');
    same(offeredOrderTypes(ALL, COUNTER, 'delivery'), COUNTER, 'an offered type adds nothing');
    same(offeredOrderTypes(ALL, COUNTER, null), COUNTER, 'a new order adds nothing');
  },

  'Case 4: the browser store takes the setting from the business settings': () => {
    same(store().posOrderTypes, [], 'it starts with every type offered');
    store().hydrateReceiptSettings({ pos_order_types: COUNTER });
    same(store().posOrderTypes, COUNTER, 'the list is stored');
    store().hydrateReceiptSettings({ bill_show_name: true });
    same(store().posOrderTypes, COUNTER, 'a response without the key leaves it');
    store().hydrateReceiptSettings({ pos_order_types: [] });
    assertEqualOrThrow(store().posOrderTypes.length, 0, 'an empty list offers every type again');
  },
});
