'use strict';

const test = require('node:test');
const assert = require('node:assert');

// hours.js reads the limit once at load, so pin it before requiring: the tests
// below assert against a 10-hour limit and must not depend on the dev's .env.
process.env.MAX_SESSION_HOURS = '10';
const hours = require('../lib/hours');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Events as the database hands them over: insertion order, ISO timestamps.
const base = Date.UTC(2026, 0, 5, 1, 0, 0); // 2026-01-05 09:00 Manila
const at = (ms) => new Date(base + ms).toISOString();
const ev = (type, ms) => ({ type, ts: at(ms) });

test('pairs each check-in with the following check-out', () => {
  const sessions = hours.buildSessions([ev('in', 0), ev('out', 2 * HOUR)]);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].ms, 2 * HOUR);
  assert.strictEqual(sessions[0].open, false);
  assert.strictEqual(sessions[0].invalid, false);
});

test('totals several sessions across a day', () => {
  const sessions = hours.buildSessions([
    ev('in', 0), ev('out', 3 * HOUR),
    ev('in', 5 * HOUR), ev('out', 6.5 * HOUR),
  ]);
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(hours.msToHours(hours.sumMs(sessions)), 4.5);
});

test('an open session counts as zero until they tap out', () => {
  const sessions = hours.buildSessions([ev('in', 0), ev('out', HOUR), ev('in', 4 * HOUR)]);
  const open = sessions.filter((s) => s.open);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].outAt, null);
  assert.strictEqual(hours.sumMs(sessions), HOUR);
});

// The point of the limit: forgetting to tap out costs you the session. It
// must not be worth the limit either — that would reward the mistake.
test('a session past the limit is discarded, not capped', () => {
  const sessions = hours.buildSessions([ev('in', 0), ev('out', 3 * DAY)]);
  assert.strictEqual(sessions[0].invalid, true);
  assert.strictEqual(sessions[0].ms, 0);
  assert.strictEqual(hours.sumMs(sessions), 0);
});

test('a session exactly at the limit still counts in full', () => {
  const sessions = hours.buildSessions([ev('in', 0), ev('out', 10 * HOUR)]);
  assert.strictEqual(sessions[0].invalid, false);
  assert.strictEqual(hours.msToHours(sessions[0].ms), 10);
});

test('a session just past the limit is worth nothing', () => {
  const sessions = hours.buildSessions([ev('in', 0), ev('out', 10 * HOUR + 1)]);
  assert.strictEqual(sessions[0].invalid, true);
  assert.strictEqual(sessions[0].ms, 0);
});

test('one discarded session does not affect the others', () => {
  const sessions = hours.buildSessions([
    ev('in', 0), ev('out', 2 * HOUR),          // valid
    ev('in', DAY), ev('out', DAY + 3 * DAY),   // forgotten, discarded
    ev('in', 8 * DAY), ev('out', 8 * DAY + HOUR), // valid
  ]);
  assert.strictEqual(hours.msToHours(hours.sumMs(sessions)), 3);
  assert.strictEqual(sessions.filter((s) => s.invalid).length, 1);
});

// This is the shape a forgotten check-out leaves behind once lib/scan.js
// treats the next day's arrival as an arrival: two check-ins in a row.
test('an abandoned check-in is flagged and worth nothing', () => {
  const sessions = hours.buildSessions([ev('in', 0), ev('in', 2 * HOUR), ev('out', 3 * HOUR)]);
  assert.strictEqual(sessions.length, 2);
  assert.deepStrictEqual(
    { open: sessions[0].open, invalid: sessions[0].invalid, ms: sessions[0].ms },
    { open: true, invalid: true, ms: 0 }
  );
  assert.strictEqual(sessions[1].ms, HOUR);
  assert.strictEqual(hours.msToHours(hours.sumMs(sessions)), 1);
});

// "Still in" is drawn from open && !invalid, so the two open sessions have to
// be distinguishable — otherwise someone who went home last week shows as
// present forever.
test('the live check-in is open but not flagged, unlike an abandoned one', () => {
  const sessions = hours.buildSessions([ev('in', 0), ev('in', 2 * DAY)]);
  assert.deepStrictEqual(sessions.map((s) => [s.open, s.invalid]), [[true, true], [true, false]]);
});

test('a check-out with no matching check-in is ignored', () => {
  const sessions = hours.buildSessions([ev('out', 0), ev('in', HOUR), ev('out', 2 * HOUR)]);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].ms, HOUR);
});

test('no events means no sessions', () => {
  assert.deepStrictEqual(hours.buildSessions([]), []);
  assert.strictEqual(hours.sumMs([]), 0);
});

// A backward clock jump on a Pi with no RTC can date a check-out before its
// check-in. Clamp to zero rather than subtracting from the person's total.
test('a negative span from a clock jump counts as zero, never negative', () => {
  const sessions = hours.buildSessions([ev('in', 2 * HOUR), ev('out', 0)]);
  assert.strictEqual(sessions[0].ms, 0);
});

test('filterByRange keeps sessions by check-in, start inclusive and end exclusive', () => {
  const sessions = hours.buildSessions([
    ev('in', 0), ev('out', HOUR),
    ev('in', DAY), ev('out', DAY + HOUR),
    ev('in', 2 * DAY), ev('out', 2 * DAY + HOUR),
  ]);
  const kept = hours.filterByRange(sessions, at(DAY), at(2 * DAY));
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].inAt, at(DAY));
});

test('filterByRange treats a null bound as open-ended', () => {
  const sessions = hours.buildSessions([
    ev('in', 0), ev('out', HOUR),
    ev('in', DAY), ev('out', DAY + HOUR),
  ]);
  assert.strictEqual(hours.filterByRange(sessions, null, null).length, 2);
  assert.strictEqual(hours.filterByRange(sessions, at(DAY), null).length, 1);
  assert.strictEqual(hours.filterByRange(sessions, null, at(DAY)).length, 1);
});

test('msToHours rounds to two decimals for the report', () => {
  assert.strictEqual(hours.msToHours(HOUR), 1);
  assert.strictEqual(hours.msToHours(90 * 60 * 1000), 1.5);
  assert.strictEqual(hours.msToHours(HOUR / 3), 0.33);
});

test('the limit the scanner uses is the same one the totals use', () => {
  assert.strictEqual(hours.MAX_SESSION_MS, hours.MAX_SESSION_HOURS * HOUR);
  assert.strictEqual(hours.MAX_SESSION_HOURS, 10);
});
