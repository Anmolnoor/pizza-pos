// SPIKE (throwaway): a second, fork-owned migration track that never touches the core
// MIGRATIONS array or PRAGMA user_version. Its version lives in _flo_meta, which every
// upstream schema comparison already ignores by name.
import type Database from 'better-sqlite3';

export const PIZZA_VERSION_KEY = 'pizza_schema_version';

// Append-only, like the core registry. Entries must be idempotent (IF NOT EXISTS / column
// checks): upstream's schema self-repair can create a missing pizza table before this track
// records its version.
export const PIZZA_MIGRATIONS: {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}[] = [
  {
    version: 1,
    name: 'create_pizza_sizes',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS pizza_sizes (id TEXT PRIMARY KEY, name TEXT, sort_order INTEGER)',
      ),
  },
];

export function getPizzaSchemaVersion(db: Database.Database): number {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_flo_meta'")
    .get();
  if (!hasMeta) return 0;
  const row = db.prepare('SELECT value FROM _flo_meta WHERE key = ?').get(PIZZA_VERSION_KEY) as
    | { value: string }
    | undefined;
  return Number(row?.value) || 0;
}

/** Runs pending pizza migrations. `beforeFirst` fires once, only when there is pending work. */
export function runPizzaMigrations(db: Database.Database, beforeFirst?: () => void): void {
  const current = getPizzaSchemaVersion(db);
  const latest = PIZZA_MIGRATIONS[PIZZA_MIGRATIONS.length - 1]?.version ?? 0;
  if (current > latest) {
    throw new Error(`Pizza schema v${current} is newer than this build supports (v${latest})`);
  }
  const pending = PIZZA_MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;
  beforeFirst?.();
  db.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
  const stamp = db.prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)');
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      stamp.run(PIZZA_VERSION_KEY, String(migration.version));
    })();
  }
}
