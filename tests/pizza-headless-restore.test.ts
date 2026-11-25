/**
 * Pizza fork, headless kit: restoring an older backup with the service stopped brings the store
 * back to that backup, keeps a safety copy of what it replaced, and the server starts on it.
 *
 * Usage: npm run test:pizza-headless-restore
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
const { assertEqualOrThrow, assertOrThrow } = require('./helpers/test-setup');
import {
  backupDir,
  headlessEnv,
  liveDbPath,
  runCases,
  runKit,
  startHeadless,
  type HeadlessEnv,
} from './helpers/headless';

function insertCategory(env: HeadlessEnv, id: string) {
  const db = new Database(liveDbPath(env), { timeout: 5000 });
  try {
    db.prepare(
      "INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
    ).run(id, id);
  } finally {
    db.close();
  }
}

function hasCategory(file: string, id: string): boolean {
  const db = new Database(file, { readonly: true });
  try {
    return Boolean(db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id));
  } finally {
    db.close();
  }
}

async function takeBackup(env: HeadlessEnv): Promise<string> {
  const result = await runKit('backup.cjs', [], env);
  assertEqualOrThrow(result.status, 0, `backup exits 0: ${result.output}`);
  return result.stdout.trim().split('\n').pop()!;
}

void runCases('Pizza headless kit: restore', [
  [
    'restoring an older backup drops the later row and keeps a safety copy',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '5' });
      let server = await startHeadless(env);
      let backup: string;
      try {
        insertCategory(env, 'cat-before');
        backup = await takeBackup(env);
        insertCategory(env, 'cat-after');
      } finally {
        await server.stop();
      }

      const result = await runKit('restore.cjs', [backup], env);
      console.log(result.output);
      assertEqualOrThrow(result.status, 0, 'restore exits 0');

      assertOrThrow(hasCategory(liveDbPath(env), 'cat-before'), 'the backed-up row is back');
      assertOrThrow(!hasCategory(liveDbPath(env), 'cat-after'), 'the later row is gone');

      const safety = fs
        .readdirSync(backupDir(env))
        .filter((name) => name.startsWith('pre-restore-'))
        .map((name) => path.join(backupDir(env), name));
      assertEqualOrThrow(safety.length, 1, 'one safety copy was written');
      assertOrThrow(
        hasCategory(safety[0], 'cat-after'),
        'the safety copy holds the database as it was before the restore',
      );

      server = await startHeadless(env);
      try {
        const health = await runKit('health.cjs', [], env);
        assertEqualOrThrow(
          health.status,
          0,
          `the server is healthy on the restored database: ${health.output}`,
        );
      } finally {
        await server.stop();
      }
    },
  ],
  [
    'restore refuses while the server is running and changes nothing',
    async () => {
      const env = await headlessEnv({ BACKUP_KEEP: '5' });
      const server = await startHeadless(env);
      try {
        insertCategory(env, 'cat-before');
        const backup = await takeBackup(env);
        insertCategory(env, 'cat-after');
        const result = await runKit('restore.cjs', [backup], env);
        console.log(result.output);
        assertOrThrow(result.status !== 0, 'restore exits non-zero');
        assertOrThrow(
          result.stderr.includes('systemctl --user stop pizza-pos.service'),
          'the error tells the operator to stop the service',
        );
        assertOrThrow(hasCategory(liveDbPath(env), 'cat-after'), 'the live database is untouched');
      } finally {
        await server.stop();
      }
    },
  ],
]);
