import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, loginWithPassword, setLanguage } from './helpers/test-auth';

type MenuItem = {
  id: string;
  price?: number;
  picks?: Array<{ size?: string }>;
  [field: string]: unknown;
};
type Menu = { categories: Array<{ id: string; name: string; items: MenuItem[] }> };

const SAMPLE: Menu = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/pizza-sample-menu.json'), 'utf8'),
);
const IMPORT_URL = `${BASE}/api/pizza/menu/import`;
// Catalogue rows the sample maps to, the stored menu record included.
const SAMPLE_ROWS = 73;
const SAMPLE_COUNTS = ['5 pizzas', '3 sizes', '2 dips', '5 sides', '3 drinks', '4 deals'];
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

const ownerHeaders = () => ({ Authorization: `Bearer ${getE2eToken()}` });

function copyOf(edit: (menu: Menu) => void): Menu {
  const menu = structuredClone(SAMPLE);
  edit(menu);
  return menu;
}

const itemsOf = (menu: Menu, id: string) =>
  menu.categories.find((category) => category.id === id)!.items;

async function importByApi(request: APIRequestContext, menu: Menu): Promise<void> {
  const res = await request.post(IMPORT_URL, { headers: ownerHeaders(), data: menu });
  expect(res.ok(), `loading a menu by API must succeed (got ${res.status()})`).toBeTruthy();
}

async function openScreen(page: Page): Promise<void> {
  await loginWithPassword(page, 'owner@flo.local');
  await page.getByRole('link', { name: 'Pizza menu' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pizza menu' })).toBeVisible();
}

const fileInput = (page: Page) => page.getByLabel('Menu file (.json)');

async function chooseFile(page: Page, name: string, content: Menu | string): Promise<void> {
  await fileInput(page).setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
  });
}

async function loadThroughScreen(page: Page, name: string, menu: Menu): Promise<void> {
  await chooseFile(page, name, menu);
  await page.getByRole('button', { name: 'Load this menu' }).click();
}

async function expectLoaded(page: Page, counts: string[]): Promise<void> {
  for (const count of counts) {
    await expect(page.getByTestId('pizza-menu-loaded')).toContainText(count);
  }
}

async function evidence(page: Page, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name) });
}

test.describe('Pizza menu screen', () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  let cashier: { id: string; email: string };

  test.beforeAll(async ({ request }) => {
    const email = `pizza-menu-cashier-${Date.now().toString(36)}@flo.local`;
    const res = await request.post(`${BASE}/api/staff`, {
      headers: ownerHeaders(),
      data: { name: 'Pizza Menu Cashier', email, password: E2E_PASSWORD, role: 'cashier' },
    });
    expect(res.status(), `creating the cashier must succeed (${await res.text()})`).toBe(201);
    cashier = (await res.json()).staff;
  });

  test.beforeEach(async ({ page }) => {
    await setLanguage(page, 'en');
  });

  // The whole suite shares one server: take the menu's products and categories back out of the
  // catalogue, so the specs that run after this one find the POS as it was.
  test.afterAll(async ({ request }) => {
    await importByApi(
      request,
      copyOf((menu) => {
        menu.categories = [{ id: 'pizzas', name: 'Our Pizzas', items: [] }];
      }),
    );
    for (const id of ['cat-pizzas', 'cat-sides', 'cat-drinks', 'cat-deals']) {
      const res = await request.delete(`${BASE}/api/categories/${id}?action=delete_all`, {
        headers: ownerHeaders(),
      });
      expect([200, 404], `removing ${id} must succeed or find it gone`).toContain(res.status());
    }
    await request.post(`${BASE}/api/staff/${cashier.id}/deactivate`, { headers: ownerHeaders() });
  });

  test('says so when no menu is loaded', async ({ page }) => {
    const stored = await page.request.get(`${BASE}/api/pizza/catalog`, { headers: ownerHeaders() });
    // A menu cannot be unloaded, so when an earlier spec loaded one the server's "none" is replayed.
    if (stored.status() !== 404) {
      await page.route('**/api/pizza/catalog', (route) =>
        route.fulfill({ status: 404, json: { error: 'No menu has been loaded' } }),
      );
    }

    await openScreen(page);

    await expect(page.getByTestId('pizza-menu-loaded')).toContainText('No pizza menu is loaded');
  });

  test('loads the sample after a confirm step and shows what is loaded', async ({ page }) => {
    await openScreen(page);
    await chooseFile(page, 'sample-menu.json', SAMPLE);

    const confirm = page.getByTestId('pizza-menu-confirm');
    await expect(confirm).toContainText('sample-menu.json');
    for (const line of [
      'The file is the master copy',
      'Names, prices and which items are on sale follow the file',
      'switched off, not deleted',
      'in the product screen are overwritten',
    ]) {
      await expect(confirm).toContainText(line);
    }
    const confirmButton = confirm.getByRole('button', { name: 'Load this menu' });
    for (const control of [
      fileInput(page),
      confirmButton,
      confirm.getByRole('button', { name: 'Cancel' }),
    ]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    }
    await evidence(page, 'confirm-step.png');

    // The confirm button is the next stop after the file control, and Enter presses it.
    const answered = page.waitForResponse((res) => res.url() === IMPORT_URL);
    await fileInput(page).focus();
    await page.keyboard.press('Tab');
    await expect(confirmButton).toBeFocused();
    await page.keyboard.press('Enter');
    const summary = await (await answered).json();

    expect(summary.created + summary.updated + summary.unchanged).toBe(SAMPLE_ROWS);
    await expect(page.getByTestId('pizza-menu-result')).toContainText(
      `${summary.created} added, ${summary.updated} changed, ${summary.unchanged} unchanged, ${summary.deactivated} switched off`,
    );
    // The fixture store's tax pack has no "food" or "soda" category.
    expect(summary.untaxed).toBe(true);
    await expect(page.getByTestId('pizza-menu-untaxed')).toContainText('"food" and "soda"');
    await expect(confirm).toBeHidden();
    await expectLoaded(page, SAMPLE_COUNTS);
    await evidence(page, 'menu-loaded.png');
  });

  test('loading the same file again changes nothing', async ({ page }) => {
    await importByApi(page.request, SAMPLE);
    await openScreen(page);

    await loadThroughScreen(page, 'sample-menu.json', SAMPLE);

    await expect(page.getByTestId('pizza-menu-result')).toContainText(
      `0 added, 0 changed, ${SAMPLE_ROWS} unchanged, 0 switched off`,
    );
  });

  test('a removed pizza is switched off and a changed price is counted', async ({ page }) => {
    await importByApi(page.request, SAMPLE);
    await openScreen(page);

    await loadThroughScreen(
      page,
      'smaller-menu.json',
      copyOf((menu) => {
        itemsOf(menu, 'pizzas').pop();
        itemsOf(menu, 'sides').find((side) => side.id === 'garlic-toast')!.price = 2.75;
      }),
    );

    // Switched off: the pizza's product and its three sizes. Changed: the side's price, the
    // place of Half & Half after the pizzas, and the stored menu record.
    await expect(page.getByTestId('pizza-menu-result')).toContainText(
      '0 added, 3 changed, 65 unchanged, 4 switched off',
    );
    await expectLoaded(page, ['4 pizzas']);
  });

  test('a file the server refuses shows its message and the entry it names', async ({ page }) => {
    await importByApi(page.request, SAMPLE);
    await openScreen(page);

    await loadThroughScreen(
      page,
      'broken-menu.json',
      copyOf((menu) => {
        itemsOf(menu, 'deals')[0].picks![0].size = 'huge';
      }),
    );

    const error = page.getByTestId('pizza-menu-error');
    await expect(error).toContainText('"huge" is not a pizza size');
    await expect(error).toContainText('categories.deals.items[0].picks[0].size');
    await expect(page.getByTestId('pizza-menu-result')).toHaveCount(0);
    await expectLoaded(page, SAMPLE_COUNTS);
  });

  test('a file that is not JSON is refused in the browser and nothing is sent', async ({
    page,
  }) => {
    await openScreen(page);
    let sent = 0;
    page.on('request', (request) => {
      if (request.url() === IMPORT_URL) sent += 1;
    });

    await chooseFile(page, 'not-a-menu.json', '{ "sizes": ');

    await expect(page.getByTestId('pizza-menu-error')).toContainText(
      'not-a-menu.json is not valid JSON',
    );
    await expect(page.getByTestId('pizza-menu-confirm')).toHaveCount(0);
    expect(sent).toBe(0);
  });

  test('a cashier has no sidebar entry and is turned away from the address', async ({ page }) => {
    await loginWithPassword(page, cashier.email);
    await expect(page.getByRole('link', { name: 'POS', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pizza menu' })).toHaveCount(0);

    await page.goto(`${BASE}/pizza-menu`);

    await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === '/pos');
    await expect(page.getByRole('heading', { level: 1, name: 'Pizza menu' })).toHaveCount(0);
  });

  test('the POS shows a newly loaded pizza without signing out', async ({ page }) => {
    await importByApi(page.request, SAMPLE);
    await openScreen(page);

    await loadThroughScreen(
      page,
      'bigger-menu.json',
      copyOf((menu) => {
        itemsOf(menu, 'pizzas').push({
          id: 'orchard',
          name: 'Orchard Special',
          description: 'Apple, cheese & tomato sauce',
          sizes: 'pizza',
        });
      }),
    );
    await expectLoaded(page, ['6 pizzas']);
    await page.getByRole('link', { name: 'POS', exact: true }).click();

    await expect(page.getByText('Orchard Special').first()).toBeVisible();
  });
});
