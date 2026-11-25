#!/usr/bin/env node
// Restores a backup with the service stopped: copies the current database aside first, then runs
// the same restoreBackup() sequence as the app's restore-from-file route.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { config, backupDir, timestamp, appModule, onlineCopy, main } = require('./common.cjs');

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    socket.setTimeout(2000);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

main(async () => {
  const settings = config('FLO_DEV_USER_DATA', 'PORT', 'KDS_PORT', 'SERVER_APP_PORT');
  if (process.argv.length !== 3) throw new Error('Usage: restore.cjs <backup file>');
  const backupPath = path.resolve(process.argv[2]);
  if (!fs.statSync(backupPath).isFile()) throw new Error(`${backupPath} is not a file`);

  for (const name of ['PORT', 'KDS_PORT', 'SERVER_APP_PORT']) {
    if (await listening(settings[name])) {
      throw new Error(
        `Something is listening on ${name}=${settings[name]}. Stop the POS first: systemctl --user stop pizza-pos.service`,
      );
    }
  }

  const livePath = path.join(settings.FLO_DEV_USER_DATA, 'flo.db');
  const dir = backupDir(settings.FLO_DEV_USER_DATA);
  fs.mkdirSync(dir, { recursive: true });
  const safetyPath = path.join(dir, `pre-restore-${timestamp()}.db`);
  await onlineCopy(livePath, safetyPath);
  console.log(`safety copy: ${safetyPath}`);

  const db = appModule('main/db');
  const { googleDrive } = appModule('main/services/google-drive');
  db.initDatabase();
  try {
    const backupVersion = db.getSchemaVersionFromBackup(backupPath);
    if (backupVersion === null) throw new Error(`${backupPath} has no schema version stamp`);
    const versionMismatch = backupVersion !== db.getCurrentSchemaVersion();
    await googleDrive.prepareForDatabaseRestore();
    const result = await db.withDatabaseMaintenanceLock((signal) =>
      db.restoreBackup(backupPath, !versionMismatch, signal),
    );
    if (!result.success) throw new Error(`Restore failed: ${result.error}`);
    googleDrive.completeDatabaseRestore();
    console.log(`restored ${backupPath} (${result.mode}, schema v${backupVersion})`);
  } finally {
    db.closeDatabase();
  }
});
