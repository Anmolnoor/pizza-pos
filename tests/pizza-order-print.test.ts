/**
 * The recipe on an order line, on the server print paths and the kitchen
 * display: the kitchen ticket and the classic and compact receipts print the
 * recipe's detail lines under FloCafe's own item heading, wrapped for the
 * printer's real column count, and a restricted station's item carries the recipe.
 *
 * Run: npm run test:pizza-order-print
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  rows,
  runCases,
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
} = require('./helpers/pizza-print-harness');
const { seedPizzaMenu } = require('./helpers/pizza-fixture');
const net = require('node:net');
const { projectKdsItem } = require('../main/db');
const { printKOTDetailed, prepareReceipt } = require('../main/printers/thermal');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { getEffectiveOrderItems } = require('../main/routes/printers');
const { ticketLines } = require('../shared/pizza/ticket');

const INDENT = '   ';
const whole = (pizzaId: string, removed: string[] = []) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  whole: { pizzaId, removed },
});
const half = {
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [
    { pizzaId: 'island', removed: ['Pineapple'] },
    { pizzaId: 'classic', removed: [] },
  ],
};
const threeLarge = {
  kind: 'deal',
  v: 1,
  dealId: 'three-large-wings',
  pizzas: [
    whole('garden', ['Olives']),
    {
      kind: 'pizza',
      v: 1,
      sizeId: 'large',
      halves: [
        { pizzaId: 'island', removed: [] },
        { pizzaId: 'plain', removed: [] },
      ],
    },
    whole('classic'),
  ],
  wingFlavour: 'sweet-chili',
};

// The contract's ticket text; every line fits 42 and 48 columns.
const HALF_LINES = ['1ST: ISLAND', '  NO PINEAPPLE', '2ND: CLASSIC PEPPERONI'];
// At extra large text a 48-column printer lays out 24: the long second half wraps.
const HALF_LINES_24 = ['1ST: ISLAND', '  NO PINEAPPLE', '2ND: CLASSIC', 'PEPPERONI'];
const DEAL_LINES = [
  '1) LARGE GARDEN',
  '   NO OLIVES',
  '2) LARGE HALF & HALF',
  '   1ST: ISLAND',
  '   2ND: PLAIN CHEESE',
  '3) LARGE CLASSIC PEPPERONI',
  'WINGS: SWEET CHILI',
];

/** Paper and text size as stored on a printer, and the columns layout gets for them. */
const PRINTERS = [
  { label: '42 columns', paper_width: 'cols-42', text_size: 'normal', columns: 42 },
  { label: '48 columns', paper_width: 'cols-48', text_size: 'normal', columns: 48 },
  { label: '48 columns, large text', paper_width: 'cols-48', text_size: 'large', columns: 48 },
  {
    label: '48 columns, extra large text',
    paper_width: 'cols-48',
    text_size: 'extra_large',
    columns: 24,
  },
];
const business = { name: 'Sample Pizza Co.', country: 'US', currency: 'USD', timezone: 'UTC' };

/** A loopback socket that stands in for a network printer and keeps what it is sent. */
async function startCapturePrinter() {
  const jobs: Buffer[] = [];
  const server = net.createServer((socket: any) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => jobs.push(Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    printer: {
      id: 'capture',
      name: 'Capture',
      connection_type: 'network',
      ip_address: '127.0.0.1',
      port: server.address().port,
    },
    async lastJob(): Promise<string[]> {
      for (let waited = 0; jobs.length === 0 && waited < 5000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return rows(jobs.pop() ?? Buffer.alloc(0));
    },
  };
}

/** Checks that `lines` print in order, indented and unchanged, and returns the row above them. */
function assertDetailRows(printed: string[], lines: string[], label: string): string {
  const first = printed.indexOf(INDENT + lines[0]);
  assertOrThrow(first > 0, `${label}: the first detail line prints`);
  assertEqualOrThrow(
    JSON.stringify(printed.slice(first, first + lines.length)),
    JSON.stringify(lines.map((line) => INDENT + line)),
    `${label}: the detail lines print in order, unchanged`,
  );
  return printed[first - 1];
}

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const catalog = seedPizzaMenu(db);
  const { baseUrl } = await startServer(
    createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes }),
  );
  const capture = await startCapturePrinter();
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, ip_address, port, is_default)
     VALUES ('capture', 'Capture', 'network', '127.0.0.1', ?, 1)`,
  ).run(capture.printer.port);

  const post = (path: string, body: object) =>
    api(baseUrl, path, { method: 'POST', body, headers: owner.authHeader });
  /** An order placed through the API, loaded back the way the print routes load it. */
  async function placedOrder(items: object[]) {
    const created = await post('/api/orders', { type: 'takeaway', items });
    assertEqualOrThrow(created.status, 201, 'the order is accepted');
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(created.data.order.id) as any;
    order.items = getEffectiveOrderItems(db, String(order.id));
    const bill = (await post('/api/bills/generate', { order_id: order.id })).data.bill;
    return { order, bill };
  }
  /** The ticket and both receipts for one stored printer configuration, as printed rows. */
  async function printAll(placed: { order: any; bill: any }, printer: (typeof PRINTERS)[number]) {
    db.prepare('UPDATE printers SET paper_width = ?, text_size = ?').run(
      printer.paper_width,
      printer.text_size,
    );
    const stored = db.prepare("SELECT * FROM printers WHERE id = 'capture'").get();
    const ticket = await printKOTDetailed(placed.order, placed.order.items, 'Kitchen', false, {
      ...stored,
    });
    assertOrThrow(ticket.ok, `${printer.label}: the kitchen ticket is sent`);
    const receipt = (template: string) => {
      const prepared = prepareReceipt(placed.order, placed.bill, business, template);
      assertEqualOrThrow(prepared.columns, printer.columns, `${printer.label}: layout columns`);
      return rows(prepared.data);
    };
    return {
      'kitchen ticket': await capture.lastJob(),
      'classic receipt': receipt('classic'),
      'compact receipt': receipt('compact'),
    };
  }

  await runCases('pizza-order-print', {
    'Case 1: a half and half and a three-pizza deal print their detail lines': async () => {
      const placed = await placedOrder([
        {
          product_id: 'pz-half-and-half',
          variant_id: 'pz-half-and-half-large',
          quantity: 1,
          modifier_selection: half,
        },
        { product_id: 'dl-three-large-wings', quantity: 1, modifier_selection: threeLarge },
      ]);
      for (const printer of PRINTERS) {
        const budget = printer.columns - INDENT.length;
        const expected = (recipe: object, contract: string[]) => {
          const lines = ticketLines(catalog, recipe, printer.columns).detailLines;
          assertOrThrow(
            lines.every((line: string) => line.length <= budget),
            `${printer.label}: no detail line is wider than the columns less three`,
          );
          const fits = contract.every((line) => line.length <= budget);
          if (fits) return contract;
          assertOrThrow(lines.length > contract.length, `${printer.label}: long lines wrap`);
          return lines;
        };
        if (printer.columns === 24) {
          assertEqualOrThrow(
            JSON.stringify(expected(half, HALF_LINES)),
            JSON.stringify(HALF_LINES_24),
            `${printer.label}: the half and half is wrapped for 24 columns`,
          );
        }
        const documents = await printAll(placed, printer);
        for (const [name, printed] of Object.entries(documents)) {
          const label = `${name}, ${printer.label}`;
          const aboveHalf = assertDetailRows(printed, expected(half, HALF_LINES), `${label}, half`);
          const aboveDeal = assertDetailRows(
            printed,
            expected(threeLarge, DEAL_LINES),
            `${label}, deal`,
          );
          assertOrThrow(
            !printed.join('\n').includes('LARGE PIZZAS & WINGS'),
            `${label}: the heading is not replaced by the recipe's`,
          );
          // The item column of a receipt wraps a name; the ticket heading has the full width.
          if (name === 'kitchen ticket') {
            assertOrThrow(
              /^1x\s+Half & Half/.test(aboveHalf),
              `${label}: lines follow the heading`,
            );
            assertOrThrow(/^1x\s+Large Pizzas/.test(aboveDeal), `${label}: lines follow the deal`);
          } else if (printer.columns >= 42) {
            assertOrThrow(/^Half & Half/.test(aboveHalf), `${label}: lines follow the name`);
            assertOrThrow(
              /^Large Pizzas & Wings/.test(aboveDeal),
              `${label}: lines follow the deal`,
            );
          }
        }
      }
    },

    'Case 2: a line without a recipe prints as before': async () => {
      const plain = [
        { product_id: 'pz-garden', variant_id: 'pz-garden-large', quantity: 1 },
        { product_id: 'sd-green-salad', quantity: 2, modifier_selection: { kind: 'note', a: 1 } },
      ];
      const placed = await placedOrder(plain);
      const withRecipe = await placedOrder([
        ...plain,
        {
          product_id: 'pz-island',
          variant_id: 'pz-island-large',
          quantity: 1,
          modifier_selection: whole('island', ['Ham']),
        },
      ]);
      for (const printer of [PRINTERS[0], PRINTERS[3]]) {
        const documents = await printAll(placed, printer);
        const beside = await printAll(withRecipe, printer);
        for (const [name, printed] of Object.entries(documents)) {
          const label = `${name}, ${printer.label}`;
          assertOrThrow(
            printed.some((row) => row.includes('Garden')) &&
              printed.some((row) => row.includes('Salad')),
            `${label}: both items print`,
          );
          assertOrThrow(
            !printed.some((row) => /^ {3}\S/.test(row)),
            `${label}: no detail line is added`,
          );
          const other = (beside as Record<string, string[]>)[name];
          const detail = other.filter((row) => /^ {3}\S/.test(row));
          assertEqualOrThrow(
            JSON.stringify(detail),
            JSON.stringify([`${INDENT}NO HAM`]),
            `${label}: beside a pizza with a recipe, only that pizza gains a line`,
          );
        }
      }

      // Lines the item already carries still print when it has no recipe.
      placed.order.items[1].detailLines = ['DRESSING ON THE SIDE'];
      const own = await printAll(placed, PRINTERS[0]);
      for (const [name, printed] of Object.entries(own)) {
        assertOrThrow(
          printed.includes(`${INDENT}DRESSING ON THE SIDE`),
          `${name}: an item's own detail lines still print`,
        );
      }
    },

    'Case 3: a restricted kitchen display station gets the recipe': async () => {
      const { order } = await placedOrder([
        {
          product_id: 'pz-half-and-half',
          variant_id: 'pz-half-and-half-large',
          quantity: 1,
          modifier_selection: half,
        },
      ]);
      const projected = projectKdsItem(order.items[0], true);
      assertEqualOrThrow(
        JSON.stringify(projected.modifier_selection),
        JSON.stringify(half),
        'the projected item carries the recipe',
      );
      assertOrThrow(!('unit_price' in projected), 'and still no price');
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
