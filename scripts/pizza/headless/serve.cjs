#!/usr/bin/env node
// What the service unit runs: takes the data folder's lock, shared, before anything opens the
// database, then loads the server into this same process, so the lock lasts as long as it does.
const path = require('node:path');
const { repoRoot, config, dataLock } = require('./common.cjs');

const PINNED = ['FLO_DEV_USER_DATA', 'PORT', 'KDS_PORT', 'SERVER_APP_PORT'];

try {
  const dataDir = path.resolve(config('FLO_DEV_USER_DATA').FLO_DEV_USER_DATA);
  process.env.FLO_DEV_USER_DATA = dataDir;
  dataLock(dataDir, 'shared');
} catch (error) {
  console.error(`ERROR: ${error?.message ?? error}`);
  process.exit(1);
}
// dev-server.js loads a .env from the repository folder over the environment. The unit's
// settings stay as they are, so the server opens the database in the folder locked above.
process.env = new Proxy(process.env, {
  set(env, name, value) {
    if (!PINNED.includes(name)) return Reflect.set(env, name, value);
    if (env[name] !== String(value))
      console.warn(`[headless] ignored ${name} from .env: the service keeps ${env[name]}`);
    return true;
  },
});
require(path.join(repoRoot, 'dev-server.js'));
