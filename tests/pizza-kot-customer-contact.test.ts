/**
 * Customer contact on the kitchen ticket: with `kot_show_customer_contact` on,
 * the header prints the customer's phone number, and for a delivery order the
 * delivery address and delivery note. Off (the default) changes nothing. Set to
 * `delivery`, only a delivery ticket prints them. A scheduled pickup or delivery
 * order's header also prints its time.
 *
 * Run: npm run test:pizza-kot-customer-contact
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  rows,
  runCases,
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCustomer,
  api,
} = require('./helpers/pizza-print-harness');
const net = require('node:net');
const { renderKotViaDocument, renderKotDocumentToLines } = require('../main/printers/document-kot');
const { buildEscPos } = require('../main/printers/formatting-helpers');
const { printKOTDetailed } = require('../main/printers/thermal');
const { settingsRoutes } = require('../main/routes/settings');
const { isKotDocument } = require('../shared/print');

const frontend = loadFrontend();

const SETTING = 'kot_show_customer_contact';
const PHONE = '+16045550100';
const ADDRESS = '1234 West Broadway Avenue, Unit 405, Vancouver BC V6H 1G8';
const NOTE = 'Side door, call on arrival';
const PHONE_LINE = `Customer No: ${PHONE}`;
const ADDRESS_LINE = `Delivery address: ${ADDRESS}`;
const NOTE_LINE = `Delivery note: ${NOTE}`;
const COLUMNS = [42, 48];

const items = [
  {
    id: 1,
    order_id: 1,
    product_id: 'p1',
    product_name: 'Margherita',
    product_sku: null,
    unit_price: 18,
    quantity: 1,
    subtotal: 18,
    tax_amount: 0,
    total: 18,
    addons: [],
    special_instructions: null,
    status: 'pending',
  },
];
const customer = { id: 'cust-1', name: 'Asha Kumar', phone: '+16045550100' };
const baseOrder = {
  id: 1,
  order_number: 'P-7',
  created_at: '2026-01-01T12:00:00.000Z',
  delivery_address: ADDRESS,
  delivery_note: NOTE,
  items,
};
const deliveryOrder: any = { ...baseOrder, type: 'delivery', customer_id: 'cust-1', customer };
const pickupOrder: any = { ...baseOrder, type: 'takeaway', customer_id: 'cust-1', customer };
const anonymousOrder: any = { ...baseOrder, type: 'takeaway', delivery_address: '' };

const kotOptions = (columns: number) => ({
  columns,
  language: 'en',
  timezone: 'UTC',
  useUnicode: false,
  arabicShaping: false,
  cutMode: 'partial' as const,
});

/** The four kitchen ticket paths, each rendered to comparable text. */
type Show = boolean | 'delivery';
const paths: Record<string, (order: any, show: Show, columns: number) => string> = {
  'server ESC/POS': (order, show, columns) =>
    rows(
      renderKotViaDocument(
        show ? { ...order, show_customer_contact: show } : order,
        order.items,
        'Kitchen',
        kotOptions(columns),
      ).data,
    ).join('\n'),
  'browser ESC/POS': (order, show, columns) =>
    rows(
      frontend.kotEncoder.buildKotBytes(
        order,
        {
          columns,
          paperWidth: 80,
          stationName: 'Kitchen',
          language: 'en',
          timezone: 'UTC',
          showCustomerContact: show,
        } as any,
        [],
      ),
    ).join('\n'),
  'raster document': (order, show, columns) => {
    const document = frontend.printDocument.buildFrontendKotDocument(order, {
      stationName: 'Kitchen',
      columns,
      language: 'en',
      timezone: 'UTC',
      showCustomerContact: show,
    } as any);
    assertOrThrow(isKotDocument(document), `raster ${columns}: the document is valid`);
    return rows(
      buildEscPos(renderKotDocumentToLines(document, kotOptions(columns)), false, {
        cutMode: 'partial',
        columns,
        language: 'en',
      }),
    ).join('\n');
  },
  'browser HTML': (order, show) =>
    frontend.kotWebPrint
      .generateKotHtml(order, {
        paperWidth: 80,
        language: 'en',
        stationName: 'Kitchen',
        timezone: 'UTC',
        showCustomerContact: show,
      } as any)
      .replace(/<[^>]+>/g, '\n'),
};

/** Ticket text with wrapped rows rejoined, so a wrapped address still reads whole. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

function forEveryPath(run: (name: string, render: (order: any, show: Show) => string) => void) {
  for (const [name, render] of Object.entries(paths)) {
    for (const columns of name === 'browser HTML' ? [COLUMNS[0]] : COLUMNS) {
      run(`${name} ${columns}`, (order, show) => render(order, show, columns));
    }
  }
}

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
      paper_width: 'cols-42',
    },
    async lastJob(): Promise<string> {
      for (let waited = 0; jobs.length === 0 && waited < 5000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return rows(jobs.pop() ?? Buffer.alloc(0)).join('\n');
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

runCases('pizza-kot-customer-contact', {
  'Case 1: setting off, a delivery ticket has no phone and no address': () => {
    forEveryPath((name, render) => {
      const text = flat(render(deliveryOrder, false));
      assertOrThrow(text.includes('Asha Kumar'), `${name}: the customer name still prints`);
      assertOrThrow(!text.includes('6045550100'), `${name}: no phone number`);
      assertOrThrow(!text.includes('West Broadway'), `${name}: no delivery address`);
      assertOrThrow(!text.includes(NOTE), `${name}: no delivery note`);
    });
  },

  'Case 2: setting on, a delivery ticket prints phone, address and delivery note': () => {
    forEveryPath((name, render) => {
      const text = flat(render(deliveryOrder, true));
      const [nameAt, phoneAt, addressAt, noteAt, itemAt] = [
        'Asha Kumar',
        PHONE_LINE,
        ADDRESS_LINE,
        NOTE_LINE,
        '1x',
      ].map((needle) => text.indexOf(needle));
      assertOrThrow(phoneAt > nameAt, `${name}: the phone follows the customer name`);
      assertOrThrow(addressAt > phoneAt, `${name}: the whole address follows the phone`);
      assertOrThrow(noteAt > addressAt, `${name}: the delivery note follows the address`);
      assertOrThrow(itemAt > noteAt, `${name}: all three are in the header, above the items`);
    });
    for (const columns of COLUMNS) {
      const printed = paths['server ESC/POS'](deliveryOrder, true, columns).split('\n');
      assertOrThrow(
        printed.every((row) => row.length <= columns),
        `server ESC/POS ${columns}: the address wraps inside the width`,
      );
      assertEqualOrThrow(
        paths['browser ESC/POS'](deliveryOrder, true, columns)
          .split('\n')
          .filter((row) => row.length > columns).length,
        0,
        `browser ESC/POS ${columns}: the address wraps inside the width`,
      );
    }
  },

  'Case 2b: contact text that spells a printer control token prints as text': () => {
    const order = {
      ...deliveryOrder,
      delivery_address: `${'x'.repeat(24)} {CUT}`,
      delivery_note: '{BOLD} ring twice',
    };
    for (const name of ['server ESC/POS', 'raster document']) {
      const text = flat(paths[name](order, true, 42));
      assertOrThrow(text.includes('{ CUT }'), `${name}: the cut token is printed, not obeyed`);
      assertOrThrow(text.includes('{ BOLD } ring twice'), `${name}: the note prints whole`);
      assertOrThrow(text.indexOf('1x') > text.indexOf('ring twice'), `${name}: items follow`);
    }
  },

  'Case 2c: an address stored on two lines prints with a space between them': () => {
    const order = { ...deliveryOrder, delivery_address: '12 Main St\nApt 4' };
    forEveryPath((name, render) => {
      assertOrThrow(
        flat(render(order, true)).includes('Delivery address: 12 Main St Apt 4'),
        `${name}: the two lines are separated`,
      );
    });
  },

  'Case 2d: control bytes in a note, an address or a detail line never reach the printer': () => {
    const withText = (note: string, address: string, detail: string) => ({
      ...deliveryOrder,
      delivery_note: note,
      delivery_address: address,
      items: [{ ...items[0], detailLines: [detail] }],
    });
    const hostile = withText('a\x1B@b\x1DV\x00', '12 Main\x1Bi St', 'No \x1Bolives\x1DV\x00');
    const clean = withText('a@bV', '12 Maini St', 'No olivesV');
    const countOf = (bytes: Uint8Array | Buffer) =>
      [0x00, 0x1b, 0x1d].map((byte) => bytes.filter((b: number) => b === byte).length).join('/');
    const bytePaths: Record<string, (order: any) => Uint8Array | Buffer> = {
      'server ESC/POS': (order) =>
        renderKotViaDocument(
          { ...order, show_customer_contact: true },
          order.items,
          'Kitchen',
          kotOptions(42),
        ).data,
      'browser ESC/POS': (order) =>
        frontend.kotEncoder.buildKotBytes(
          order,
          {
            columns: 42,
            paperWidth: 80,
            stationName: 'Kitchen',
            language: 'en',
            timezone: 'UTC',
            showCustomerContact: true,
          } as any,
          [],
        ),
      'raster document': (order) =>
        buildEscPos(
          renderKotDocumentToLines(
            frontend.printDocument.buildFrontendKotDocument(order, {
              stationName: 'Kitchen',
              columns: 42,
              language: 'en',
              timezone: 'UTC',
              showCustomerContact: true,
            } as any),
            kotOptions(42),
          ),
          false,
          { cutMode: 'partial', columns: 42, language: 'en' },
        ),
    };
    for (const [name, render] of Object.entries(bytePaths)) {
      assertEqualOrThrow(
        countOf(render(hostile)),
        countOf(render(clean)),
        `${name}: NUL/ESC/GS bytes are only the encoder's own commands`,
      );
    }
    const html = frontend.kotWebPrint.generateKotHtml(hostile, {
      paperWidth: 80,
      language: 'en',
      stationName: 'Kitchen',
      timezone: 'UTC',
      showCustomerContact: true,
    } as any);
    assertOrThrow(!/[\x00-\x08\x0B-\x1F\x7F]/.test(html), 'browser HTML: no control bytes');
    forEveryPath((name, render) => {
      const text = flat(render(hostile, true));
      assertOrThrow(text.includes('Delivery note: a@bV'), `${name}: the note text still prints`);
      assertOrThrow(text.includes('No olivesV'), `${name}: the detail line text still prints`);
    });
  },

  'Case 3: setting on, a pickup ticket with a phone prints the phone only': () => {
    forEveryPath((name, render) => {
      const text = flat(render(pickupOrder, true));
      assertOrThrow(text.includes(PHONE_LINE), `${name}: the phone prints`);
      assertOrThrow(!text.includes('Delivery address'), `${name}: no delivery address`);
      assertOrThrow(!text.includes('Delivery note'), `${name}: no delivery note`);
    });
  },

  'Case 4: setting on, an order with no customer adds nothing': () => {
    forEveryPath((name, render) => {
      const on = render(anonymousOrder, true);
      assertEqualOrThrow(on, render(anonymousOrder, false), `${name}: same ticket as setting off`);
      for (const label of ['Customer No', 'Delivery address', 'Delivery note']) {
        assertOrThrow(!on.includes(label), `${name}: no empty "${label}" line`);
      }
    });
  },

  'Case 4b: set to delivery, a pickup ticket carries the name only': () => {
    forEveryPath((name, render) => {
      const pickup = flat(render(pickupOrder, 'delivery'));
      assertOrThrow(pickup.includes('Asha Kumar'), `${name}: the customer name prints`);
      assertOrThrow(!pickup.includes('6045550100'), `${name}: no phone on a pickup ticket`);
      assertEqualOrThrow(
        render(pickupOrder, 'delivery'),
        render(pickupOrder, false),
        `${name}: a pickup ticket is the same as with the setting off`,
      );
      assertEqualOrThrow(
        render(deliveryOrder, 'delivery'),
        render(deliveryOrder, true),
        `${name}: a delivery ticket is the same as with the setting on`,
      );
    });
  },

  'Case 4c: a scheduled order prints PICKUP or DELIVERY and its time in the header': () => {
    const at = { scheduled_for: '2026-01-01T18:30:00.000Z' };
    forEveryPath((name, render) => {
      const pickup = flat(render({ ...pickupOrder, ...at }, false));
      assertOrThrow(
        pickup.indexOf('PICKUP 6:30 PM') > pickup.indexOf('Asha Kumar'),
        `${name}: the pickup time follows the customer name`,
      );
      assertOrThrow(
        pickup.indexOf('1x') > pickup.indexOf('PICKUP 6:30 PM'),
        `${name}: the pickup time is in the header, above the items`,
      );
      assertOrThrow(!pickup.includes('DELIVERY 6'), `${name}: a pickup is not called a delivery`);
      const delivery = flat(render({ ...deliveryOrder, ...at }, true));
      assertOrThrow(
        delivery.indexOf('DELIVERY 6:30 PM') > delivery.indexOf(NOTE_LINE),
        `${name}: the delivery time follows the contact lines`,
      );
      assertOrThrow(!delivery.includes('PICKUP'), `${name}: a delivery is not called a pickup`);
      for (const [label, order] of [
        ['an order that is not scheduled', pickupOrder],
        ['a scheduled dine-in order', { ...pickupOrder, ...at, type: 'dine_in' }],
        ['an unreadable time', { ...pickupOrder, scheduled_for: 'soon' }],
      ] as const) {
        const text = render(order, false);
        assertOrThrow(!/PICKUP|DELIVERY \d/.test(text), `${name}: ${label} prints no such line`);
        assertEqualOrThrow(
          text,
          render({ ...order, scheduled_for: null }, false),
          `${name}: ${label} prints the ticket it always did`,
        );
      }
    });
  },

  'Case 4d: the pickup time is in the shop time zone and its clock format': () => {
    const order = { ...pickupOrder, scheduled_for: '2026-01-02T02:05:00.000Z' };
    const server = (timezone: string, locale: string) =>
      flat(
        rows(
          renderKotViaDocument(order, order.items, 'Kitchen', {
            ...kotOptions(42),
            timezone,
            locale,
          }).data,
        ).join('\n'),
      );
    assertOrThrow(
      server('America/Vancouver', 'en-CA').includes('PICKUP 6:05 p.m.'),
      'server ESC/POS: Vancouver time, as Canada writes it',
    );
    assertOrThrow(
      /PICKUP 3:05(?! ?[AaPp])/.test(server('Europe/Berlin', 'de-DE')),
      'server ESC/POS: a 24-hour country prints a 24-hour time',
    );
    const browser = flat(
      rows(
        frontend.kotEncoder.buildKotBytes(
          order,
          {
            columns: 42,
            paperWidth: 80,
            stationName: 'Kitchen',
            language: 'en',
            timezone: 'America/Vancouver',
          } as any,
          [],
        ),
      ).join('\n'),
    );
    assertOrThrow(/PICKUP 6:05 PM/i.test(browser), 'browser ESC/POS: Vancouver time');
    assertOrThrow(
      flat(
        rows(
          renderKotViaDocument(
            { ...order, scheduled_for: '2026-01-02 02:05:00' },
            order.items,
            'Kitchen',
            { ...kotOptions(42), timezone: 'America/Vancouver', locale: 'en-CA' },
          ).data,
        ).join('\n'),
      ).includes('PICKUP 6:05 p.m.'),
      'an instant stored without its zone is read as UTC',
    );
  },

  'Case 5: the stored setting reaches the server and the browser print paths': async () => {
    const db = initTestDb();
    const owner = seedOwnerUser(db);
    seedCustomer(db, customer.id, customer.name, customer.phone);
    const { baseUrl, server } = await startServer(createApp({ '/api/settings': settingsRoutes }));
    const capture = await startCapturePrinter();
    const { usePrinterStore } = frontend.usePrinter;
    const { printerService } = frontend.printerService;
    const originalGet = frontend.api.get;
    const originalPrintViaBrowser = printerService.printViaBrowser;
    const originalPrint = printerService.print;
    // The server route attaches only the customer's name; the ticket code loads the rest.
    const routeOrder = { ...deliveryOrder, customer: { name: customer.name } };
    try {
      const before = await api(baseUrl, '/api/settings/business', { headers: owner.authHeader });
      assertEqualOrThrow(before.data[SETTING], false, 'the setting is off by default');
      await printKOTDetailed(routeOrder, items, 'Kitchen', false, capture.printer);
      const offJob = flat(await capture.lastJob());
      assertOrThrow(offJob.includes('Asha Kumar'), 'server, setting off: the ticket prints');
      assertOrThrow(!offJob.includes('6045550100'), 'server, setting off: no phone number');
      assertOrThrow(!offJob.includes('West Broadway'), 'server, setting off: no address');

      const saved = await api(baseUrl, `/api/settings/${SETTING}`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: { value: 'true' },
      });
      assertEqualOrThrow(saved.status, 200, 'the settings route accepts the key');
      const business = await api(baseUrl, '/api/settings/business', { headers: owner.authHeader });
      assertEqualOrThrow(business.data[SETTING], true, 'the business settings report it on');
      assertEqualOrThrow(
        frontend.posSettings.usePosSettingsStore.getState().kotShowCustomerContact,
        false,
        'the browser store starts with it off',
      );

      await printKOTDetailed(routeOrder, items, 'Kitchen', false, capture.printer);
      const onJob = flat(await capture.lastJob());
      for (const line of [PHONE_LINE, ADDRESS_LINE, NOTE_LINE]) {
        assertOrThrow(onJob.includes(line), `server, setting on: prints "${line}"`);
      }

      // Stored as `delivery`, the server keeps the phone off a pickup ticket.
      await api(baseUrl, `/api/settings/${SETTING}`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: { value: 'delivery' },
      });
      const deliveryOnly = await api(baseUrl, '/api/settings/business', {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(deliveryOnly.data[SETTING], 'delivery', 'the route reports `delivery`');
      const routePickup = { ...pickupOrder, customer: { name: customer.name } };
      await printKOTDetailed(routePickup, items, 'Kitchen', false, capture.printer);
      const pickupJob = flat(await capture.lastJob());
      assertOrThrow(pickupJob.includes('Asha Kumar'), 'server, delivery only: pickup has the name');
      assertOrThrow(
        !pickupJob.includes('6045550100'),
        'server, delivery only: pickup has no phone',
      );
      await printKOTDetailed(routeOrder, items, 'Kitchen', false, capture.printer);
      assertOrThrow(
        flat(await capture.lastJob()).includes(PHONE_LINE),
        'server, delivery only: a delivery ticket has the phone',
      );
      frontend.posSettings.usePosSettingsStore.getState().hydrateReceiptSettings(deliveryOnly.data);
      assertEqualOrThrow(
        frontend.posSettings.usePosSettingsStore.getState().kotShowCustomerContact,
        'delivery',
        'the browser store keeps `delivery`',
      );
      frontend.posSettings.usePosSettingsStore.setState({ kotShowCustomerContact: false });

      // The browser reads the same settings response, then prints through the hook.
      frontend.api.get = async (url: string) =>
        url === '/settings/business' ? { data: business.data } : originalGet(url);
      let html = '';
      printerService.printViaBrowser = async (content: string) => {
        html = content;
      };
      frontend.auth.useAuthStore.setState({
        currentTenant: { id: 1, role: 'owner', country: 'US', timezone: 'UTC' } as any,
      });
      usePrinterStore.setState({ hardwarePrinter: null, printMethod: 'browser' });
      await usePrinterStore.getState().printKot(deliveryOrder);
      const browserJob = flat(html.replace(/<[^>]+>/g, '\n'));
      for (const line of [PHONE_LINE, ADDRESS_LINE, NOTE_LINE]) {
        assertOrThrow(browserJob.includes(line), `browser hook, setting on: prints "${line}"`);
      }

      // The same hook with a WebUSB printer connected sends ESC/POS bytes instead.
      let bytes = new Uint8Array();
      Object.defineProperty(printerService, 'isConnected', { get: () => true, configurable: true });
      printerService.print = async (data: Uint8Array) => {
        bytes = data;
      };
      (globalThis as any).window = {};
      usePrinterStore.setState({ printMethod: 'escpos' });
      await usePrinterStore.getState().printKot(deliveryOrder);
      const webusbJob = flat(rows(bytes).join('\n'));
      for (const line of [PHONE_LINE, ADDRESS_LINE, NOTE_LINE]) {
        assertOrThrow(webusbJob.includes(line), `WebUSB hook, setting on: prints "${line}"`);
      }
    } finally {
      frontend.api.get = originalGet;
      printerService.printViaBrowser = originalPrintViaBrowser;
      printerService.print = originalPrint;
      delete (printerService as any).isConnected;
      delete (globalThis as any).window;
      await capture.close();
      await new Promise((resolve) => server.close(resolve));
      frontend.auth.useAuthStore.setState({ currentTenant: null });
    }
  },
});
