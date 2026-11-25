// Throwaway spike: pizza detail lines print identically on the backend KOT
// renderer and the browser KOT encoder at 42 and 48 columns.
import assert from 'node:assert/strict';
import { renderKotViaDocument } from '../main/printers/document-kot';
import { loadFrontendPrintModules, measureEscPos } from './helpers/receipt-column-measure';

const { kotEncoder } = loadFrontendPrintModules();

const HEADING = 'LARGE (14") - THIN CRUST';
const DETAIL = [
  'HALF: PEPPERONI / HALF: HAWAIIAN',
  'WHOLE: + Extra Cheese, Well Done',
  'LEFT:  + Mushrooms',
  'RIGHT: NO PINEAPPLE, + Jalapenos',
];
const LONG =
  'WHOLE: + Extra Cheese, + Roasted Garlic, + Caramelized Onions, + Sun-Dried Tomatoes, Well Done';

const item = (id: number, detailLines: string[]) => ({
  id,
  order_id: 1,
  product_id: 'p1',
  product_name: HEADING,
  product_sku: null,
  unit_price: 0,
  quantity: 1,
  subtotal: 0,
  tax_amount: 0,
  total: 0,
  addons: [],
  special_instructions: null,
  status: 'pending' as const,
  modifier_selection: { kind: 'pizza', detailLines },
});
const order = {
  id: 1,
  order_number: 'P-1',
  created_at: '2026-01-01T12:00:00.000Z',
  type: 'takeaway',
  items: [item(1, DETAIL), item(2, [LONG])],
};

/** Detail lines of each item: the 3-space-indented lines that follow a heading. */
function detailBlocks(bytes: Buffer | Uint8Array): string[][] {
  const blocks: string[][] = [];
  for (const { text } of measureEscPos(bytes).lines) {
    if (/^1x\s+LARGE/.test(text)) blocks.push([]);
    else if (blocks.length && /^ {3}(?: {2})?\S/.test(text)) blocks.at(-1)!.push(text);
  }
  return blocks;
}

const collapse = (line: string) => line.replace(/\s+/g, ' ');

for (const columns of [42, 48]) {
  const backend = renderKotViaDocument(order, order.items, 'Kitchen', {
    columns,
    language: 'en',
    useUnicode: false,
    arabicShaping: false,
    cutMode: 'partial',
  });
  const frontendBytes = kotEncoder.buildKotBytes(
    order as never,
    { columns, paperWidth: 80, stationName: 'Kitchen' },
    [],
  );

  const backendBlocks = detailBlocks(backend.data);
  const frontendBlocks = detailBlocks(frontendBytes);

  // Both paths print the same detail lines, in order.
  assert.deepEqual(backendBlocks, frontendBlocks, `${columns} cols: paths differ`);
  // The four mock lines survive, modulo the wrap helper collapsing space runs.
  assert.deepEqual(
    backendBlocks[0],
    DETAIL.map((line) => '   ' + collapse(line)),
  );
  // The long line wraps inside the width with a 5-space hanging indent.
  const wrapped = backendBlocks[1];
  assert.ok(wrapped.length > 1, 'long line wraps');
  assert.ok(wrapped.slice(1).every((line) => line.startsWith('     ')));
  assert.equal(collapse(wrapped.map((line) => line.trim()).join(' ')), LONG);
  for (const bytes of [backend.data, frontendBytes]) {
    assert.ok(measureEscPos(bytes).maxFontACells <= columns, 'no line exceeds the width');
  }

  console.log(`\n--- ${columns} columns: backend token lines ---`);
  for (const line of backend.lines.slice(backend.lines.findIndex((l) => l.includes('LARGE')))) {
    console.log(`|${line}`);
  }
  console.log(`--- ${columns} columns: frontend decoded bytes ---`);
  const fe = measureEscPos(frontendBytes).lines.map((l) => l.text);
  for (const line of fe.slice(fe.findIndex((l) => l.includes('LARGE')))) console.log(`|${line}`);
}

console.log(
  '\nspike-pizza-ticket: backend and frontend KOT detail lines match at 42 and 48 columns.',
);
