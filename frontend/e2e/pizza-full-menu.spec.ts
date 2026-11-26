import {
  test,
  expect,
  request as playwrightRequest,
  type Locator,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import { clearPizzaMenu, loadSampleMenu, sampleMenu } from './helpers/pizza-menu';
import { getE2eToken, loginWithPassword, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * The pizza screens with a full-size menu: 26 pizzas and 8 deals, grown from
 * the made-up sample here. Every spec shares one database, so this one loads
 * the menu itself, cancels the order it places and clears the menu when it ends.
 */

const VIEW = { width: 1180, height: 820 };
const PIZZAS = 26;
const LONG = [7, 13, 22];
const nameOf = (number: number) =>
  `Sample Pizza ${number}${LONG.includes(number) ? ' Extra Long Made-Up Name' : ''}`;
const LONG_NAME = nameOf(7);

const menu = sampleMenu();
const itemsOf = (id: string) => menu.categories.find((category) => category.id === id)!.items;
const pizzas = itemsOf('pizzas');
const deals = itemsOf('deals');
for (let number = pizzas.length + 1; number <= PIZZAS; number += 1) {
  pizzas.push({
    ...pizzas[number % 4],
    id: `sample-pizza-${number}`,
    number,
    name: nameOf(number),
  });
}
for (let number = deals.length + 1; number <= 8; number += 1) {
  deals.push({
    ...deals[number % 4],
    id: `sample-deal-${number}`,
    name: `Sample Deal ${number}`,
    description: `Made-up deal ${number}: sample pizzas, a sample salad, sample garlic toast & pops for the table`,
  });
}
const THREE = deals.find((deal) => deal.id === 'three-large-wings')!;

/** Screenshots are saved only when a folder outside the checkout is named. */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;
const headers = () => ({ Authorization: `Bearer ${getE2eToken()}` });

test.use({ viewport: VIEW });

test.beforeAll(async () => {
  expect(LONG_NAME.length).toBeGreaterThanOrEqual(35);
  expect(LONG_NAME.length).toBeLessThanOrEqual(40);
  const api = await playwrightRequest.newContext();
  await loadSampleMenu(api, menu);
  await api.dispose();
});

test.afterAll(async () => {
  const api = await playwrightRequest.newContext();
  try {
    await clearPizzaMenu(api);
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ page }) => {
  await loginWithPassword(page, 'owner@flo.local');
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pizza-category-blocks')).toBeVisible();
  await expect(page.getByTestId('pizza-tile')).toHaveCount(PIZZAS);
});

async function shot(page: Page, name: string): Promise<void> {
  if (EVIDENCE_DIR)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, name), animations: 'disabled' });
}

/** A number the report quotes, kept with the test's result. */
const measured = (name: string, value: number) => {
  test.info().annotations.push({ type: name, description: String(value) });
  console.log(`[measured] ${name}: ${value}`);
};

const halfTile = (page: Page): Locator => page.getByTestId('pizza-half-tile');
const dealTiles = (page: Page): Locator => page.getByTestId('pos-product-card');

/** How many of these lie wholly inside the viewport. */
const whollyVisible = (tiles: Locator): Promise<number> =>
  tiles.evaluateAll(
    (elements) =>
      elements.filter((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.top >= 0 &&
          box.left >= 0 &&
          box.bottom <= window.innerHeight &&
          box.right <= window.innerWidth
        );
      }).length,
  );

const tooSmall = (scope: Locator): Promise<(string | null)[]> =>
  scope.locator('button').evaluateAll((controls) =>
    controls
      .map((control) => ({ control, box: control.getBoundingClientRect() }))
      .filter(({ box }) => box.width < 48 || box.height < 48)
      .map(({ control }) => control.getAttribute('aria-label') || control.textContent),
  );

/**
 * Both halves chosen in the editor inside `scope`: each half's list gives way
 * to the pizza with its ingredient chips on screen, and Change brings the list back.
 */
async function bothHalvesFit(page: Page, scope: Locator, scroller: Locator): Promise<void> {
  const first = scope.getByRole('group', { name: '1st half' });
  const second = scope.getByRole('group', { name: '2nd half' });
  // A pizza in the list is named by its number and its name.
  const inList = (half: Locator, name: string) =>
    half.getByRole('button', { name: new RegExp(`(^|\\d )${name}$`) });

  // Nothing is chosen yet, so each half lists every pizza.
  await expect(inList(first, nameOf(26))).toBeVisible();
  await inList(first, LONG_NAME).click();
  await inList(second, 'Garden').click();
  const { content, room } = await scroller.evaluate((element) => ({
    content: element.scrollHeight,
    room: element.clientHeight,
  }));
  measured('editor content height', content);
  measured('editor room', room);
  expect(content, 'the editor does not scroll with both halves chosen').toBeLessThanOrEqual(room);

  // Sample Pizza 7 is made of the sample's Smokehouse Chicken.
  const chips: [Locator, string[]][] = [
    [first, ['Roasted chicken', 'BBQ sauce']],
    [second, ['Mushrooms', 'Tomato sauce']],
  ];
  for (const [half, ingredients] of chips) {
    await expect(inList(half, nameOf(26))).toHaveCount(0);
    await expect(half.getByRole('button', { name: 'Change' })).toBeVisible();
    for (const name of ingredients)
      await expect(half.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  await expect(first).toContainText(LONG_NAME);
  await expect(second).toContainText('Garden');
  expect(await tooSmall(scope)).toEqual([]);

  await second.getByRole('button', { name: 'Change' }).click();
  await expect(inList(second, 'Garden')).toHaveAttribute('aria-pressed', 'true');
  expect(await tooSmall(second), 'every pizza in the list is at least 48 px').toEqual([]);
  await inList(second, nameOf(26)).click();
  await expect(inList(second, 'Garden')).toHaveCount(0);
  await expect(second).toContainText(nameOf(26));
  await second.getByRole('button', { name: 'Change' }).click();
  await inList(second, 'Garden').click();
  await expect(second.getByRole('button', { name: 'Olives', exact: true })).toBeInViewport({
    ratio: 1,
  });
}

test('twelve pizzas fit a screen, Half & Half first, every control 48 px', async ({ page }) => {
  const tiles = page.getByTestId('pizza-tile');
  const visible = await whollyVisible(tiles);
  measured('pizza tiles wholly visible', visible);
  expect(visible).toBeGreaterThanOrEqual(12);

  const order = await page
    .locator('[data-testid="pizza-half-tile"], [data-testid="pizza-tile"]')
    .evaluateAll((all) => all.map((tile) => tile.getAttribute('data-testid')));
  expect(order[0], 'Half & Half comes before pizza number 1').toBe('pizza-half-tile');
  expect(await whollyVisible(halfTile(page))).toBe(1);
  const half = (await halfTile(page).boundingBox())!;
  const one = (await tiles.first().boundingBox())!;
  expect(half.y < one.y || (half.y === one.y && half.x < one.x)).toBeTruthy();

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    'the page does not scroll sideways',
  ).toBeLessThanOrEqual(0);
  expect(
    await page
      .locator('[data-testid="pos-catalog-scroll"], [data-testid="pizza-tile"]')
      .evaluateAll((all) => all.filter((one) => one.scrollWidth > one.clientWidth).length),
    'neither the list nor a tile overflows sideways',
  ).toBe(0);

  expect(await tooSmall(tiles)).toEqual([]);
  expect(await tooSmall(halfTile(page))).toEqual([]);
  const first = tiles.first();
  await expect(first.getByRole('button')).toHaveCount(4);
  await expect(first.getByRole('button', { name: 'Customize Garden' })).toBeVisible();
  for (const size of ['Small', 'Medium', 'Large'])
    await expect(first.getByRole('button', { name: new RegExp(`^Garden, ${size}`) })).toBeVisible();
  await shot(page, 'full-menu-home.png');
});

test('the pizza list is at most about two screens', async ({ page }) => {
  const { content, room } = await page
    .getByTestId('pos-catalog-scroll')
    .evaluate((element) => ({ content: element.scrollHeight, room: element.clientHeight }));
  measured('pizza list height', content);
  measured('pizza list room', room);
  expect(content / room).toBeLessThanOrEqual(2.1);
});

test('a long name is shown whole, on two lines at most', async ({ page }) => {
  for (const name of LONG.map(nameOf)) {
    const heading = page.getByRole('heading', { name, exact: true });
    await heading.scrollIntoViewIfNeeded();
    const { clipped, lines, text } = await heading.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clipped:
          element.scrollHeight > element.clientHeight + 1 ||
          element.scrollWidth > element.clientWidth + 1 ||
          style.textOverflow === 'ellipsis' ||
          style.webkitLineClamp !== 'none',
        lines: Math.round(element.getBoundingClientRect().height / parseFloat(style.lineHeight)),
        text: (element as HTMLElement).innerText,
      };
    });
    expect(text).toBe(name);
    expect(clipped, `${name} is not clipped or clamped`).toBe(false);
    expect(lines, `${name} takes two lines at most`).toBeLessThanOrEqual(2);
  }
});

test('in the sheet both halves show their ingredients without scrolling', async ({ page }) => {
  await halfTile(page).getByRole('button', { name: /Large/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Pizza' });
  await bothHalvesFit(page, sheet, sheet.getByTestId('pizza-sheet-body'));
  await shot(page, 'full-menu-sheet.png');
});

test("a deal's pizza tab does the same", async ({ page }) => {
  await page
    .getByTestId('pizza-category-blocks')
    .getByRole('button', { name: 'Deals', exact: true })
    .click();
  await dealTiles(page)
    .filter({ hasText: THREE.name as string })
    .click();
  const dialog = page.getByRole('dialog', { name: THREE.name as string });
  const panel = dialog.getByRole('tabpanel');
  await panel.getByRole('button', { name: 'Half & half' }).click();
  await bothHalvesFit(page, panel, panel);
  await shot(page, 'full-menu-deal-halves.png');
});

test('the Deals category shows all eight deals with what each contains', async ({ page }) => {
  await page
    .getByTestId('pizza-category-blocks')
    .getByRole('button', { name: 'Deals', exact: true })
    .click();
  const tiles = dealTiles(page);
  await expect(tiles).toHaveCount(deals.length);
  expect(await whollyVisible(tiles)).toBe(deals.length);
  for (const deal of deals) {
    const tile = tiles.filter({ hasText: deal.name as string });
    await expect(tile).toContainText(deal.price!.toFixed(2));
    const description = tile.getByTestId('pizza-deal-description');
    await expect(description).toHaveText(deal.description as string);
    const lines = await description.evaluate((element) =>
      Math.round(
        element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
      ),
    );
    expect(lines, `${deal.name}: two lines at most`).toBeLessThanOrEqual(2);
  }
  expect(await tooSmall(page.getByTestId('pos-catalog-scroll'))).toEqual([]);
  await shot(page, 'full-menu-deals.png');

  // The full text of a description cut to two lines is in the configurator's header.
  const last = deals[deals.length - 1];
  await tiles.filter({ hasText: last.name as string }).click();
  await expect(page.getByRole('dialog', { name: last.name as string })).toContainText(
    last.description as string,
  );
});

test('the kitchen is told what comes with a deal that has no pizzas', async ({ request }) => {
  const placed = await request.post(`${BASE}/api/orders`, {
    headers: headers(),
    data: {
      type: 'takeaway',
      items: [
        {
          product_id: 'dl-pasta-night',
          quantity: 1,
          modifier_selection: {
            kind: 'deal',
            v: 1,
            dealId: 'pasta-night',
            pizzas: [],
            pops: { cola: 3 },
          },
        },
      ],
    },
  });
  expect(placed.ok(), `the order is accepted (got ${placed.status()})`).toBeTruthy();
  const { order } = await placed.json();
  try {
    const kitchen = await request.get(`${BASE}/api/kitchen/orders`, { headers: headers() });
    expect(kitchen.ok()).toBeTruthy();
    const body = await kitchen.json();
    const ours = (body.orders ?? body).find((entry: { id: number }) => entry.id === order.id);
    expect(ours.items[0].recipe_lines).toEqual([
      'POP: 3 COLA',
      'INCLUDES: 3 PASTA, 3 GARLIC TOASTS & 3 POPS',
    ]);
  } finally {
    await request.patch(`${BASE}/api/orders/${order.id}/status`, {
      headers: headers(),
      data: { status: 'cancelled', reason: 'E2E cleanup' },
    });
  }
});
