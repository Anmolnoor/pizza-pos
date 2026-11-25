// Generates a genuine upstream (b5928ec, unmodified) database + stamped backup.
const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const path = require('node:path');
const outDir = process.env.SPIKE_OUT as string;
const repo = process.env.SPIKE_REPO as string;
Module._load = function (request: string) {
  if (request === 'electron')
    return {
      app: { isPackaged: true, getPath: () => outDir, getVersion: () => 'upstream-b5928ec' },
    };
  return originalLoad.apply(this, arguments as any);
};
const db = require(path.join(repo, 'main/db'));
(async () => {
  db.initDatabase();
  const d = db.getDatabase();
  d.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('up-cat', 'Upstream Category');
  d.prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)').run(
    'up-prod',
    'up-cat',
    'Upstream Margherita',
    12.5,
  );
  const backup = await db.createBackup(path.join(outDir, 'upstream-backup.db'));
  console.log('version', db.getCurrentSchemaVersion(), 'backup', backup.path);
  console.log(
    'tables',
    db.getTables(d).length,
    'has _flo_meta in live:',
    !!d.prepare("SELECT 1 FROM sqlite_master WHERE name='_flo_meta'").get(),
  );
  d.pragma('wal_checkpoint(TRUNCATE)');
  db.closeDatabase();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
