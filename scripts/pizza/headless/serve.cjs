#!/usr/bin/env node
// What the service unit runs: takes the data folder's lock, shared, before anything opens the
// database, then loads the server into this same process, so the lock lasts as long as it does.
const path = require('node:path');
const { repoRoot, config, dataLock } = require('./common.cjs');

try {
  dataLock(config('FLO_DEV_USER_DATA').FLO_DEV_USER_DATA, 'shared');
} catch (error) {
  console.error(`ERROR: ${error?.message ?? error}`);
  process.exit(1);
}
require(path.join(repoRoot, 'dev-server.js'));
