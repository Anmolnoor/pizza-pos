/**
 * SPIKE (throwaway): proves the separate pizza migration track against real SQLite files.
 *
 * Usage: HOME=$(mktemp -d) node tests/run-electron-node-test.cjs tests/spike-pizza-migrations.test.ts
 *
 * The "existing upstream install" is not simulated: the unmodified upstream tree (b5928ec) is
 * extracted with `git archive` and run in a child process to produce a real v125 database and a
 * real upstream backup, neither of which has ever seen the pizza track.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const assert = require('node:assert/strict');

const UPSTREAM_COMMIT = 'b5928ec';
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-pizza-migrations-'));
let userData = '';
Module._load = function (request: string) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => userData, getVersion: () => 'spike' },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const dbModule = require('../main/db');
const { initDatabase, getDatabase, closeDatabase, MIGRATIONS, getCurrentSchemaVersion } = dbModule;
const { createBackup, restoreBackup, isHealthyDatabaseFile } = dbModule;
const { runHealthCheck } = require('../main/services/schema-health');
const { PIZZA_MIGRATIONS, getPizzaSchemaVersion } = require('../main/pizza/migrations');

const CORE = MIGRATIONS[MIGRATIONS.length - 1].version;
const PIZZA = PIZZA_MIGRATIONS[PIZZA_MIGRATIONS.length - 1].version;

function useDir(name: string): string {
  userData = path.join(root, name);
  fs.mkdirSync(userData, { recursive: true });
  return userData;
}
const hasTable = (db: any, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const schemaDump = (db: any) =>
  JSON.stringify(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all());
const backupsIn = (dir: string) =>
  fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).sort() : [];
const pizzaRows = () => getDatabase().prepare('SELECT * FROM pizza_sizes').all();
const findingIds = () => runHealthCheck(getDatabase()).findings.map((f: any) => f.id);
function ok(label: string) {
  console.log(`  PASS ${label}`);
}

function buildUpstreamFixture(): { db: string; backup: string } {
  const tree = path.join(root, 'upstream-tree');
  const out = path.join(root, 'upstream-out');
  fs.mkdirSync(tree);
  fs.mkdirSync(out);
  execSync(`git archive ${UPSTREAM_COMMIT} main shared | tar -x -C "${tree}"`, { cwd: repo });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(tree, 'node_modules'));
  assert.equal(
    fs.existsSync(path.join(tree, 'main/pizza')),
    false,
    'upstream tree has no pizza code',
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, 'tests/run-electron-node-test.cjs'),
      path.join(repo, 'tests/spike-gen-upstream-fixture.ts'),
    ],
    { env: { ...process.env, SPIKE_OUT: out, SPIKE_REPO: tree }, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `upstream fixture generation failed:\n${result.stdout}\n${result.stderr}`,
  );
  return { db: path.join(out, 'flo.db'), backup: path.join(out, 'upstream-backup.db') };
}

async function main() {
  console.log(`Spike: pizza migration track (core v${CORE}, pizza v${PIZZA})`);
  const upstream = buildUpstreamFixture();
  {
    const raw = new Database(upstream.db, { readonly: true });
    assert.equal(raw.pragma('user_version', { simple: true }), CORE);
    assert.equal(hasTable(raw, 'pizza_sizes'), false);
    assert.equal(hasTable(raw, '_flo_meta'), false);
    raw.close();
    ok(
      `fixture: genuine upstream ${UPSTREAM_COMMIT} database at v${CORE}, no pizza table, no _flo_meta`,
    );
  }

  // ── (a) brand-new database ────────────────────────────────────────────────
  const dirA = useDir('a-fresh');
  initDatabase();
  let db = getDatabase();
  assert.equal(getCurrentSchemaVersion(), CORE);
  assert.equal(hasTable(db, 'pizza_sizes'), true);
  assert.equal(getPizzaSchemaVersion(db), PIZZA);
  assert.deepEqual(
    db.prepare("SELECT value FROM _flo_meta WHERE key = 'pizza_schema_version'").get(),
    { value: String(PIZZA) },
  );
  assert.equal(
    backupsIn(dirA).length,
    1,
    'a fresh install takes one pre-migration backup, not two',
  );
  assert.match(backupsIn(dirA)[0], new RegExp(`-pre-v0-to-v${CORE}\\.db$`));
  db.prepare('INSERT INTO pizza_sizes (id, name, sort_order) VALUES (?, ?, ?)').run(
    's-large',
    'Large',
    1,
  );
  ok(
    `(a) fresh db: user_version=${CORE}, pizza_sizes exists, _flo_meta.pizza_schema_version=${PIZZA}`,
  );

  // ── (c) running migrations twice changes nothing ──────────────────────────
  const dumpBefore = schemaDump(db);
  closeDatabase();
  initDatabase();
  db = getDatabase();
  assert.equal(schemaDump(db), dumpBefore);
  assert.equal(getCurrentSchemaVersion(), CORE);
  assert.equal(getPizzaSchemaVersion(db), PIZZA);
  assert.equal(pizzaRows().length, 1);
  assert.equal(backupsIn(dirA).length, 1, 'no backup when nothing is pending');
  ok('(c) second open: identical sqlite_master, same versions, row kept, no extra backup');

  // ── (d) health check + backup/restore validation accept the pizza table ───
  assert.deepEqual(findingIds(), [], 'schema health reports no findings');
  const forkBackup = (await createBackup(path.join(root, 'fork-backup-core125.db'))).path;
  assert.equal(isHealthyDatabaseFile(forkBackup), true);
  ok('(d) runHealthCheck: 0 findings; isHealthyDatabaseFile(fork backup with pizza_sizes) = true');

  // Negative control: the same checks do reject a table nobody declared.
  const rogueBackup = path.join(root, 'rogue-backup.db');
  fs.copyFileSync(forkBackup, rogueBackup);
  const rogue = new Database(rogueBackup);
  rogue.exec('CREATE TABLE rogue_table (x TEXT)');
  rogue.close();
  assert.equal(isHealthyDatabaseFile(rogueBackup), false);
  const rogueRestore = restoreBackup(rogueBackup);
  assert.equal(rogueRestore.success, false);
  assert.match(rogueRestore.error, /unapproved schema object table:rogue_table/);
  getDatabase().exec('CREATE TABLE rogue_live (x TEXT)');
  assert.deepEqual(findingIds(), ['extra_table:rogue_live']);
  getDatabase().exec('DROP TABLE rogue_live');
  ok(`(d) control: undeclared table is rejected (restore error: "${rogueRestore.error}")`);

  getDatabase().prepare('DELETE FROM pizza_sizes').run();
  const sameVersionRestore = restoreBackup(forkBackup);
  assert.equal(sameVersionRestore.success, true, sameVersionRestore.error);
  assert.deepEqual(pizzaRows(), [{ id: 's-large', name: 'Large', sort_order: 1 }]);
  assert.equal(getPizzaSchemaVersion(getDatabase()), PIZZA);
  ok('(d) restoreBackup(fork backup): success, pizza row and pizza version restored');
  closeDatabase();

  // ── (b) existing upstream install opened by the fork ──────────────────────
  const dirB = useDir('b-upstream-install');
  fs.copyFileSync(upstream.db, path.join(dirB, 'flo.db'));
  initDatabase();
  db = getDatabase();
  assert.equal(getCurrentSchemaVersion(), CORE, 'core version untouched');
  assert.equal(hasTable(db, 'pizza_sizes'), true);
  assert.equal(getPizzaSchemaVersion(db), PIZZA);
  assert.deepEqual(db.prepare("SELECT name, price FROM products WHERE id = 'up-prod'").get(), {
    name: 'Upstream Margherita',
    price: 12.5,
  });
  assert.deepEqual(findingIds(), []);
  ok(
    '(b) upstream v125 db: pizza_sizes added, pizza version recorded, upstream product row intact',
  );

  // ── (e) pre-migration backup when only the pizza track is pending ─────────
  const backupsB = backupsIn(dirB);
  assert.equal(backupsB.length, 1);
  assert.match(backupsB[0], new RegExp(`-pre-v${CORE}-to-v${CORE}\\.db$`));
  const pre = new Database(path.join(dirB, 'backups', backupsB[0]), { readonly: true });
  assert.equal(pre.pragma('user_version', { simple: true }), CORE);
  assert.equal(hasTable(pre, 'pizza_sizes'), false, 'snapshot predates the pizza track');
  assert.equal(pre.prepare("SELECT COUNT(*) AS n FROM products WHERE id = 'up-prod'").get().n, 1);
  assert.deepEqual(
    pre
      .prepare('SELECT key FROM _flo_meta ORDER BY key')
      .all()
      .map((r: any) => r.key),
    ['app_version', 'backup_created_at', 'schema_version'],
  );
  pre.close();
  ok(`(e) pizza-only pending: backup ${backupsB[0]} taken, holds pre-pizza state`);

  // ── (d) restoring a backup made by upstream (no pizza table) into the fork ─
  const upstreamBackupHealthy = isHealthyDatabaseFile(upstream.backup);
  // Known limitation: the strict file predicate compares against "core + all pizza migrations",
  // so a pizza-less upstream file is not "healthy" until restore's staged repair adds the table.
  assert.equal(upstreamBackupHealthy, false);
  console.log(
    '  INFO isHealthyDatabaseFile(upstream-made backup, no pizza table) = false (limitation)',
  );
  const upstreamRestore = restoreBackup(upstream.backup);
  assert.equal(upstreamRestore.success, true, upstreamRestore.error);
  assert.equal(hasTable(getDatabase(), 'pizza_sizes'), true);
  assert.equal(getPizzaSchemaVersion(getDatabase()), PIZZA);
  assert.equal(
    getDatabase().prepare("SELECT COUNT(*) AS n FROM products WHERE id = 'up-prod'").get().n,
    1,
  );
  assert.deepEqual(findingIds(), []);
  ok('(d) restoreBackup(upstream-made v125 backup): success, pizza track applied after restore');
  closeDatabase();

  // ── (f) upstream ships core migration 126 after the pizza track has run ───
  MIGRATIONS.push({
    version: CORE + 1,
    name: 'spike_dummy_upstream_migration',
    up: () => getDatabase().exec('CREATE TABLE spike_core_dummy (id INTEGER PRIMARY KEY)'),
  });
  try {
    useDir('a-fresh');
    initDatabase();
    db = getDatabase();
    assert.equal(getCurrentSchemaVersion(), CORE + 1);
    assert.equal(hasTable(db, 'spike_core_dummy'), true);
    assert.equal(getPizzaSchemaVersion(db), PIZZA, 'pizza version unaffected by a core migration');
    assert.deepEqual(pizzaRows(), [{ id: 's-large', name: 'Large', sort_order: 1 }]);
    assert.deepEqual(findingIds(), []);
    assert.equal(
      backupsIn(dirA).filter((f: string) => f.endsWith(`-pre-v${CORE}-to-v${CORE + 1}.db`)).length,
      1,
    );
    const backup126 = (await createBackup(path.join(root, 'fork-backup-core126.db'))).path;
    assert.equal(isHealthyDatabaseFile(backup126), true);
    ok(`(f) core v${CORE + 1} ran on a pizza db: pizza version/table/row untouched, health clean`);

    // An older fork backup (core 125 + pizza) restores and migrates forward.
    getDatabase().prepare('DELETE FROM pizza_sizes').run();
    const olderFork = restoreBackup(forkBackup);
    assert.equal(olderFork.success, true, olderFork.error);
    assert.equal(getCurrentSchemaVersion(), CORE + 1);
    assert.deepEqual(pizzaRows(), [{ id: 's-large', name: 'Large', sort_order: 1 }]);
    ok(`(f) older fork backup (core v${CORE} + pizza) restores and migrates to v${CORE + 1}`);

    // An older upstream backup (core 125, no pizza) restores and gets both tracks.
    const olderUpstream = restoreBackup(upstream.backup);
    assert.equal(olderUpstream.success, true, olderUpstream.error);
    assert.equal(getCurrentSchemaVersion(), CORE + 1);
    assert.equal(getPizzaSchemaVersion(getDatabase()), PIZZA);
    assert.equal(hasTable(getDatabase(), 'pizza_sizes'), true);
    ok(
      `(f) older upstream backup (core v${CORE}, no pizza) restores to v${CORE + 1} + pizza v${PIZZA}`,
    );
    closeDatabase();

    // Both tracks pending at once: one backup, core first, then pizza.
    const dirC = useDir('c-upstream-both-pending');
    fs.copyFileSync(upstream.db, path.join(dirC, 'flo.db'));
    initDatabase();
    assert.equal(getCurrentSchemaVersion(), CORE + 1);
    assert.equal(getPizzaSchemaVersion(getDatabase()), PIZZA);
    assert.equal(backupsIn(dirC).length, 1);
    assert.match(backupsIn(dirC)[0], new RegExp(`-pre-v${CORE}-to-v${CORE + 1}\\.db$`));
    ok('(f) both tracks pending: single pre-migration backup, both applied');
    closeDatabase();
  } finally {
    MIGRATIONS.pop();
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('ALL SPIKE CHECKS PASSED');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
