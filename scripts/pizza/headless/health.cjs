#!/usr/bin/env node
// Fails unless each service answers its own health check on its configured port. The server
// moves to the next port without failing when one is taken, so the port is checked, not assumed.
const { config, main } = require('./common.cjs');

const SERVICES = [
  ['PORT', 'Flo Local API'],
  ['KDS_PORT', 'Flo KDS Server'],
  ['SERVER_APP_PORT', 'Flo Server App'],
];

main(async () => {
  const ports = config(...SERVICES.map(([name]) => name));
  let failed = 0;
  for (const [name, service] of SERVICES) {
    const label = `${name}=${ports[name]} (${service})`;
    try {
      const res = await fetch(`http://127.0.0.1:${ports[name]}/api/health`, {
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
  if (failed > 0)
    throw new Error(`${failed} of ${SERVICES.length} services are not on their configured port`);
});
