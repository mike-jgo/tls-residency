'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Both modules read their configuration once at load, so pin it first: a real
// database in a temp directory, and the same 10-hour limit the assertions use.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-test-'));
const DB_PATH = path.join(tmp, 'attendance.db');
process.env.DB_PATH = DB_PATH;
process.env.MAX_SESSION_HOURS = '10';

const store = require('../db');
const hours = require('../lib/hours');
const { createScanner, REPEAT_IGNORE_MS, UNKNOWN_KEEP } = require('../lib/scan');

const SECOND = 1000;
const HOUR = 3_600_000;

// Two clocks the tests drive, because on a Pi with no RTC they disagree.
//
//   advance()   real time passes: both clocks move together.
//   jumpClock() NTP corrects the wall clock; no real time passes.
//
// Keeping them separate is what makes a clock correction testable at all — it
// is precisely the case where the difference of two wall-clock readings stops
// meaning "how long it took".
let clock = Date.UTC(2026, 0, 5, 1, 0, 0); // 2026-01-05 09:00 Manila
let elapsed = 0;
const now = () => clock;
const mono = () => elapsed;
const advance = (ms) => { clock += ms; elapsed += ms; };
const jumpClock = (ms) => { clock += ms; };

const scanner = createScanner({ store, now, mono });

// Every test gets its own card, so the per-card repeat window and the shared
// database cannot leak between them.
let cardCounter = 0;
function register(name) {
  const rfid = String(1000000000 + ++cardCounter);
  store.createUser(name, 'S' + cardCounter, 'staffer', rfid);
  return rfid;
}

// Taps are always at least the repeat window apart unless a test says otherwise.
function tap(rfid) {
  advance(REPEAT_IGNORE_MS);
  return scanner.handle(rfid);
}

test.after(() => {
  // Windows may still hold the database file open; the temp dir is disposable.
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignored */ }
});

// ---- Toggling ------------------------------------------------------------

test('the first tap checks a person in', () => {
  const card = register('Ana');
  const result = tap(card);
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.direction, 'in');
  assert.strictEqual(result.name, 'Ana');
  assert.strictEqual(result.stale, false);
});

test('the next tap checks them out', () => {
  const card = register('Ben');
  tap(card);
  assert.strictEqual(tap(card).direction, 'out');
});

test('taps keep alternating', () => {
  const card = register('Cara');
  const directions = [];
  for (let i = 0; i < 6; i++) {
    advance(HOUR);
    directions.push(scanner.handle(card).direction);
  }
  assert.deepStrictEqual(directions, ['in', 'out', 'in', 'out', 'in', 'out']);
});

test('the toggle follows the database, so a restart cannot desync it', () => {
  const card = register('Dita');
  tap(card); // in
  // A fresh scanner is what a restarted server has: no memory of any tap.
  const restarted = createScanner({ store, now, mono });
  advance(HOUR);
  assert.strictEqual(restarted.handle(card).direction, 'out');
});

test('each person toggles independently', () => {
  const one = register('Eli');
  const two = register('Fay');
  tap(one);                                      // Eli in
  tap(two);                                      // Fay in
  assert.strictEqual(tap(one).direction, 'out'); // Eli out, Fay still in
  assert.strictEqual(tap(two).direction, 'out');
});

// ---- Repeat suppression --------------------------------------------------

test('a second tap of the same card within the window is ignored', () => {
  const card = register('Gio');
  assert.strictEqual(tap(card).direction, 'in');
  advance(SECOND);
  const result = scanner.handle(card);
  assert.strictEqual(result.status, 'ignored');
  assert.strictEqual(result.rfid, card);
});

// The reason the window exists: an ignored tap must leave no trace, or the
// person is checked out by their own uncertainty.
test('an ignored tap writes nothing and leaves them checked in', () => {
  const card = register('Hana');
  tap(card);
  const user = store.getUserByRfid(card);
  const before = store.getEventsForUser(user.id).length;

  advance(SECOND);
  scanner.handle(card);
  advance(SECOND);
  scanner.handle(card);

  assert.strictEqual(store.getEventsForUser(user.id).length, before);
  assert.strictEqual(store.getLastEvent(user.id).type, 'in');
});

test('a tap after the window is honoured', () => {
  const card = register('Ivo');
  tap(card);
  advance(REPEAT_IGNORE_MS);
  assert.strictEqual(scanner.handle(card).direction, 'out');
});

test('the window runs from the tap that was acted on, not the ignored one', () => {
  const card = register('Jun');
  tap(card); // in
  advance(REPEAT_IGNORE_MS - 1);
  assert.strictEqual(scanner.handle(card).status, 'ignored');
  advance(2); // now past the window measured from the accepted tap
  assert.strictEqual(scanner.handle(card).direction, 'out');
});

// The repeat window measures real time, so a clock correction in either
// direction must leave it alone. A backwards jump must not make every tap look
// like a repeat and swallow it; a forwards jump must not stop suppression and
// let a nervous double-tap toggle twice.
test('a backwards clock jump does not start ignoring taps', () => {
  const card = register('Xandra');
  const user = store.getUserByRfid(card);
  tap(card); // in

  jumpClock(-8 * HOUR);
  advance(REPEAT_IGNORE_MS);
  assert.notStrictEqual(scanner.handle(card).status, 'ignored');
  assert.strictEqual(store.getEventsForUser(user.id).length, 2);
});

test('a forwards clock jump does not stop a repeat tap being suppressed', () => {
  const card = register('Yara');
  const user = store.getUserByRfid(card);
  tap(card); // in

  advance(SECOND);      // they tap again a second later, unsure it landed
  jumpClock(4 * HOUR);  // NTP happens to correct the clock in between
  assert.strictEqual(scanner.handle(card).status, 'ignored');
  assert.strictEqual(store.getEventsForUser(user.id).length, 1);
});

test('the window is per card, so two people tapping together both register', () => {
  const one = register('Kit');
  const two = register('Lia');
  advance(REPEAT_IGNORE_MS);
  assert.strictEqual(scanner.handle(one).direction, 'in');
  assert.strictEqual(scanner.handle(two).direction, 'in'); // same instant
});

// ---- Stale check-ins -----------------------------------------------------

test('an arrival after a forgotten check-out checks them IN, not out', () => {
  const card = register('Mika');
  tap(card);          // taps in, then goes home without tapping out
  advance(20 * HOUR); // next morning
  const result = scanner.handle(card);
  assert.strictEqual(result.direction, 'in');
  assert.strictEqual(result.stale, true);
});

test('the sequence recovers: the tap after a stale arrival is a check-out', () => {
  const card = register('Noel');
  tap(card);
  advance(20 * HOUR);
  scanner.handle(card); // stale arrival, checks in
  advance(3 * HOUR);
  const result = scanner.handle(card);
  assert.strictEqual(result.direction, 'out');
  assert.strictEqual(result.stale, false);
});

test('a genuine long day still taps out at exactly the limit', () => {
  const card = register('Ofel');
  tap(card);
  advance(10 * HOUR); // the limit itself is not stale
  const result = scanner.handle(card);
  assert.strictEqual(result.direction, 'out');
  assert.strictEqual(result.stale, false);
});

test('a check-in one millisecond past the limit is stale', () => {
  const card = register('Pia');
  tap(card);
  advance(10 * HOUR + 1);
  assert.strictEqual(scanner.handle(card).stale, true);
});

test('staleness applies only to an open check-in, never to a check-out', () => {
  const card = register('Quin');
  tap(card);
  tap(card);          // out
  advance(30 * HOUR); // long gone, but they are already out
  const result = scanner.handle(card);
  assert.strictEqual(result.direction, 'in');
  assert.strictEqual(result.stale, false); // a normal arrival, nothing abandoned
});

// The Pi has no RTC. If it boots believing it is earlier than the last event,
// the check-in looks like it is in the future — which must not disturb the
// plain toggle.
test('a backwards clock does not make a check-in look stale', () => {
  const card = register('Rex');
  tap(card);
  jumpClock(-30 * HOUR);
  advance(HOUR);
  const result = scanner.handle(card);
  assert.strictEqual(result.direction, 'out');
  assert.strictEqual(result.stale, false);
});

/*
 * The regression this section exists for.
 *
 * A Pi with no RTC boots believing it is whenever it last shut down, and jumps
 * forward when NTP reaches it. A check-in recorded before the correction and a
 * tap recorded after it are hours apart on the wall clock while barely any real
 * time has passed — so measuring the gap with the wall clock reports a stale
 * check-in, records an arrival, and leaves someone who has gone home marked
 * present. That is the inversion rule 2 exists to prevent, arriving by another
 * route, and it would repeat every day the clock was wrong.
 */
test('a forwards clock correction does not turn a departure into an arrival', () => {
  const card = register('Yuki');
  const user = store.getUserByRfid(card);

  tap(card); // the Pi is a day behind; this check-in gets a stale timestamp
  advance(HOUR); // one real hour of work
  jumpClock(24 * HOUR); // the network returns and NTP corrects the clock

  const result = scanner.handle(card);
  assert.strictEqual(result.direction, 'out', 'a departure must stay a departure');
  assert.strictEqual(result.stale, false);
  assert.strictEqual(result.certain, true, 'this process saw the check-in itself');

  assert.deepStrictEqual(store.getEventsForUser(user.id).map((e) => e.type), ['in', 'out']);
  assert.ok(!store.getCurrentlyIn().some((u) => u.id === user.id), 'they went home');
});

test('a forwards correction does not delay a genuinely stale check-in either', () => {
  const card = register('Zane');
  tap(card);
  advance(20 * HOUR); // really did forget to tap out
  jumpClock(-3 * HOUR); // and the clock moved under us as well
  assert.strictEqual(scanner.handle(card).stale, true);
});

/*
 * Across a restart there is no monotonic reading to compare against, so the
 * stored timestamp is the only evidence and the measurement is uncertain — it
 * may have been written while the clock was wrong. lib/scan.js uses it anyway
 * and says so. This pins that decision rather than leaving it to chance: a
 * wrong "stale" costs one session and rights itself, whereas skipping rule 2
 * across restarts would restore the original inverting bug.
 */
test('after a restart the age comes from the stored timestamp, marked uncertain', () => {
  const card = register('Adel');
  tap(card); // recorded by this scanner...
  const restarted = createScanner({ store, now, mono }); // ...but not by this one

  advance(20 * HOUR);
  const result = restarted.handle(card);
  assert.strictEqual(result.direction, 'in');
  assert.strictEqual(result.stale, true);
  assert.strictEqual(result.certain, false, 'no monotonic reading survived the restart');
});

test('a restart does not by itself make a recent check-in look stale', () => {
  const card = register('Bex');
  tap(card);
  const restarted = createScanner({ store, now, mono });

  advance(2 * HOUR);
  const result = restarted.handle(card);
  assert.strictEqual(result.direction, 'out');
  assert.strictEqual(result.certain, false);
});

// End to end: the bug this rule exists for. Before it, the second day's arrival
// was recorded as a check-out, so every tap after it was inverted too.
test('a forgotten check-out costs that session and nothing else', () => {
  const card = register('Sam');
  const user = store.getUserByRfid(card);

  tap(card); // Monday: in, then forgets to tap out
  advance(20 * HOUR);
  scanner.handle(card); // Tuesday: arrives
  advance(4 * HOUR);
  scanner.handle(card); // Tuesday: leaves

  const sessions = hours.buildSessions(store.getEventsForUser(user.id));
  assert.deepStrictEqual(sessions.map((s) => s.invalid), [true, false]);
  assert.strictEqual(hours.msToHours(hours.sumMs(sessions)), 4);
  assert.strictEqual(store.getLastEvent(user.id).type, 'out');
});

// ---- Unknown cards -------------------------------------------------------

test('an unknown card records nothing and is offered for registration', () => {
  advance(REPEAT_IGNORE_MS);
  const result = scanner.handle('9999999001');
  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.rfid, '9999999001');
  assert.strictEqual(scanner.unknownScans[0].rfid, '9999999001');
});

test('unknown cards are listed newest first, without duplicates', () => {
  advance(REPEAT_IGNORE_MS);
  scanner.handle('9999999002');
  advance(REPEAT_IGNORE_MS);
  scanner.handle('9999999003');
  advance(REPEAT_IGNORE_MS);
  scanner.handle('9999999002'); // tapped again: moves up, does not duplicate

  const listed = scanner.unknownScans.map((u) => u.rfid);
  assert.deepStrictEqual(listed.slice(0, 2), ['9999999002', '9999999003']);
  assert.strictEqual(listed.filter((r) => r === '9999999002').length, 1);
});

test('the unknown list stays bounded', () => {
  for (let i = 0; i < UNKNOWN_KEEP + 5; i++) {
    advance(REPEAT_IGNORE_MS);
    scanner.handle('888800' + String(i).padStart(4, '0'));
  }
  assert.strictEqual(scanner.unknownScans.length, UNKNOWN_KEEP);
});

test('registering a card drops it from the unknown list', () => {
  advance(REPEAT_IGNORE_MS);
  scanner.handle('9999999004');
  assert.ok(scanner.unknownScans.some((u) => u.rfid === '9999999004'));
  scanner.forgetUnknown('9999999004');
  assert.ok(!scanner.unknownScans.some((u) => u.rfid === '9999999004'));
});

// ---- Database persistence ------------------------------------------------

test('events are written to the file, not just held in memory', () => {
  const card = register('Tala');
  tap(card);
  tap(card);

  // A separate process opening the same file is the real test: it shares no
  // memory with this one, so anything it sees was genuinely committed.
  const script = [
    'process.env.DB_PATH=' + JSON.stringify(DB_PATH),
    'const s=require(' + JSON.stringify(path.join(__dirname, '..', 'db.js')) + ')',
    'const u=s.getUserByRfid(' + JSON.stringify(card) + ')',
    'console.log(JSON.stringify({name:u.name,types:s.getEventsForUser(u.id).map(e=>e.type)}))',
  ].join(';');

  const seen = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  assert.strictEqual(seen.name, 'Tala');
  assert.deepStrictEqual(seen.types, ['in', 'out']);
});

// This is what lets the toggle survive a clock that jumps: db.js orders events
// by insertion id, never by timestamp. Written out of order on purpose.
test('the last event is the last one inserted, even if its timestamp is older', () => {
  const card = register('Uma');
  const user = store.getUserByRfid(card);

  store.insertEvent(user.id, 'in', new Date(clock).toISOString());
  // The Pi rebooted with no network and came up six hours in the past.
  store.insertEvent(user.id, 'out', new Date(clock - 6 * HOUR).toISOString());

  assert.strictEqual(store.getLastEvent(user.id).type, 'out');
  assert.deepStrictEqual(store.getEventsForUser(user.id).map((e) => e.type), ['in', 'out']);
});

test('a stale-dated arrival still shows the person as currently in', () => {
  const card = register('Vito');
  const user = store.getUserByRfid(card);
  store.insertEvent(user.id, 'out', new Date(clock).toISOString());
  store.insertEvent(user.id, 'in', new Date(clock - 6 * HOUR).toISOString());

  const inNow = store.getCurrentlyIn().map((u) => u.id);
  assert.ok(inNow.includes(user.id), 'expected the last-inserted "in" to count');
});

test('removing a person takes their events with them', () => {
  const card = register('Wren');
  const user = store.getUserByRfid(card);
  tap(card);
  assert.strictEqual(store.getEventsForUser(user.id).length, 1);

  store.deleteUser(user.id);
  assert.strictEqual(store.getUserByRfid(card), undefined);
  assert.strictEqual(store.getEventsForUser(user.id).length, 0);
});
