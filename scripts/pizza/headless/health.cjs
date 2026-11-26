#!/usr/bin/env node
// Fails unless each service answers its own health check on its configured port, and the newest
// backup is no older than one timer period (a store set up within that period needs none yet).
// The server moves to the next port without failing when one is taken, so the port is checked,
// not assumed.
const fs = require('node:fs');
const path = require('node:path');
const { config, BACKUP_NAME, BACKUP_TIMER, backupDir, main } = require('./common.cjs');

const SERVICES = [
  ['PORT', 'Flo Local API'],
  ['KDS_PORT', 'Flo KDS Server'],
  ['SERVER_APP_PORT', 'Flo Server App'],
];
/** One timer period, and two hours for a backup that starts late or runs long. */
const MAX_BACKUP_AGE_HOURS = BACKUP_TIMER.periodHours + 2;

const hoursSince = (ms) => (Date.now() - ms) / 3_600_000;

/** How long ago the store was set up: the age of its oldest setting. Unreadable counts as old. */
function storeAgeHours(dataDir) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dataDir, 'flo.db'), { readonly: true, fileMustExist: true });
    try {
      const { born } = db.prepare('SELECT MIN(updated_at) AS born FROM settings').get();
      const hours = hoursSince(Date.parse(`${born.replace(' ', 'T')}Z`));
      return Number.isFinite(hours) ? hours : Infinity;
    } finally {
      db.close();
    }
  } catch {
    return Infinity;
  }
}

function checkBackups(dataDir) {
  const dir = backupDir(dataDir);
  const newest = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  const limit = `(limit ${MAX_BACKUP_AGE_HOURS} h)`;
  // A date ahead of the clock is no proof of a recent backup: after a clock rollback it hides one
  // that is missing.
  const recent = (hours) => hours >= 0 && hours <= MAX_BACKUP_AGE_HOURS;
  const age = newest ? hoursSince(newest.mtime) : Infinity;
  const found = !newest
    ? `no pizza-pos-*.db backup in ${dir}`
    : age < 0
      ? `newest ${newest.name} is dated in the future, by ${(-age).toFixed(1)} h`
      : `newest ${newest.name} is ${age.toFixed(1)} h old`;
  if (recent(age)) {
    console.log(`ok   backups: ${found} ${limit}`);
    return true;
  }
  const storeAge = storeAgeHours(dataDir);
  if (recent(storeAge)) {
    console.log(
      `ok   backups: ${found}; the store is ${storeAge.toFixed(1)} h old, so its first daily backup is not due ${limit}`,
    );
    return true;
  }
  console.error(`FAIL backups: ${found} ${limit}`);
  return false;
}

main(async () => {
  const settings = config(...SERVICES.map(([name]) => name), 'FLO_DEV_USER_DATA');
  let failed = 0;
  for (const [name, service] of SERVICES) {
    const label = `${name}=${settings[name]} (${service})`;
    try {
      const res = await fetch(`http://127.0.0.1:${settings[name]}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json();
      if (res.ok && body.status === 'ok' && body.service === service) {
        console.log(`ok   ${label}`);
        continue;
      }
      console.error(`FAIL ${label}: HTTP ${res.status} ${JSON.stringify(body)}`);
    } catch (error) {
      console.error(`FAIL ${label}: ${error?.cause?.code ?? error?.message ?? error}`);
    }
    failed++;
  }
  if (!checkBackups(settings.FLO_DEV_USER_DATA)) failed++;
  if (failed > 0) throw new Error(`${failed} health check(s) failed`);
});
