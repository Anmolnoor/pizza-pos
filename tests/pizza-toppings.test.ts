/**
 * Extra and added toppings: the menu's toppings list, the recipe that records
 * them, the ticket text, and the sheet that builds them.
 *
 * Run: npm run test:pizza-toppings
 */
const { assertOrThrow, assertEqualOrThrow, runCases } = require('./helpers/pizza-print-harness');
const { MenuError, parseMenuFile } = require('../shared/pizza/menu');
const { RecipeError, validateRecipe, recipeKey } = require('../shared/pizza/recipe');
const { toppingCounts } = require('../shared/pizza/toppings');
const sample = require('./fixtures/pizza-sample-menu.json');

const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(JSON.stringify(actual), JSON.stringify(expected), message);

const catalog = () => parseMenuFile(sample);
const part = (pizzaId: string, more: object = {}) => ({ pizzaId, removed: [], ...more });
const pizza = (parts: object) => ({ kind: 'pizza', v: 1, sizeId: 'large', ...parts });
const whole = (pizzaId: string, more: object = {}) => pizza({ whole: part(pizzaId, more) });
const halves = (first: object, second: object) => pizza({ halves: [first, second] });

function menuRejected(change: (menu: any) => void, expectedPath: string, message: string) {
  const menu = structuredClone(sample);
  change(menu);
  let error: any;
  try {
    parseMenuFile(menu);
  } catch (caught) {
    error = caught;
  }
  assertOrThrow(error instanceof MenuError, `${message}: rejected with a MenuError`);
  assertEqualOrThrow(error.path, expectedPath, `${message}: names the entry`);
  return error;
}

function refused(raw: unknown, expected: string, message: string) {
  let error: any;
  try {
    validateRecipe(catalog(), raw);
  } catch (caught) {
    error = caught;
  }
  assertOrThrow(error instanceof RecipeError, `${message}: refused with a RecipeError`);
  assertEqualOrThrow(error.message, expected, `${message}: says what to do`);
}

runCases('Pizza toppings', {
  'Case 1: the menu lists the toppings and their one price': () => {
    const { toppings } = catalog();
    assertEqualOrThrow(toppings.priceCents, 225, 'the topping price in whole cents');
    assertEqualOrThrow(toppings.items.length, 8, 'eight toppings');
    same(toppings.items[5], { id: 'banana-peppers', label: 'Banana Peppers' }, 'id and name');

    const without = structuredClone(sample);
    delete without.toppings;
    const plain = parseMenuFile(without);
    assertOrThrow(!('toppings' in plain), 'a menu without toppings loads, with no toppings field');

    const items = (menu: any) => menu.toppings.items;
    menuRejected((menu) => (menu.toppings = []), 'toppings', 'toppings as a bare list');
    menuRejected((menu) => (menu.toppings.price = 2.255), 'toppings.price', 'a fraction of a cent');
    menuRejected((menu) => delete menu.toppings.price, 'toppings.price', 'no price');
    menuRejected((menu) => (menu.toppings.price = -1), 'toppings.price', 'a negative price');
    menuRejected((menu) => (items(menu)[1].id = 'Bacon'), 'toppings.items[1].id', 'a bad id');
    menuRejected((menu) => (items(menu)[1].name = ''), 'toppings.items[1].name', 'an empty name');
    menuRejected(
      (menu) => (items(menu)[1].name = 'Bacon\nbits'),
      'toppings.items[1].name',
      'a line break in a name',
    );
    menuRejected((menu) => (items(menu)[2].id = 'bacon'), 'toppings.items[2].id', 'an id twice');
    const grown = (count: number) => (menu: any) =>
      (menu.toppings.items = Array.from({ length: count }, (_, index) => ({
        id: `topping-${index}`,
        name: `Topping ${index}`,
      })));
    const tooMany = menuRejected(grown(61), 'toppings.items', '61 toppings');
    assertOrThrow(tooMany.message.includes('at most 60'), 'the message gives the cap');
    const most = structuredClone(sample);
    grown(60)(most);
    assertEqualOrThrow(parseMenuFile(most).toppings.items.length, 60, '60 toppings are accepted');
  },

  'Case 2: a recipe records extras and added toppings, sorted and without duplicates': () => {
    const raw = whole('garden', {
      removed: ['Olives'],
      extra: ['Onions', 'Cheese', 'Onions'],
      added: ['feta', 'bacon', 'feta'],
    });
    const before = JSON.stringify(raw);
    same(
      validateRecipe(catalog(), raw),
      pizza({
        whole: {
          pizzaId: 'garden',
          removed: ['Olives'],
          extra: ['Cheese', 'Onions'],
          added: ['bacon', 'feta'],
        },
      }),
      'the normalised copy',
    );
    assertEqualOrThrow(JSON.stringify(raw), before, 'the input is not changed');

    const half = validateRecipe(
      catalog(),
      halves(part('island', { added: ['bacon'] }), part('classic', { extra: ['Cheese'] })),
    );
    same(
      half.halves,
      [
        { pizzaId: 'island', removed: [], added: ['bacon'] },
        { pizzaId: 'classic', removed: [], extra: ['Cheese'] },
      ],
      'each half keeps its own',
    );
  },

  'Case 3: a recipe stored before toppings is unchanged and means the same': () => {
    const old = whole('garden', { removed: ['Olives'] });
    same(validateRecipe(catalog(), old), old, 'no new field appears');
    same(
      validateRecipe(catalog(), whole('garden', { removed: ['Olives'], extra: [], added: [] })),
      old,
      'an empty list is an absent one',
    );
    assertEqualOrThrow(
      recipeKey(old),
      '{"kind":"pizza","v":1,"sizeId":"large","whole":{"pizzaId":"garden","removed":["Olives"]}}',
      'and its key is the key it always had',
    );
    assertEqualOrThrow(
      recipeKey(whole('garden', { removed: ['Olives'], extra: [], added: [] })),
      recipeKey(old),
      'with or without empty lists',
    );
    const without = structuredClone(sample);
    delete without.toppings;
    same(validateRecipe(parseMenuFile(without), old), old, 'also on a menu without toppings');
  },

  'Case 4: each refusal says what to do': () => {
    refused(
      whole('island', { extra: ['Olives'] }),
      'Island does not have that ingredient. Choose what to make extra again',
      'an extra of an ingredient the pizza does not have',
    );
    refused(
      whole('garden', { removed: ['Olives'], extra: ['Olives'] }),
      'Olives cannot be both removed and extra. Choose one',
      'an ingredient both removed and extra',
    );
    refused(
      whole('garden', { added: ['gold-leaf'] }),
      'That topping is not on the menu. Pick another topping',
      'a topping the menu does not list',
    );
    refused(
      whole('garden', { added: ['mushrooms'] }),
      'Garden already has Mushrooms. Choose extra Mushrooms instead',
      'a topping that is already an ingredient',
    );
    refused(
      halves(part('island'), part('garden', { added: ['mushrooms'] })),
      'Second half: Garden already has Mushrooms. Choose extra Mushrooms instead',
      'the same on a half, naming the half',
    );
    refused(
      whole('garden', { extra: 'Cheese' }),
      'This item could not be read. Remove it and add it again',
      'extras that are not a list',
    );
    refused(
      whole('garden', { added: [7] }),
      'That topping is not on the menu. Pick another topping',
      'a topping that is not text',
    );

    const without = structuredClone(sample);
    delete without.toppings;
    let error: any;
    try {
      validateRecipe(parseMenuFile(without), whole('garden', { added: ['bacon'] }));
    } catch (caught) {
      error = caught;
    }
    assertOrThrow(error instanceof RecipeError, 'a menu without toppings takes no added topping');

    assertEqualOrThrow(
      validateRecipe(catalog(), whole('island', { added: ['mushrooms'] })).whole.added[0],
      'mushrooms',
      'the same topping goes on a pizza that does not have it',
    );
  },

  'Case 5: the key differs when an extra or a topping differs, not when only the order does':
    () => {
      const key = (more: object) => recipeKey(validateRecipe(catalog(), whole('garden', more)));
      const plain = key({});
      assertOrThrow(key({ extra: ['Cheese'] }) !== plain, 'an extra changes the key');
      assertOrThrow(key({ added: ['bacon'] }) !== plain, 'an added topping changes the key');
      assertOrThrow(
        key({ extra: ['Cheese'] }) !== key({ extra: ['Onions'] }),
        'which extra counts',
      );
      assertOrThrow(key({ added: ['bacon'] }) !== key({ added: ['feta'] }), 'which topping counts');
      assertEqualOrThrow(
        key({ extra: ['Onions', 'Cheese'], added: ['feta', 'bacon'] }),
        key({ extra: ['Cheese', 'Onions'], added: ['bacon', 'feta'] }),
        'the order they were tapped in does not',
      );
      assertEqualOrThrow(
        recipeKey(whole('garden', { extra: ['Onions', 'Cheese'] })),
        recipeKey(whole('garden', { extra: ['Cheese', 'Onions'] })),
        'recipeKey itself sorts',
      );
    },

  'Case 6: identical halves are compared whole, extras and toppings included': () => {
    const same = 'Both halves are the same. Choose a whole pizza instead';
    refused(
      halves(part('garden', { extra: ['Cheese'] }), part('garden', { extra: ['Cheese'] })),
      same,
      'two halves with the same extra',
    );
    refused(
      halves(
        part('island', { added: ['feta', 'bacon'] }),
        part('island', { added: ['bacon', 'feta'] }),
      ),
      same,
      'two halves with the same toppings in another order',
    );
    for (const more of [{ extra: ['Cheese'] }, { added: ['bacon'] }])
      assertOrThrow(
        validateRecipe(catalog(), halves(part('garden'), part('garden', more))).halves,
        `halves that differ only by ${JSON.stringify(more)} are allowed`,
      );
  },

  'Case 7: at most ten toppings are added to one pizza or half': () => {
    const many = structuredClone(sample);
    many.toppings.items = Array.from({ length: 11 }, (_, index) => ({
      id: `topping-${index}`,
      name: `Topping ${index}`,
    }));
    const menu = parseMenuFile(many);
    const ids = many.toppings.items.map((item: any) => item.id);
    assertEqualOrThrow(
      validateRecipe(menu, whole('garden', { added: ids.slice(0, 10) })).whole.added.length,
      10,
      'ten are accepted',
    );
    let error: any;
    try {
      validateRecipe(menu, whole('garden', { added: ids }));
    } catch (caught) {
      error = caught;
    }
    assertOrThrow(error instanceof RecipeError, 'eleven are refused');
    assertEqualOrThrow(
      error.message,
      'A pizza takes at most 10 added toppings. Take one off',
      'in words a cashier can act on',
    );
  },

  'Case 8: what a recipe is charged: whole toppings and half toppings': () => {
    same(toppingCounts(null), { whole: 0, half: 0 }, 'no recipe, no toppings');
    same(
      toppingCounts(whole('garden', { removed: ['Olives'] })),
      { whole: 0, half: 0 },
      'a removal is free',
    );
    same(
      toppingCounts(whole('garden', { extra: ['Cheese'], added: ['bacon'] })),
      { whole: 2, half: 0 },
      'an extra and an added topping on a whole pizza',
    );
    same(
      toppingCounts(
        halves(part('island', { added: ['bacon'] }), part('classic', { extra: ['Cheese'] })),
      ),
      { whole: 0, half: 2 },
      'one on each half',
    );
    same(
      toppingCounts({
        kind: 'deal',
        v: 1,
        dealId: 'three-large-wings',
        pizzas: [
          whole('garden', { extra: ['Cheese', 'Onions'] }),
          halves(part('island', { added: ['bacon', 'feta'] }), part('plain', { added: ['feta'] })),
          whole('classic'),
        ],
      }),
      { whole: 2, half: 3 },
      "a deal adds up its pizzas'",
    );
  },
});
