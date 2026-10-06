'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { searchTab } = require('../lib/search');

const build = (changes = {}) => searchTab({
  hoursTabs: ['November 2026', 'October 2026'],
  logsTabs: ['November 2026 Logs', 'October 2026 Logs'],
  totalsTab: 'Totals',
  staffersTab: 'Staffers',
  hoursHeader: ['Name', 'Student ID', 'Hours', 'Sessions', 'Still in', 'Uncounted sessions', 'Deactivated'],
  tapsHeader: ['Tap #', 'Date', 'Time', 'Name', 'Student ID', 'Direction'],
  staffersHeader: ['Name', 'ID number', 'Section', 'Status', 'Telegram', 'Deactivated', 'Card number'],
  ...changes,
});
const cell = (ranges, at) => ranges.find((r) => r.range === `'Search'!${at}`).values[0];

// Brackets and quotes balance: the cheapest check that Sheets will parse it.
function balanced(formula) {
  let depth = 0;
  let inText = false;
  for (const ch of formula) {
    if (ch === '"') inText = !inText;
    else if (!inText && '({'.includes(ch)) depth++;
    else if (!inText && ')}'.includes(ch)) depth--;
    assert.ok(depth >= 0, formula);
  }
  return depth === 0 && !inText;
}

test('the hours formula stacks all-time and every month, each row labelled', () => {
  const [hours] = cell(build(), 'A5:A5');
  assert.ok(balanced(hours), hours);
  assert.ok(hours.includes('IF(LEN(\'Totals\'!A4:A),"All time",""),\'Totals\'!A4:G;'));
  assert.ok(hours.includes('IF(LEN(\'November 2026\'!A2:A),"November 2026",""),\'November 2026\'!A2:G;'));
  // With the month in front, the name is column 2 and the ID number column 3.
  assert.ok(hours.includes('ISNUMBER(SEARCH(q,INDEX(all,,2)))+(INDEX(all,,3)&""=q&"")'));
});

test('the taps formula stacks every log tab, newest first', () => {
  const [taps] = cell(build(), 'Q5:Q5');
  assert.ok(balanced(taps), taps);
  assert.ok(taps.includes("{'November 2026 Logs'!A2:F;'October 2026 Logs'!A2:F}"));
  assert.ok(taps.includes('SORT(FILTER(all,ISNUMBER(SEARCH(q,INDEX(all,,4)))+(INDEX(all,,5)&""=q&"")),1,FALSE)'));
  assert.deepStrictEqual(cell(build({ logsTabs: [] }), 'Q5:Q5'), ['No taps yet']);
});

test('details come from the Staffers tab, without the card', () => {
  const ranges = build();
  assert.ok(cell(ranges, 'J5:J5')[0].includes("{'Staffers'!A2:F}"));
  assert.deepStrictEqual(cell(ranges, 'J4:O4'), ['Name', 'ID number', 'Section', 'Status', 'Telegram', 'Deactivated']);
});

test('the search box is never written, and no formula holds what was typed', () => {
  const ranges = build();
  assert.ok(!ranges.some((r) => /![B-D]1/.test(r.range)), 'B1, and the cells merged into it');
  for (const at of ['A5:A5', 'J5:J5', 'Q5:Q5']) assert.ok(cell(ranges, at)[0].includes('q,$B$1'));
});

test('every header sits over a table as wide as it is', () => {
  const width = (range) => {
    const [, a, b] = /!([A-Z])\d+:([A-Z])\d+$/.exec(range);
    return b.charCodeAt(0) - a.charCodeAt(0) + 1;
  };
  for (const r of build()) assert.strictEqual(r.values[0].length, width(r.range), r.range);
  assert.strictEqual(cell(build(), 'A4:H4').length, 8); // Month + the hours columns: A..G of each tab
  assert.strictEqual(cell(build(), 'Q4:V4').length, 6);
});
