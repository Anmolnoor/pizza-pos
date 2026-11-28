import {
  test,
  expect,
  request as playwrightRequest,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import path from 'node:path';
import { clearPizzaMenu, loadSampleMenu } from './helpers/pizza-menu';
import { E2E_PASSWORD, getE2eToken, loginWithPassword, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * Pay at pickup / Pay on delivery on the pizza POS: the order goes to the kitchen unpaid, with the
 * marker at the front of its note, and is paid later from Orders -> Unpaid. Every spec shares one
 * database, so this one writes the pizza counter settings and the sample menu itself, puts both
 * back when it ends, and completes the orders it places. The made-up customers stay, as the API has
 * no route that removes one.
 */

const ownerHeaders = () => ({ Authorization: `Bearer ${getE2eToken()}` });
/** Screenshots are saved only when a folder outside the checkout is named. */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;
const shot = async (page: Page, name: string) => {
  if (EVIDENCE_DIR)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, name), animations: 'disabled' });
};
const SETTINGS = `${BASE}/api/settings`;
const COUNTER: Record<string, string> = {
  tables_required: 'false',
  billing_type: 'prepaid',
  kds_enabled: 'false',
  pos_order_types: 'takeaway,delivery',
  scheduled_orders_enabled: 'true',
  multi_counter_enabled: 'false',
};
const prior: Record<string, string> = {};
const placedOrderIds = new Set<number>();
let cashier: { id: string; email: string } | null = null;
let timezone = 'UTC';

const RUN = String(Date.now()).slice(-4);
const phone = (offset: number) => {
  const exchange = String((Number(RUN) + offset) % 10000).padStart(4, '0');
  return { local: `082 555 ${exchange}`, e164: `+6682555${exchange}` };
};
const NEW_DELIVERY = phone(11);
const KNOWN = { name: 'Pat Example', ...phone(12) };
const CHANGED = phone(13);

async function writeSettings(values: Record<string, string>): Promise<string[]> {
  const api = await playwrightRequest.newContext();
  const failures: string[] = [];
  try {
    for (const [key, value] of Object.entries(values)) {
      const saved = await api.put(`${SETTINGS}/${key}`, {
        headers: ownerHeaders(),
        data: { value },
      });
      if (!saved.ok()) failures.push(`${key}: status ${saved.status()}`);
    }
  } finally {
    await api.dispose();
  }
  return failures;
}

test.beforeAll(async () => {
  const api = await playwrightRequest.newContext();
  try {
    for (const key of Object.keys(COUNTER)) {
      const read = await api.get(`${SETTINGS}/${key}`, { headers: ownerHeaders() });
      const value = read.ok() ? (await read.json()).setting?.value : undefined;
      if (typeof value === 'string') prior[key] = value;
    }
    const business = await (
      await api.get(`${SETTINGS}/business`, { headers: ownerHeaders() })
    ).json();
    timezone = business.timezone || 'UTC';
    // The order types have no default, so a store that never set them reads back as no key.
    prior.pos_order_types = ((business.pos_order_types as string[] | undefined) ?? []).join(',');
    const made = await api.post(`${BASE}/api/customers`, {
      headers: ownerHeaders(),
      data: { name: KNOWN.name, phone: KNOWN.e164, address: '4 Sample Road' },
    });
    expect(made.status(), await made.text()).toBe(201);
    const email = `pay-later-cashier-${Date.now()}@flo.local`;
    const account = await api.post(`${BASE}/api/staff`, {
      headers: ownerHeaders(),
      data: { name: 'Pay Later Cashier', email, password: E2E_PASSWORD, role: 'cashier' },
    });
    expect(account.status(), await account.text()).toBe(201);
    cashier = { id: (await account.json()).staff.id, email };
    await loadSampleMenu(api);
  } finally {
    await api.dispose();
  }
  expect(await writeSettings(COUNTER), 'write the counter settings').toEqual([]);
});

test.afterAll(async () => {
  const api = await playwrightRequest.newContext();
  const failures: string[] = [];
  try {
    for (const id of placedOrderIds) {
      const read = await api.get(`${BASE}/api/orders/${id}`, { headers: ownerHeaders() });
      if (read.ok() && (await read.json()).order?.status === 'completed') continue;
      const done = await api.patch(`${BASE}/api/orders/${id}/status`, {
        headers: ownerHeaders(),
        data: { status: 'cancelled', reason: 'e2e cleanup' },
      });
      if (!done.ok()) failures.push(`cancel order ${id}: status ${done.status()}`);
    }
    if (cashier)
      await api.post(`${BASE}/api/staff/${cashier.id}/deactivate`, { headers: ownerHeaders() });
    await clearPizzaMenu(api);
  } finally {
    await api.dispose();
  }
  failures.push(...(await writeSettings(prior)));
  expect(failures, 'put the store back as it was').toEqual([]);
});

/** Every page the browser printer opens, kept so a test can read what was printed. */
async function capturePrints(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const appWindow = window as Window & { __printed?: string[] };
    appWindow.__printed = [];
    window.open = (() => {
      const printDocument = document.implementation.createHTMLDocument('Print');
      return {
        document: printDocument,
        print: () =>
          appWindow.__printed!.push(
            printDocument.body.innerText || printDocument.body.textContent || '',
          ),
        close: () => {},
        focus: () => {},
      } as unknown as Window;
    }) as typeof window.open;
  });
  // Kitchen tickets print automatically here; device settings the API may not write.
  for (const key of ['kot_printing_enabled', 'auto_print_kot'])
    await page.route(`**/api/settings/${key}`, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: { setting: { key, value: 'true', updated_at: '2026-11-27T12:00:00Z' } },
          })
        : route.continue(),
    );
  // A saved printer sends tickets to the server; this page is told there are none.
  await page.route('**/api/printers', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { printers: [] } })
      : route.continue(),
  );
}

const printed = (page: Page) =>
  page.evaluate(() => (window as Window & { __printed?: string[] }).__printed ?? []);

async function openPos(page: Page, email = 'owner@flo.local'): Promise<void> {
  await page.setViewportSize({ width: 1180, height: 820 });
  await setLanguage(page, 'en');
  await loginWithPassword(page, email);
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pizza-tile').first()).toBeVisible();
}

const cart = (page: Page) => page.getByTestId('cart-shell');
const orderType = (page: Page, name: string) =>
  page.getByTestId('pos-order-type-tabs').getByRole('button', { name });
const placeOrder = (page: Page) => cart(page).getByRole('button', { name: 'Place Order' });
const payLater = (page: Page, name = 'Pay at pickup') =>
  cart(page).getByRole('button', { name, exact: true });
const prepaidModal = (page: Page) => page.getByTestId('prepaid-checkout-modal');
const phoneBox = (page: Page) => cart(page).getByLabel('Phone number');

async function addGarden(page: Page): Promise<void> {
  await page
    .getByTestId('pizza-tile')
    .filter({ has: page.getByRole('heading', { name: 'Garden', exact: true }) })
    .getByRole('button', { name: /Large/ })
    .click();
  await expect(page.getByTestId('cart-item')).toHaveCount(1);
}

interface Sent {
  key: string | null;
  orderId: number | null;
  status: number;
}

/**
 * Watches every `POST /api/orders` this page sends. Each reaches the server; `drop` throws its
 * response away after the server has answered, and `hold` keeps it back until released.
 */
function watchOrders(page: Page) {
  const sent: Sent[] = [];
  let drop = false;
  let hold: Promise<void> | null = null;
  page.route('**/api/orders', async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/orders')
      return route.continue();
    if (hold) await hold;
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    const orderId = body?.order?.id == null ? null : Number(body.order.id);
    if (orderId != null) placedOrderIds.add(orderId);
    sent.push({
      key: request.headers()['idempotency-key'] ?? null,
      orderId,
      status: response.status(),
    });
    if (drop) {
      drop = false;
      return route.abort('failed');
    }
    return route.fulfill({ response });
  });
  return {
    sent,
    dropNext: () => {
      drop = true;
    },
    holdNext: () => {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null;
          resolve();
        };
      });
      return () => release();
    },
    /** The distinct orders the server made for this page. */
    orders: () => new Set(sent.map((entry) => entry.orderId).filter((id) => id != null)),
  };
}

async function readOrder(page: Page, id: number) {
  const read = await page.request.get(`${BASE}/api/orders/${id}`, { headers: ownerHeaders() });
  expect(read.ok()).toBeTruthy();
  return (await read.json()).order;
}

function storeWallClock(minutesAhead: number, from = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(from + minutesAhead * 60_000));
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

async function scheduleFor(page: Page, at: string): Promise<void> {
  await cart(page).getByTestId('pos-order-details-summary').click();
  const details = page.getByTestId('pos-order-details-drawer');
  await details.getByTestId('pos-send-to-kitchen-input').fill(at);
  await expect(details.getByTestId('pos-schedule-error')).toHaveCount(0);
  await details.getByTestId('pos-order-details-done-btn').click();
  await expect(details).toHaveCount(0);
}

async function payInCash(scope: Locator): Promise<void> {
  await scope.getByRole('button', { name: 'Cash', exact: true }).click();
  await scope.getByRole('button', { name: 'Exact due' }).first().click();
  await scope.getByRole('button', { name: /Confirm Payment/ }).click();
}

test.describe.configure({ mode: 'serial' });

test('the button shows beside Place Order for pickup and delivery, 48 px tall', async ({
  page,
}) => {
  await openPos(page);
  await addGarden(page);
  await expect(payLater(page)).toBeVisible();
  for (const button of [payLater(page), placeOrder(page)])
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await shot(page, 'pay-later-takeaway.png');
  await orderType(page, 'Delivery').click();
  await expect(payLater(page, 'Pay on delivery')).toBeVisible();
  await shot(page, 'pay-later-delivery.png');
  await expect(payLater(page)).toHaveCount(0);
});

test('a cashier sends a pickup to the kitchen unpaid, then takes the payment from Orders', async ({
  page,
}) => {
  await capturePrints(page);
  const watch = watchOrders(page);
  await openPos(page, cashier!.email);
  await addGarden(page);
  await payLater(page).click();

  await expect.poll(() => watch.orders().size).toBe(1);
  const [id] = [...watch.orders()];
  const order = await readOrder(page, id!);
  await expect(page.getByText(`Order #${order.order_number} placed, unpaid`)).toBeVisible();
  await expect(prepaidModal(page)).toHaveCount(0);
  await expect(page.getByTestId('cart-item')).toHaveCount(0);
  expect(order.status).toBe('pending');
  expect(order.bills ?? []).toHaveLength(0);
  expect(order.special_instructions).toBe('Pay at pickup');
  await expect.poll(async () => (await printed(page)).join('\n')).toContain('Pay at pickup');

  await page.goto(`${BASE}/orders`);
  await page
    .getByRole('main')
    .getByRole('button', { name: /Unpaid/ })
    .first()
    .click();
  await page.getByText(`#${order.order_number}`).first().click();
  await page
    .getByRole('button', { name: /Checkout|Take Payment/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Payment', exact: true })).toBeVisible();
  await page.getByTitle('Cash', { exact: true }).click();
  await page.getByRole('button', { name: /^Pay [^A-Za-z]/ }).click();
  const confirm = page
    .getByRole('dialog', { name: 'Confirm' })
    .getByRole('button', { name: 'Pay', exact: true });
  if (await confirm.count()) await confirm.click();
  await expect.poll(async () => (await readOrder(page, id!)).status).toBe('completed');
  expect(watch.orders().size).toBe(1);
});

test('Pay on delivery with a new number creates the customer and places one unpaid order', async ({
  page,
}) => {
  await capturePrints(page);
  const watch = watchOrders(page);
  await openPos(page);
  await orderType(page, 'Delivery').click();
  await addGarden(page);
  await phoneBox(page).fill(NEW_DELIVERY.local);
  await cart(page).getByLabel('Name', { exact: true }).fill('Dee Delivery');
  await cart(page).getByTestId('pos-order-details-summary').click();
  const details = page.getByTestId('pos-order-details-drawer');
  await details.getByRole('button', { name: 'Cash', exact: true }).click();
  await details.getByTestId('pos-order-details-done-btn').click();
  await payLater(page, 'Pay on delivery').click();

  await expect.poll(() => watch.orders().size).toBe(1);
  await expect(prepaidModal(page)).toHaveCount(0);
  const [id] = [...watch.orders()];
  const order = await readOrder(page, id!);
  expect(order.type).toBe('delivery');
  expect(order.expected_payment_method).toBe('cash');
  expect(order.special_instructions).toBe('Pay on delivery');
  expect(order.bills ?? []).toHaveLength(0);

  await page.goto(`${BASE}/orders`);
  await page
    .getByRole('main')
    .getByRole('button', { name: /Unpaid/ })
    .first()
    .click();
  await page.getByText(`#${order.order_number}`).first().click();
  await page.getByRole('button', { name: 'Delivery Slip' }).first().click();
  await expect
    .poll(async () => (await printed(page)).find((text) => text.includes('Dee Delivery')) ?? '')
    .toMatch(/TO COLLECT[\s\S]*Pay on delivery|Pay on delivery[\s\S]*TO COLLECT/);
});

/**
 * Holds the first customer lookup sent after `arm()`. The page clock is paused around typing, so
 * the box's own lookup (a 250 ms debounce) cannot run before the press it races.
 */
async function holdCustomerLookup(page: Page) {
  let armed = false;
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/crm/lookup**', async (route) => {
    if (armed) {
      armed = false;
      await released;
    }
    return route.continue();
  });
  return {
    arm: () => {
      armed = true;
    },
    release: () => release(),
  };
}

const pauseClock = async (page: Page) =>
  page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);

test('while a known number is looked up, a press on the other button does not change the way', async ({
  page,
}) => {
  const watch = watchOrders(page);
  const lookup = await holdCustomerLookup(page);
  await page.clock.install();
  await openPos(page);
  await orderType(page, 'Delivery').click();
  await addGarden(page);
  await pauseClock(page);
  await phoneBox(page).fill(KNOWN.local);
  lookup.arm();
  await payLater(page, 'Pay on delivery').click();
  await page.clock.runFor(400);
  await expect(cart(page).getByTestId('pizza-delivery-customer')).toHaveText(KNOWN.name);
  await placeOrder(page).click();
  lookup.release();
  await page.clock.resume();

  await expect.poll(() => watch.orders().size).toBe(1);
  await expect(prepaidModal(page)).toHaveCount(0);
  const [id] = [...watch.orders()];
  expect((await readOrder(page, id!)).special_instructions).toBe('Pay on delivery');
});

test('a number changed during the lookup leaves the buttons working for the new number', async ({
  page,
}) => {
  const watch = watchOrders(page);
  const lookup = await holdCustomerLookup(page);
  await page.clock.install();
  await openPos(page);
  await orderType(page, 'Delivery').click();
  await addGarden(page);
  await pauseClock(page);
  await phoneBox(page).fill(NEW_DELIVERY.local);
  lookup.arm();
  await payLater(page, 'Pay on delivery').click();
  await phoneBox(page).fill(CHANGED.local);
  lookup.release();
  await page.clock.resume();
  await page.waitForTimeout(1000);
  await payLater(page, 'Pay on delivery').click();

  await expect.poll(() => watch.orders().size).toBe(1);
  const [id] = [...watch.orders()];
  const order = await readOrder(page, id!);
  const customer = await (
    await page.request.get(`${BASE}/api/customers/${order.customer_id}`, {
      headers: ownerHeaders(),
    })
  ).json();
  expect(customer.customer.phone).toBe(CHANGED.e164);
});

test('a scheduled pickup paid later waits for its time with no kitchen ticket', async ({
  page,
}) => {
  await capturePrints(page);
  const watch = watchOrders(page);
  await openPos(page);
  await addGarden(page);
  await scheduleFor(page, storeWallClock(95));
  await payLater(page).click();

  await expect.poll(() => watch.orders().size).toBe(1);
  const [id] = [...watch.orders()];
  expect((await readOrder(page, id!)).release_status).toBe('scheduled');
  await page.waitForTimeout(1000);
  expect((await printed(page)).join('\n')).not.toContain('Pay at pickup');
});

test('a lost reply, a reload and Place Order send the same order again, not a second one', async ({
  page,
}) => {
  const watch = watchOrders(page);
  await openPos(page);
  await addGarden(page);
  watch.dropNext();
  await payLater(page).click();
  await expect.poll(() => watch.sent.length).toBe(1);

  await page.reload();
  await expect(page.getByTestId('pizza-tile').first()).toBeVisible();
  await addGarden(page);
  await placeOrder(page).click();

  await expect.poll(() => watch.sent.length).toBe(2);
  await expect(prepaidModal(page)).toHaveCount(0);
  expect(watch.sent[1].key).toBe(watch.sent[0].key);
  expect(watch.orders().size).toBe(1);
});

test('before the pizza menu loads after a reload, Place Order still replays the lost order', async ({
  page,
}) => {
  const watch = watchOrders(page);
  await openPos(page);
  await addGarden(page);
  watch.dropNext();
  await payLater(page).click();
  await expect.poll(() => watch.sent.length).toBe(1);

  let releaseCatalog = () => {};
  const catalogHeld = new Promise<void>((resolve) => (releaseCatalog = resolve));
  await page.route('**/api/pizza/catalog**', async (route) => {
    await catalogHeld;
    await route.continue();
  });
  try {
    await page.reload();
    await page.getByTestId('pos-product-card').filter({ hasText: 'Garden' }).first().click();
    await page.getByText('Large', { exact: true }).click();
    await page.getByRole('button', { name: /Add to Cart/ }).click();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);
    await expect(page.getByTestId('pizza-tile')).toHaveCount(0);
    await placeOrder(page).click();
    await expect.poll(() => watch.sent.length).toBe(2);
    await expect(prepaidModal(page)).toHaveCount(0);
    expect(watch.sent[1].key).toBe(watch.sent[0].key);
    expect(watch.orders().size).toBe(1);
  } finally {
    releaseCatalog();
  }
});

test('Pay at pickup on a cart whose prepaid checkout was cut short resumes that checkout, not a second order', async ({
  page,
}) => {
  const watch = watchOrders(page);
  await page.route('**/api/bills/generate', (route) => route.abort('failed'));
  await openPos(page);
  await addGarden(page);
  await placeOrder(page).click();
  await payInCash(prepaidModal(page));
  await expect.poll(() => watch.orders().size).toBe(1);
  const [id] = [...watch.orders()];
  const order = await readOrder(page, id!);
  // The checkout stays locked on its recovery screen; a reload is how the cart comes back.
  await page.unroute('**/api/bills/generate');
  await page.reload();
  await expect(page.getByTestId('pizza-tile').first()).toBeVisible();
  await addGarden(page);

  await payLater(page).click();
  await expect(prepaidModal(page)).toBeVisible();
  await expect(
    page.getByText(`Finish the payment for order #${order.order_number} first.`),
  ).toBeVisible();
  expect(watch.orders().size).toBe(1);
});

test('after a lost reply and a switch to postpaid billing, Place Order replays the same order', async ({
  page,
}) => {
  const watch = watchOrders(page);
  await openPos(page);
  await addGarden(page);
  watch.dropNext();
  await payLater(page).click();
  await expect.poll(() => watch.sent.length).toBe(1);

  try {
    expect(await writeSettings({ billing_type: 'postpaid' })).toEqual([]);
    await page.reload();
    await expect(page.getByTestId('pizza-tile').first()).toBeVisible();
    await addGarden(page);
    await expect(payLater(page)).toHaveCount(0);
    await placeOrder(page).click();
    await expect.poll(() => watch.sent.length).toBe(2);
    expect(watch.sent[1].key).toBe(watch.sent[0].key);
    expect(watch.orders().size).toBe(1);
  } finally {
    expect(await writeSettings({ billing_type: 'prepaid' })).toEqual([]);
  }
});

test('a note too long for the marker is refused before anything is sent', async ({ page }) => {
  const watch = watchOrders(page);
  await openPos(page);
  await addGarden(page);
  await cart(page)
    .getByRole('button', { name: /Order notes/ })
    .click();
  const note = 'n'.repeat(190);
  await cart(page).getByTestId('pos-order-notes-input').fill(note);
  await payLater(page).click();
  await expect(page.getByText(/Shorten the order note by 6 characters/)).toBeVisible();
  await expect(cart(page).getByTestId('pos-order-notes-input')).toHaveValue(note);
  await page.waitForTimeout(500);
  expect(watch.sent).toHaveLength(0);
});

test('F4 while a Pay at pickup request is on its way sends nothing more', async ({ page }) => {
  const watch = watchOrders(page);
  await openPos(page);
  await addGarden(page);
  const release = watch.holdNext();
  await payLater(page).click();
  await page.keyboard.press('F4');
  await page.keyboard.press('F4');
  release();
  await expect.poll(() => watch.sent.length).toBe(1);
  await page.waitForTimeout(500);
  expect(watch.sent).toHaveLength(1);
  await expect(prepaidModal(page)).toHaveCount(0);
});

test('a scheduled pickup whose reply was lost is sent again with F4 after its time', async ({
  page,
}) => {
  await page.clock.install();
  const watch = watchOrders(page);
  await openPos(page);
  await addGarden(page);
  await scheduleFor(page, storeWallClock(20));
  watch.dropNext();
  await payLater(page).click();
  await expect.poll(() => watch.sent.length).toBe(1);

  await page.clock.fastForward('00:30:00');
  await page.keyboard.press('F4');
  await expect.poll(() => watch.sent.length).toBe(2);
  expect(watch.sent[1].key).toBe(watch.sent[0].key);
  expect(watch.orders().size).toBe(1);
});
