/**
 * The pizza home's size buttons: the price most pizzas share at a size is shown
 * once, in the Half & Half legend, and a button shows a price only where its
 * pizza differs from that.
 *
 * Run: npm run test:pizza-home
 */
const { assertEqualOrThrow, loadFrontend, runCases } = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');

loadFrontend();
const { sizeLabel, standardPrices, tilePrice } = require('../frontend/src/lib/pizza/pizza-home');

const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(
    isDeepStrictEqual(actual, expected),
    true,
    `${message} (got ${JSON.stringify(actual)})`,
  );

let next = 0;
const variant = (name: string, price: number, extra: Record<string, unknown> = {}) => ({
  id: `v-${(next += 1)}`,
  name,
  price,
  online_price: null,
  is_active: true,
  ...extra,
});
const pizza = (prices: [number, number, number], extra: Record<string, unknown>[] = []) => ({
  id: `p-${(next += 1)}`,
  price: prices[0],
  variants: ['Small', 'Medium', 'Large'].map((name, at) => variant(name, prices[at], extra[at])),
});
const entries = (prices: Map<string, number>) => [...prices.entries()];

runCases('pizza-home', {
  'Case 1: the price most pizzas share at each size is the standard, in menu size order': () => {
    const menu = [pizza([15, 19, 23]), pizza([15, 19, 23]), pizza([16, 21, 25])];
    same(
      entries(standardPrices(menu, false)),
      [
        ['Small', 15],
        ['Medium', 19],
        ['Large', 23],
      ],
      'two of three pizzas share each price',
    );
  },

  'Case 2: a price only one pizza has, or a tie, is no standard': () => {
    same(entries(standardPrices([pizza([15, 19, 23])], false)), [], 'one pizza sets no standard');
    same(
      entries(standardPrices([pizza([15, 19, 23]), pizza([16, 19, 24])], false)),
      [['Medium', 19]],
      'sizes where the two disagree have no standard',
    );
    same(entries(standardPrices([], false)), [], 'no pizzas, no standard');
  },

  'Case 3: an online order counts the online price, as the cart charges it': () => {
    const online = [{ online_price: 18 }, { online_price: 22 }, { online_price: 26 }];
    const menu = [pizza([15, 19, 23], online), pizza([15, 19, 23], online), pizza([15, 19, 23])];
    same(
      entries(standardPrices(menu, true)),
      [
        ['Small', 18],
        ['Medium', 22],
        ['Large', 26],
      ],
      'online prices make the standard on an online order',
    );
    same(entries(standardPrices(menu, false))[2], ['Large', 23], 'a counter order ignores them');
  },

  'Case 4: a size switched off is not counted': () => {
    const off = [{}, {}, { is_active: false }];
    const menu = [pizza([15, 19, 30], off), pizza([15, 19, 30], off), pizza([15, 19, 23])];
    same(entries(standardPrices(menu, false))[2], undefined, 'no Large is on sale twice');
  },

  'Case 5: a button shows its price only where it differs from the standard': () => {
    const usual = pizza([15, 19, 23]);
    const dear = pizza([15, 19, 25]);
    const standard = standardPrices([usual, pizza([15, 19, 23]), dear], false);
    const large = (product: ReturnType<typeof pizza>) => product.variants[2];
    assertEqualOrThrow(tilePrice(usual, large(usual), standard, false), null, 'the usual Large');
    assertEqualOrThrow(tilePrice(dear, large(dear), standard, false), 25, 'the dearer Large');
    assertEqualOrThrow(
      tilePrice(dear, dear.variants[0], new Map(), false),
      15,
      'with no standard every button shows its price',
    );
    const online = pizza([15, 19, 23], [{}, {}, { online_price: 27 }]);
    assertEqualOrThrow(
      tilePrice(online, large(online), standard, true),
      27,
      'an online price that differs is shown',
    );
  },

  'Case 6: common size names get a one- or two-letter label, any other keeps its name': () => {
    for (const [name, label] of [
      ['Small', 'S'],
      ['Medium', 'M'],
      ['Large', 'L'],
      ['Extra Large', 'XL'],
      [' large ', 'L'],
      ['Family', 'Family'],
      ['Party Size', 'Party Size'],
    ])
      assertEqualOrThrow(sizeLabel(name), label, `the label of "${name}"`);
  },
});
