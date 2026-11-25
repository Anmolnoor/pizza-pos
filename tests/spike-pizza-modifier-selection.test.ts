/**
 * SPIKE (throwaway): order_items.modifier_selection round-trips a structured pizza recipe
 * through create, add-items, quantity edit and read, and the client cannot set unit_price.
 *
 * Usage: HOME=$(mktemp -d) node tests/run-electron-node-test.cjs tests/spike-pizza-modifier-selection.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-pizza-modifier-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.JWT_SECRET = 'test-secret-spike-pizza';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  api,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');

const RECIPE = {
  kind: 'pizza',
  size: 'large',
  crust: 'thin',
  halves: { left: ['pepperoni', 'olive'], right: ['mushroom'] },
  extras: [{ id: 'x-cheese', qty: 2 }],
  note: 'well done 🍕',
};

async function main() {
  const db = initTestDb();
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-pz', 'Pizza', 1)`).run();
  db.prepare(
    `INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at)
     VALUES ('prod-pz', 'cat-pz', 'Build Your Own', 12.5, 'none', 1, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('owner-pz', 'owner', 'owner-pz@test.local', ?, 'owner', 1, ?, ?)`,
  ).run(bcrypt.hashSync('testpass123', 10), now(), now());
  const auth = {
    Authorization: `Bearer ${jwt.sign({ userId: 'owner-pz', email: 'owner-pz@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
  const app = createApp({ '/api/orders': orderRoutes });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  const key = () => ({ ...auth, 'Idempotency-Key': `pz-${Math.random()}` });
  const raw = (id: any) => db.prepare('SELECT * FROM order_items WHERE id = ?').get(id) as any;

  try {
    // Create: the client also lies about the price.
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-pz', quantity: 2, unit_price: 0.01, modifier_selection: RECIPE },
        ],
      },
      headers: key(),
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const orderId = created.data.order.id;
    const item = created.data.order.items[0];
    assert.deepEqual(item.modifier_selection, RECIPE);
    assert.equal(raw(item.id).modifier_selection, JSON.stringify(RECIPE));
    assert.equal(raw(item.id).unit_price, 12.5, 'client unit_price is ignored on create');
    assert.equal(raw(item.id).subtotal, 25);
    console.log(
      '  PASS create: recipe stored byte-identical, returned parsed; client unit_price 0.01 ignored (12.5 used)',
    );

    const read = await api(baseUrl, `/api/orders/${orderId}`, { headers: auth });
    assert.equal(read.status, 200);
    const readItems = (read.data.order ?? read.data).items;
    assert.deepEqual(readItems[0].modifier_selection, RECIPE);
    console.log('  PASS GET /api/orders/:id returns the recipe unchanged');

    const added = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: {
        items: [
          {
            product_id: 'prod-pz',
            quantity: 1,
            unit_price: 0.01,
            modifier_selection: { ...RECIPE, size: 'small' },
          },
        ],
      },
      headers: key(),
    });
    assert.ok(added.status === 200 || added.status === 201, JSON.stringify(added.data));
    const addedRow = db
      .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id DESC LIMIT 1')
      .get(orderId) as any;
    assert.equal(addedRow.modifier_selection, JSON.stringify({ ...RECIPE, size: 'small' }));
    assert.equal(addedRow.unit_price, 12.5, 'client unit_price is ignored on add-items');
    console.log(
      '  PASS POST /:id/items (insertOrderItems): recipe stored, client unit_price ignored',
    );

    const edited = await api(baseUrl, `/api/orders/${orderId}/items/${item.id}/edit`, {
      method: 'PATCH',
      body: { quantity: 3, reason: 'spike', expected_edit_version: 0 },
      headers: key(),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    const lines = db
      .prepare(
        "SELECT * FROM order_items WHERE order_id = ? AND quantity = 3 AND status = 'pending'",
      )
      .all(orderId) as any[];
    assert.equal(lines.length, 1);
    assert.equal(lines[0].modifier_selection, JSON.stringify(RECIPE));
    assert.equal(lines[0].unit_price, 12.5);
    console.log(
      '  PASS quantity edit: replacement line carries the recipe and the stored unit price',
    );
    console.log('ALL SPIKE CHECKS PASSED');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
