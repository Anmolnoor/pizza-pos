/**
 * Pizza fork: the pizza tables come from their own migration list with their own counter,
 * and every upstream path that compares a file against the reference schema accepts them.
 *
 * The "existing install" is a database written by unmodified upstream code, extracted with
 * `git archive` and run in a child process.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/pizza-migrations.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const UPSTREAM_COMMIT = 'b5928ec';
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pizza-migrations-'));
let userData = root;
Module._load = function (request: string) {
  if (request === 'electron')
    return {
      app: { isPackaged: true, getPath: () => userData, getVersion: () => 'test' },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  return originalLoad.apply(this, arguments as any);
};

const {
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const {
  MIGRATIONS,
  clearRecoverySchemaReference,
  closeDatabase,
  createBackup,
  discoverDowngradeBackupsAsync,
  getCurrentSchemaVersion,
  getDatabase,
  getTables,
  initDatabase,
  isHealthyDatabaseFile,
  isSchemaVersionMismatchError,
  resetDatabaseForCurrencyChange,
  restoreBackup,
  restoreCompatibleBackupForDowngrade,
} = require('../main/db');

const CORE = MIGRATIONS[MIGRATIONS.length - 1].version;
const PIZZA = 1;
const PIZZA_TABLES = ['pizza_menu', 'pizza_products', 'pizza_quick_buttons'];
const STAMP = '2026-01-01 00:00:00';

function useDir(name: string): string {
  userData = path.join(root, name);
  fs.mkdirSync(userData, { recursive: true });
  return userData;
}
const hasTable = (db: any, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columnsOf = (db: any, table: string): string[] =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(
      (column: any) =>
        `${column.name} ${column.type}` +
        (column.notnull ? ' NOT NULL' : '') +
        (column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`) +
        (column.pk ? ' PRIMARY KEY' : ''),
    );
const pizzaVersion = (db: any): number =>
  hasTable(db, '_flo_meta')
    ? Number(
        db.prepare("SELECT value FROM _flo_meta WHERE key = 'pizza_schema_version'").get()?.value ??
          0,
      )
    : 0;
const schemaDump = (db: any): string =>
  JSON.stringify(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all());
const backupsIn = (dir: string): string[] =>
  fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).sort() : [];
const sha256 = (file: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rows = (db: any, table: string): unknown[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
// Loaded on each call: the module caches the reference schema, and a later case swaps builds.
const findingIds = (): string[] =>
  require('../main/services/schema-health')
    .runHealthCheck(getDatabase())
    .findings.map((finding: any) => finding.id);
/** What a newly installed build starts with: no schema cached from the build before it. */
function forgetCachedSchemas(): void {
  clearRecoverySchemaReference();
  delete require.cache[require.resolve('../main/services/schema-health')];
}
function sameOrThrow(actual: unknown, expected: unknown, message: string): void {
  assertEqualOrThrow(JSON.stringify(actual), JSON.stringify(expected), message);
}
function throwsOrThrow(run: () => unknown, message: string): void {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  assertOrThrow(threw, message);
}

function seedPizzaRows(db: any): void {
  db.prepare(
    `INSERT INTO pizza_products (product_id, menu_id, kind, ingredients, picks, created_at, updated_at)
     VALUES ('pz-garden', 'garden', 'pizza', '["Olives","Onions"]', NULL, ?, ?)`,
  ).run(STAMP, STAMP);
  db.prepare('INSERT INTO pizza_menu (id, catalog, imported_at) VALUES (1, ?, ?)').run(
    '{"sizes":[]}',
    STAMP,
  );
  db.prepare(
    `INSERT INTO pizza_quick_buttons (id, label, product_id, created_at, updated_at)
     VALUES ('qb-1', 'Large garden', 'pz-garden', ?, ?)`,
  ).run(STAMP, STAMP);
}
const pizzaRowCounts = (db: any): number[] =>
  PIZZA_TABLES.map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

function buildUpstreamFixture(): { db: string; backup: string } {
  const tree = path.join(root, 'upstream-tree');
  const out = path.join(root, 'upstream-out');
  fs.mkdirSync(tree);
  fs.mkdirSync(out);
  execSync(`git archive ${UPSTREAM_COMMIT} main shared | tar -x -C "${tree}"`, { cwd: repo });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(tree, 'node_modules'));
  if (fs.existsSync(path.join(tree, 'main/pizza')))
    throw new Error('the upstream tree must hold no pizza code');
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, 'tests/run-electron-node-test.cjs'),
      path.join(repo, 'tests/helpers/pizza-upstream-fixture.ts'),
    ],
    {
      env: { ...process.env, PIZZA_FIXTURE_OUT: out, PIZZA_FIXTURE_TREE: tree },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(`upstream fixture generation failed:\n${result.stdout}\n${result.stderr}`);
  return { db: path.join(out, 'flo.db'), backup: path.join(out, 'upstream-backup.db') };
}

const failedCases: string[] = [];
async function testCase(name: string, run: () => unknown) {
  console.log(`\n--- ${name} ---`);
  try {
    await run();
  } catch (error: any) {
    failedCases.push(name);
    console.error(`  case failed: ${error?.message ?? error}`);
  }
}

async function main() {
  console.log(`Pizza fork: pizza migration list (upstream v${CORE}, pizza v${PIZZA})`);
  console.log('='.repeat(60));
  resetCounters();

  const upstream = buildUpstreamFixture();
  const upstreamTables: string[] = [];
  await testCase(`0. The fixture is a database written by upstream ${UPSTREAM_COMMIT}`, () => {
    const raw = new Database(upstream.db, { readonly: true });
    try {
      assertEqualOrThrow(raw.pragma('user_version', { simple: true }), CORE, 'upstream version');
      assertEqualOrThrow(hasTable(raw, '_flo_meta'), false, 'it has no _flo_meta table');
      upstreamTables.push(...getTables(raw));
      sameOrThrow(
        upstreamTables.filter((table) => table.startsWith('pizza_')),
        [],
        'it has no pizza table',
      );
    } finally {
      raw.close();
    }
  });

  const dirA = useDir('a-new');
  let forkBackup = '';
  await testCase('1. A new database gets the three pizza tables and its own counter', () => {
    initDatabase();
    const db = getDatabase();
    assertEqualOrThrow(getCurrentSchemaVersion(), CORE, 'user_version is the upstream version');
    sameOrThrow(
      columnsOf(db, 'pizza_products'),
      [
        'product_id TEXT PRIMARY KEY',
        'menu_id TEXT NOT NULL',
        'kind TEXT NOT NULL',
        'ingredients TEXT',
        'picks TEXT',
        'created_at TEXT NOT NULL',
        'updated_at TEXT NOT NULL',
      ],
      'pizza_products has the contract columns',
    );
    sameOrThrow(
      columnsOf(db, 'pizza_menu'),
      ['id INTEGER PRIMARY KEY', 'catalog TEXT NOT NULL', 'imported_at TEXT NOT NULL'],
      'pizza_menu has the contract columns',
    );
    sameOrThrow(
      columnsOf(db, 'pizza_quick_buttons'),
      [
        'id TEXT PRIMARY KEY',
        'label TEXT NOT NULL',
        'color TEXT',
        'customer_id TEXT',
        'product_id TEXT NOT NULL',
        'variant_id TEXT',
        'recipe TEXT',
        'addons TEXT',
        'note TEXT',
        'sort_order INTEGER NOT NULL DEFAULT 0',
        'created_at TEXT NOT NULL',
        'updated_at TEXT NOT NULL',
      ],
      'pizza_quick_buttons has the contract columns',
    );
    sameOrThrow(
      getTables(db)
        .filter((table: string) => !upstreamTables.includes(table))
        .sort(),
      PIZZA_TABLES,
      'the pizza list adds the three pizza tables and nothing else',
    );
    assertEqualOrThrow(pizzaVersion(db), PIZZA, '_flo_meta.pizza_schema_version is recorded');
    seedPizzaRows(db);
    throwsOrThrow(
      () =>
        db
          .prepare(
            `INSERT INTO pizza_products (product_id, menu_id, kind, created_at, updated_at)
             VALUES ('pz-x', 'x', 'calzone', ?, ?)`,
          )
          .run(STAMP, STAMP),
      'pizza_products refuses an unknown kind',
    );
    throwsOrThrow(
      () =>
        db
          .prepare('INSERT INTO pizza_menu (id, catalog, imported_at) VALUES (2, ?, ?)')
          .run('{}', STAMP),
      'pizza_menu holds one row only',
    );
    sameOrThrow(
      backupsIn(dirA).map((name) => name.replace(/^flo-backup-.*(-pre-v)/, '$1')),
      [`-pre-v0-to-v${CORE}.db`],
      'a new install takes one pre-migration backup',
    );
  });

  await testCase('2. Opening the database again changes nothing', () => {
    const before = schemaDump(getDatabase());
    closeDatabase();
    initDatabase();
    const db = getDatabase();
    assertEqualOrThrow(schemaDump(db), before, 'sqlite_master is identical');
    assertEqualOrThrow(getCurrentSchemaVersion(), CORE, 'upstream version is unchanged');
    assertEqualOrThrow(pizzaVersion(db), PIZZA, 'pizza version is unchanged');
    sameOrThrow(pizzaRowCounts(db), [1, 1, 1], 'pizza rows are kept');
    assertEqualOrThrow(backupsIn(dirA).length, 1, 'no backup is taken when nothing is pending');
  });

  await testCase(
    '3. Health check and restore accept the pizza tables, not an undeclared one',
    async () => {
      sameOrThrow(findingIds(), [], 'the health check reports no findings');
      forkBackup = (await createBackup(path.join(root, 'fork-backup.db'))).path;
      assertEqualOrThrow(isHealthyDatabaseFile(forkBackup), true, 'a backup with them is healthy');

      const rogueBackup = path.join(root, 'rogue-backup.db');
      fs.copyFileSync(forkBackup, rogueBackup);
      const rogue = new Database(rogueBackup);
      rogue.exec('CREATE TABLE rogue_table (x TEXT)');
      rogue.close();
      assertEqualOrThrow(isHealthyDatabaseFile(rogueBackup), false, 'an undeclared table is not');
      const rogueRestore = restoreBackup(rogueBackup);
      assertEqualOrThrow(rogueRestore.success, false, 'restoring it is refused');
      assertIncludesOrThrow(
        String(rogueRestore.error),
        'unapproved schema object table:rogue_table',
        'the refusal names the undeclared table',
      );
      getDatabase().exec('CREATE TABLE rogue_live (x TEXT)');
      sameOrThrow(findingIds(), ['extra_table:rogue_live'], 'the health check reports it');
      getDatabase().exec('DROP TABLE rogue_live');

      for (const table of PIZZA_TABLES) getDatabase().prepare(`DELETE FROM ${table}`).run();
      const restore = restoreBackup(forkBackup);
      assertEqualOrThrow(restore.success, true, `the backup restores (${restore.error})`);
      sameOrThrow(pizzaRowCounts(getDatabase()), [1, 1, 1], 'pizza rows come back');
      assertEqualOrThrow(pizzaVersion(getDatabase()), PIZZA, 'pizza version comes back');
      closeDatabase();
    },
  );

  const dirB = useDir('b-upstream-install');
  await testCase('4. A real upstream database gains the tables and keeps its data', () => {
    fs.copyFileSync(upstream.db, path.join(dirB, 'flo.db'));
    initDatabase();
    const db = getDatabase();
    assertEqualOrThrow(getCurrentSchemaVersion(), CORE, 'the upstream version is untouched');
    sameOrThrow(
      getTables(db)
        .filter((table: string) => !upstreamTables.includes(table))
        .sort(),
      PIZZA_TABLES,
      'the pizza tables are added',
    );
    assertEqualOrThrow(pizzaVersion(db), PIZZA, 'the pizza version is recorded');
    sameOrThrow(
      db.prepare("SELECT name, price FROM products WHERE id = 'up-prod'").get(),
      { name: 'Upstream product', price: 12.5 },
      'the upstream product row is intact',
    );
    sameOrThrow(findingIds(), [], 'the health check reports no findings');

    const taken = backupsIn(dirB);
    sameOrThrow(
      taken.map((name) => name.replace(/^flo-backup-.*(-pre-v)/, '$1')),
      [`-pre-v${CORE}-to-v${CORE}.db`],
      'one pre-migration backup is taken, with -pre-v in its name',
    );
    const pre = new Database(path.join(dirB, 'backups', taken[0]), { readonly: true });
    try {
      assertEqualOrThrow(hasTable(pre, 'pizza_products'), false, 'it predates the pizza tables');
      assertEqualOrThrow(
        pre.prepare("SELECT COUNT(*) AS n FROM products WHERE id = 'up-prod'").get().n,
        1,
        'it holds the upstream data',
      );
    } finally {
      pre.close();
    }

    assertEqualOrThrow(
      isHealthyDatabaseFile(upstream.backup),
      true,
      'a backup made by upstream is still a healthy file',
    );
    const restore = restoreBackup(upstream.backup);
    assertEqualOrThrow(
      restore.success,
      true,
      `a backup made by upstream restores (${restore.error})`,
    );
    sameOrThrow(
      PIZZA_TABLES.map((table) => hasTable(getDatabase(), table)),
      [true, true, true],
      'the restored database has the pizza tables',
    );
    assertEqualOrThrow(pizzaVersion(getDatabase()), PIZZA, 'and the pizza version');
    assertEqualOrThrow(
      getDatabase().prepare("SELECT COUNT(*) AS n FROM products WHERE id = 'up-prod'").get().n,
      1,
      'and the upstream data',
    );
    sameOrThrow(findingIds(), [], 'the health check reports no findings after the restore');
    closeDatabase();
  });

  useDir('c-currency-reset');
  await testCase('5. A currency reset keeps the pizza menu like the rest of the menu', async () => {
    initDatabase();
    const db = getDatabase();
    const setting = db.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    );
    setting.run('country', 'CA', STAMP);
    setting.run('currency', 'CAD', STAMP);
    setting.run('timezone', 'America/Vancouver', STAMP);
    db.prepare("INSERT INTO categories (id, name) VALUES ('cat-pizzas', 'Pizzas')").run();
    const product = db.prepare(
      "INSERT INTO products (id, category_id, name, price) VALUES (?, 'cat-pizzas', ?, ?)",
    );
    product.run('pz-garden', 'Garden', 18.99);
    product.run('dl-party', 'Party pack', 54);
    db.prepare("INSERT INTO customers (id, name) VALUES ('cust-1', 'Customer')").run();
    const pizzaProduct = db.prepare(
      `INSERT INTO pizza_products (product_id, menu_id, kind, ingredients, picks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    pizzaProduct.run('pz-garden', 'garden', 'pizza', '["Olives","Onions"]', null, STAMP, STAMP);
    pizzaProduct.run(
      'dl-party',
      'party',
      'deal',
      null,
      '[{"type":"pizza","size":"large","count":2}]',
      STAMP,
      STAMP,
    );
    pizzaProduct.run('pz-gone', 'gone', 'pizza', '[]', null, STAMP, STAMP);
    const catalog = {
      sizes: [{ id: 'large', label: 'Large', priceCents: 1899 }],
      pizzas: [{ id: 'garden', name: 'Garden', description: 'Olives & onions', ingredients: [] }],
      dips: [{ id: 'ranch', label: 'Ranch', priceCents: 150 }],
      sides: [{ id: 'toast', name: 'Garlic toast', priceCents: 499 }],
      drinks: [{ id: 'cola', label: 'Cola' }],
      drinkVariants: [{ id: 'can', label: 'Can', priceCents: 175 }],
      drinksPst: true,
      deals: [
        {
          id: 'party',
          name: 'Party pack',
          priceCents: 5400,
          description: '',
          picks: [{ type: 'pizza', size: 'large', count: 2 }],
        },
      ],
      tax: { gst: 5, pst: 7 },
    };
    db.prepare('INSERT INTO pizza_menu (id, catalog, imported_at) VALUES (1, ?, ?)').run(
      JSON.stringify(catalog),
      STAMP,
    );
    const button = db.prepare(
      `INSERT INTO pizza_quick_buttons (id, label, customer_id, product_id, addons, created_at, updated_at)
       VALUES (?, ?, ?, 'pz-garden', '[{"id":"ad-dip-ranch","price":1.5}]', ?, ?)`,
    );
    button.run('qb-shop', 'Large garden', null, STAMP, STAMP);
    button.run('qb-customer', 'The usual', 'cust-1', STAMP, STAMP);
    const keptProducts = rows(db, 'pizza_products').filter(
      (row: any) => row.product_id !== 'pz-gone',
    );

    await resetDatabaseForCurrencyChange('USD', 'CAD');

    const fresh = getDatabase();
    sameOrThrow(
      fresh.prepare('SELECT id, price FROM products ORDER BY id').all(),
      [
        { id: 'dl-party', price: 0 },
        { id: 'pz-garden', price: 0 },
      ],
      'upstream keeps the products and zeroes their prices',
    );
    sameOrThrow(
      rows(fresh, 'pizza_products'),
      keptProducts,
      'pizza_products rows of kept products survive unchanged; one without a product is dropped',
    );
    const menu = rows(fresh, 'pizza_menu') as any[];
    assertEqualOrThrow(menu.length, 1, 'the stored catalogue survives');
    assertEqualOrThrow(menu[0].imported_at, STAMP, 'with its import time');
    sameOrThrow(
      JSON.parse(menu[0].catalog),
      JSON.parse(JSON.stringify(catalog).replace(/"priceCents":\d+/g, '"priceCents":0')),
      'its prices are zeroed, since they are in the old currency, and nothing else changes',
    );
    sameOrThrow(rows(fresh, 'pizza_quick_buttons'), [], 'quick buttons are cleared');
    assertEqualOrThrow(pizzaVersion(fresh), PIZZA, 'the pizza version is recorded');
    sameOrThrow(findingIds(), [], 'the health check reports no findings');
    closeDatabase();
  });

  await testCase('6. A later upstream migration still runs', () => {
    MIGRATIONS.push({
      version: CORE + 1,
      name: 'test_only_later_upstream_migration',
      up: () => getDatabase().exec('CREATE TABLE test_later_upstream (id INTEGER PRIMARY KEY)'),
    });
    try {
      const dirD = useDir('d-later-upstream');
      fs.copyFileSync(forkBackup, path.join(dirD, 'flo.db'));
      initDatabase();
      let db = getDatabase();
      assertEqualOrThrow(getCurrentSchemaVersion(), CORE + 1, 'it runs on a pizza database');
      assertEqualOrThrow(hasTable(db, 'test_later_upstream'), true, 'and creates its table');
      assertEqualOrThrow(pizzaVersion(db), PIZZA, 'the pizza version is left alone');
      sameOrThrow(pizzaRowCounts(db), [1, 1, 1], 'pizza rows are kept');
      sameOrThrow(findingIds(), [], 'the health check reports no findings');
      sameOrThrow(
        backupsIn(dirD).map((name) => name.replace(/^flo-backup-.*(-pre-v)/, '$1')),
        [`-pre-v${CORE}-to-v${CORE + 1}.db`],
        'one pre-migration backup is taken',
      );
      closeDatabase();

      const dirE = useDir('e-both-pending');
      fs.copyFileSync(upstream.db, path.join(dirE, 'flo.db'));
      initDatabase();
      db = getDatabase();
      assertEqualOrThrow(getCurrentSchemaVersion(), CORE + 1, 'both lists pending: upstream runs');
      assertEqualOrThrow(pizzaVersion(db), PIZZA, 'and the pizza list runs');
      sameOrThrow(
        backupsIn(dirE).map((name) => name.replace(/^flo-backup-.*(-pre-v)/, '$1')),
        [`-pre-v${CORE}-to-v${CORE + 1}.db`],
        'with one backup for the two',
      );
      closeDatabase();
    } finally {
      MIGRATIONS.pop();
    }
  });

  // The next two cases stand in for a later build: a second, test-only pizza migration.
  const { PIZZA_MIGRATIONS } = require('../main/pizza/migrations');
  const laterPizzaMigration = {
    version: PIZZA + 1,
    name: 'test_only_later_pizza_migration',
    up: (db: any) => {
      db.exec('CREATE TABLE IF NOT EXISTS pizza_test_later (id TEXT PRIMARY KEY)');
      if (!columnsOf(db, 'pizza_products').includes('test_note TEXT'))
        db.exec('ALTER TABLE pizza_products ADD COLUMN test_note TEXT');
    },
  };
  const backupDirA = path.join(dirA, 'backups');
  const olderPizzaBackup = path.join(backupDirA, 'flo-backup-older-pizza.db');
  const upstreamMadeBackup = path.join(backupDirA, 'flo-backup-upstream-made.db');
  const newerPizzaBackup = path.join(backupDirA, 'flo-backup-newer-pizza.db');

  await testCase('7. A backup at an older pizza version stays valid for recovery', async () => {
    useDir('a-new');
    initDatabase();
    await createBackup(olderPizzaBackup);
    fs.copyFileSync(upstream.backup, upstreamMadeBackup);
    closeDatabase();
    const backupsBefore = backupsIn(dirA);

    PIZZA_MIGRATIONS.push(laterPizzaMigration);
    forgetCachedSchemas();
    initDatabase();
    const db = getDatabase();
    assertEqualOrThrow(pizzaVersion(db), PIZZA + 1, 'the later pizza migration runs');
    assertEqualOrThrow(hasTable(db, 'pizza_test_later'), true, 'and creates its table');
    assertEqualOrThrow(getCurrentSchemaVersion(), CORE, 'the upstream version is untouched');
    sameOrThrow(pizzaRowCounts(db), [1, 1, 1], 'pizza rows are kept');
    sameOrThrow(findingIds(), [], 'the health check reports no findings');
    const taken = backupsIn(dirA).filter((name) => !backupsBefore.includes(name));
    sameOrThrow(
      taken.map((name) => name.replace(/^flo-backup-.*(-pre-v)/, '$1')),
      [`-pre-v${CORE}-to-v${CORE}.db`],
      'a pre-migration backup is taken when only a pizza migration is pending',
    );
    db.prepare("UPDATE pizza_products SET test_note = 'written by the later build'").run();
    await createBackup(newerPizzaBackup);

    assertEqualOrThrow(
      isHealthyDatabaseFile(olderPizzaBackup),
      true,
      'a file at the older pizza version is a healthy file',
    );
    const discovery = await discoverDowngradeBackupsAsync();
    const compatible = discovery.compatible.map((backup: any) => backup.fileName);
    // The backup a brand-new install takes holds no schema; upstream lists it as invalid.
    sameOrThrow(
      discovery.corruptOrInvalid
        .filter((backup: any) => !backup.fileName.includes('-pre-v0-to-'))
        .map((backup: any) => `${backup.fileName}: ${backup.detail}`),
      [],
      'recovery discovery lists no backup with a schema as invalid',
    );
    for (const file of [olderPizzaBackup, upstreamMadeBackup, path.join(backupDirA, taken[0])]) {
      assertOrThrow(
        compatible.includes(path.basename(file)),
        `recovery discovery lists ${path.basename(file).replace(/^flo-backup-.*(-pre-v)/, '$1')} as valid`,
      );
    }

    const restore = restoreBackup(olderPizzaBackup);
    assertEqualOrThrow(restore.success, true, `the older backup restores (${restore.error})`);
    assertEqualOrThrow(
      pizzaVersion(getDatabase()),
      PIZZA + 1,
      'and is brought to the later version',
    );
    sameOrThrow(
      getDatabase().prepare('SELECT product_id, test_note FROM pizza_products').all(),
      [{ product_id: 'pz-garden', test_note: null }],
      "with the backup's rows and the later column",
    );
    sameOrThrow(findingIds(), [], 'the health check reports no findings after the restore');
    closeDatabase();
  });

  await testCase('8. A pizza version newer than the build enters downgrade recovery', async () => {
    // Back to this build: the database in a-new is now one pizza version ahead of it.
    PIZZA_MIGRATIONS.pop();
    forgetCachedSchemas();
    useDir('a-new');
    const dbFile = path.join(dirA, 'flo.db');
    const before = sha256(dbFile);
    let caught: any;
    try {
      initDatabase();
    } catch (error) {
      caught = error;
    }
    closeDatabase();
    assertOrThrow(
      isSchemaVersionMismatchError(caught),
      `opening it raises the schema version mismatch that starts downgrade recovery (got: ${caught?.message ?? 'no error'})`,
    );
    assertEqualOrThrow(
      caught.dbVersion,
      CORE + 1,
      'it is reported as one schema version past the supported one',
    );
    assertEqualOrThrow(sha256(dbFile), before, 'the newer database file is not changed');

    const discovery = await discoverDowngradeBackupsAsync();
    const compatible = discovery.compatible.map((backup: any) => backup.fileName);
    const newer = discovery.incompatibleNewer.map((backup: any) => backup.fileName);
    assertOrThrow(
      compatible.includes(path.basename(olderPizzaBackup)),
      'the backup at this build’s pizza version is offered',
    );
    assertOrThrow(
      newer.includes(path.basename(newerPizzaBackup)),
      'a backup at the newer pizza version is listed as needing a newer build',
    );
    assertOrThrow(
      !compatible.includes(path.basename(newerPizzaBackup)),
      'and is not offered for restore',
    );

    const result = await restoreCompatibleBackupForDowngrade(olderPizzaBackup, {
      newerDbVersion: caught.dbVersion,
    });
    assertEqualOrThrow(fs.existsSync(result.preservedDbPath), true, 'the newer database is kept');
    assertEqualOrThrow(sha256(result.preservedDbPath), before, 'byte for byte');
    closeDatabase();
    initDatabase();
    const db = getDatabase();
    assertEqualOrThrow(pizzaVersion(db), PIZZA, 'the restored database is at this build’s version');
    assertEqualOrThrow(hasTable(db, 'pizza_test_later'), false, 'without the later table');
    sameOrThrow(pizzaRowCounts(db), [1, 1, 1], 'and with the pizza rows of the backup');
    sameOrThrow(findingIds(), [], 'the health check reports no findings');

    const refused = restoreBackup(newerPizzaBackup);
    assertEqualOrThrow(
      refused.success,
      false,
      'an ordinary restore of the newer backup is refused',
    );
    assertIncludesOrThrow(String(refused.error), 'pizza schema', 'and says why');
    sameOrThrow(pizzaRowCounts(getDatabase()), [1, 1, 1], 'leaving the live database as it was');
    closeDatabase();
  });

  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  if (failedCases.length > 0) console.error(`Failed cases:\n  ${failedCases.join('\n  ')}`);
  process.exit(failedCases.length > 0 || results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
