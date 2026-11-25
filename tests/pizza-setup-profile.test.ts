/**
 * Pizza fork: the `pizza` setup profile configures a counter-service pizza shop, seeds no
 * menu, and leaves the install offline.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/pizza-setup-profile.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pizza-setup-profile-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-pizza-setup-profile';
// Lift the test-environment suppression, so a telemetry send would really be attempted.
process.env.FLO_TELEMETRY_DEV = '1';
for (const key of ['FLO_MATRIX_OFFLINE', 'E2E_TASK_LOCAL_PORTS', 'FLO_E2E_SKIP_OPTIONAL_NETWORK']) {
  delete process.env[key];
}

// Every attempt to reach anything but this test's own server is recorded and refused.
const outbound: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input?.url ?? input);
  if (new URL(url).hostname === '127.0.0.1') return realFetch(input, init);
  outbound.push(`fetch ${url}`);
  throw new Error('outbound request refused by the test');
}) as typeof fetch;
const ws = require('ws');
ws.WebSocket = Object.setPrototypeOf(function (url: unknown) {
  outbound.push(`ws ${String(url)}`);
  throw new Error('outbound socket refused by the test');
}, ws.WebSocket);

const {
  createApp,
  startServer,
  api,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const { initDatabase, closeDatabase, getDatabase, getSettingValue } = require('../main/db');
const { authRoutes } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');
const { isOfflineMode } = require('../main/services/offline-mode');
const { cloudSync } = require('../main/services/cloud-sync');
const { telemetry } = require('../main/services/telemetry');

let registerCalls = 0;
const originalRegister = cloudSync.register.bind(cloudSync);
cloudSync.register = ((...args: unknown[]) => {
  registerCalls += 1;
  return originalRegister(...args);
}) as any;

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

const MENU_TABLES = ['categories', 'products', 'addon_groups', 'addons'];
const UNSEEDED_TABLES = ['printers', 'kitchen_stations', 'role_permission_overrides', 'tables'];
const count = (table: string): number =>
  (getDatabase().prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number })
    .total;

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
  console.log('Pizza fork: the pizza setup profile');
  console.log('='.repeat(60));
  resetCounters();
  initDatabase();
  const app = createApp({ '/api/auth': authRoutes, '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);
  const before = Object.fromEntries(UNSEEDED_TABLES.map((table) => [table, count(table)]));
  let ownerAuth: Record<string, string> = {};

  try {
    await testCase('1. Setup with the pizza profile succeeds', async () => {
      cloudSync.start();
      telemetry.start();
      const setup = await api(baseUrl, '/api/auth/setup/initialize', {
        method: 'POST',
        body: {
          name: 'Pizza Owner',
          email: 'owner@example.com',
          password: 'TestPass123',
          business_type: 'restaurant',
          business_name: 'Sample Pizza Shop',
          setup_profile: 'pizza',
          // The profile decides counter service, whatever the request asks for.
          service_model: 'finedine',
          terms_accepted: true,
          owner_approval_pin: '5678',
          owner_approval_pin_confirmation: '5678',
          country: 'CA',
          currency: 'CAD',
          timezone: 'America/Vancouver',
        },
      });
      assertEqualOrThrow(setup.status, 200, 'the setup route accepts the pizza profile');
      ownerAuth = { Authorization: `Bearer ${setup.data.access_token}` };
      await settle();
      assertEqualOrThrow(getSettingValue('setup_profile'), 'pizza', 'the profile is recorded');
    });

    await testCase('2. The profile sets counter service and the shop settings', async () => {
      const expected: Record<string, string> = {
        service_model: 'qsr',
        tables_required: 'false',
        kds_enabled: 'false',
        server_app_enabled: 'false',
        auto_print_kot: 'true',
        cash_drawer_pulse_enabled: 'true',
        cash_drawer_pulse_methods: '["cash"]',
        kot_show_customer_contact: 'true',
        taxes_enabled: 'true',
      };
      for (const [key, value] of Object.entries(expected)) {
        assertEqualOrThrow(getSettingValue(key), value, `${key} is ${value}`);
      }

      const printing = await api(baseUrl, '/api/settings/printing', { headers: ownerAuth });
      assertEqualOrThrow(printing.status, 200, 'the printing settings load');
      assertEqualOrThrow(printing.data.auto_print_kot, true, 'kitchen tickets print by themselves');
      assertEqualOrThrow(printing.data.cash_drawer_pulse_enabled, true, 'the drawer pulse is on');
      assertEqualOrThrow(
        JSON.stringify(printing.data.cash_drawer_pulse_methods),
        '["cash"]',
        'the drawer opens for cash only',
      );
      assertEqualOrThrow(printing.data.kds_enabled, false, 'the kitchen display is off');
    });

    await testCase('3. The region is what the request carried', () => {
      assertEqualOrThrow(getSettingValue('country'), 'CA', 'country is Canada');
      assertEqualOrThrow(getSettingValue('currency'), 'CAD', 'currency is CAD');
      assertEqualOrThrow(
        getSettingValue('timezone'),
        'America/Vancouver',
        'time zone is America/Vancouver',
      );
    });

    await testCase('4. No menu, printers, stations or permission overrides are seeded', () => {
      for (const table of MENU_TABLES) {
        assertEqualOrThrow(count(table), 0, `${table} is empty`);
      }
      for (const table of UNSEEDED_TABLES) {
        assertEqualOrThrow(count(table), before[table], `${table} is as the install left it`);
      }
    });

    await testCase('5. Offline mode stays on and nothing outbound is attempted', () => {
      assertEqualOrThrow(getSettingValue('offline_mode'), 'true', 'offline_mode is still on');
      assertEqualOrThrow(isOfflineMode(), true, 'Offline mode is in effect');
      assertEqualOrThrow(getSettingValue('cloud_sync_enabled'), '0', 'cloud sync is off');
      assertEqualOrThrow(registerCalls, 0, 'setup does not register the install');
      assertEqualOrThrow(outbound.join(', '), '', 'no outbound request is attempted');
    });
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  if (failedCases.length > 0) console.error(`Failed cases:\n  ${failedCases.join('\n  ')}`);
  process.exit(failedCases.length > 0 || results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
