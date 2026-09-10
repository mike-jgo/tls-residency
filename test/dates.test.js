'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// dates.js reads TZ once at load. Pin it: the assertions below are absolute
// UTC instants for Asia/Manila (a fixed +08:00), so they fail if the host's
// own timezone ever leaks into the calculation.
process.env.TZ = 'Asia/Manila';
const dates = require('../lib/dates');

test('a single day spans that day 00:00 to the next 00:00, Manila time', () => {
  const { startISO, endISO, error } = dates.dayBounds('2026-01-05', '2026-01-05');
  assert.strictEqual(error, null);
  assert.strictEqual(startISO, '2026-01-04T16:00:00.000Z'); // 05 Jan 00:00 +08:00
  assert.strictEqual(endISO, '2026-01-05T16:00:00.000Z');   // 06 Jan 00:00 +08:00
});

test('the To date is included, not cut off at its midnight', () => {
  const { startISO, endISO } = dates.dayBounds('2026-01-05', '2026-01-07');
  assert.strictEqual(startISO, '2026-01-04T16:00:00.000Z');
  assert.strictEqual(endISO, '2026-01-07T16:00:00.000Z'); // 08 Jan 00:00 +08:00
});

test('the end bound rolls over a month boundary', () => {
  const { endISO } = dates.dayBounds('', '2026-01-31');
  assert.strictEqual(endISO, '2026-01-31T16:00:00.000Z'); // 01 Feb 00:00 +08:00
});

test('the end bound rolls over a year boundary', () => {
  const { endISO } = dates.dayBounds('', '2026-12-31');
  assert.strictEqual(endISO, '2026-12-31T16:00:00.000Z'); // 01 Jan 2027 00:00 +08:00
});

test('a leap day is a real date', () => {
  const { startISO, error } = dates.dayBounds('2028-02-29', '');
  assert.strictEqual(error, null);
  assert.strictEqual(startISO, '2028-02-28T16:00:00.000Z');
});

test('blank boxes mean an unfiltered report, not an error', () => {
  assert.deepStrictEqual(dates.dayBounds('', ''), { startISO: null, endISO: null, error: null });
});

test('one blank box leaves that bound open', () => {
  const from = dates.dayBounds('2026-01-05', '');
  assert.strictEqual(from.endISO, null);
  assert.notStrictEqual(from.startISO, null);

  const to = dates.dayBounds('', '2026-01-05');
  assert.strictEqual(to.startISO, null);
  assert.notStrictEqual(to.endISO, null);
});

// The bug this replaces: new Date('garbage T00:00:00').toISOString() throws a
// RangeError, so /admin/hours?start=garbage was a 500 page.
test('text that is not a date is reported, not thrown', () => {
  for (const bad of ['garbage', '05/01/2026', '2026-1-5', '2026-01-05T10:00', '20260105', '-1']) {
    const result = dates.dayBounds(bad, '');
    assert.match(result.error, /not a valid date/, `expected ${bad} to be rejected`);
    assert.strictEqual(result.startISO, null);
  }
});

test('a date that does not exist is rejected rather than rolled over', () => {
  // Date.UTC would silently turn these into 01 Mar and 01 Feb.
  assert.match(dates.dayBounds('2026-02-30', '').error, /not a valid date/);
  assert.match(dates.dayBounds('2026-01-32', '').error, /not a valid date/);
  assert.match(dates.dayBounds('2027-02-29', '').error, /not a valid date/); // 2027 is not a leap year
  assert.match(dates.dayBounds('2026-13-01', '').error, /not a valid date/);
  assert.match(dates.dayBounds('2026-00-10', '').error, /not a valid date/);
});

test('a backwards range is reported instead of silently returning nothing', () => {
  const { startISO, endISO, error } = dates.dayBounds('2026-05-02', '2026-05-01');
  assert.match(error, /after the "To" date/);
  assert.strictEqual(startISO, null);
  assert.strictEqual(endISO, null);
});

test('From and To on the same day is a valid one-day range', () => {
  assert.strictEqual(dates.dayBounds('2026-05-01', '2026-05-01').error, null);
});

// When a bound is rejected the caller may not check `error` — it must still
// get usable (unfiltered) bounds rather than something that throws downstream.
test('a rejected range still returns null bounds, never an Invalid Date', () => {
  const { startISO, endISO } = dates.dayBounds('nope', 'also-nope');
  assert.strictEqual(startISO, null);
  assert.strictEqual(endISO, null);
});

// The point of item 2: the range follows the configured TZ, not the host's
// clock. Windows Node only honours UTC as a TZ value, which is enough to show
// the boundary moves with configuration.
test('bounds come from the configured zone, not the host default', () => {
  const script = "const d=require(" + JSON.stringify(path.join(__dirname, '..', 'lib', 'dates.js')) +
    ");console.log(d.TZ,d.dayBounds('2026-01-05','2026-01-05').startISO)";
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8',
  }).trim();
  assert.strictEqual(out, 'UTC 2026-01-05T00:00:00.000Z');
});
