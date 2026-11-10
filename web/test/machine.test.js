'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readBootId, watchClock, readRtc, rtcVerdict, RTC_TOLERANCE_MS } = require('../lib/machine');

test('the boot id is read from the kernel file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'boot-')), 'boot_id');
  fs.writeFileSync(file, 'f3c1e2d4-0000-4000-8000-000000000001\n');
  assert.strictEqual(readBootId(file), 'f3c1e2d4-0000-4000-8000-000000000001');
});

test('without the kernel file each run gets a boot id of its own', () => {
  const a = readBootId('/nonexistent/boot_id');
  const b = readBootId('/nonexistent/boot_id');
  assert.match(a, /^process-/);
  assert.notStrictEqual(a, b);
});

test('off Linux the clock is ready from the start', () => {
  const clock = watchClock({ platform: 'darwin', check: () => assert.fail('should not poll') });
  assert.strictEqual(clock.isReady(), true);
});

test('on Linux taps wait until the clock has synced, then it stays ready', async () => {
  const answers = [false, false, true];
  let changes = 0;
  const clock = watchClock({
    platform: 'linux',
    intervalMs: 1,
    check: (cb) => setImmediate(() => cb(null, answers.shift())),
    rtc: () => ({ present: false }),
    onChange: () => changes++,
  });
  assert.strictEqual(clock.isReady(), false);
  while (!clock.isReady()) await new Promise((r) => setTimeout(r, 2));
  assert.strictEqual(answers.length, 0, 'polled until synced');
  assert.strictEqual(changes, 1);
  clock.stop();
});

// Refusing every tap forever would be worse than trusting an unchecked clock.
test('if timedatectl is missing the clock is trusted rather than blocking all day', () => {
  const err = Object.assign(new Error('spawn timedatectl ENOENT'), { code: 'ENOENT' });
  const logged = [];
  const clock = watchClock({
    platform: 'linux',
    check: (cb) => cb(err, false),
    log: (m) => logged.push(m),
  });
  assert.strictEqual(clock.isReady(), true);
  assert.ok(logged.some((m) => m.includes('timedatectl not found')));
});

// ---- A battery-backed clock (RTC) ----------------------------------------
// Tested against simulated readings. What a real module reports — especially
// with a flat battery — still has to be checked on the hardware.

const NOW = Date.UTC(2026, 9, 5, 1, 0, 0);       // Monday morning
const LAST_TAP = Date.UTC(2026, 9, 2, 10, 0, 0); // Friday evening
const good = { present: true, epochMs: NOW };

test('a hardware clock that agrees with the system clock is believed', () => {
  assert.deepStrictEqual(rtcVerdict({ rtc: good, nowMs: NOW, floorMs: LAST_TAP }), { ok: true, reason: null });
  // Read in whole seconds, so a little apart is still the same time.
  assert.strictEqual(rtcVerdict({ rtc: good, nowMs: NOW + RTC_TOLERANCE_MS, floorMs: LAST_TAP }).ok, true);
});

test('no hardware clock means waiting for the network, as before', () => {
  assert.strictEqual(rtcVerdict({ rtc: { present: false }, nowMs: NOW }).ok, false);
});

test('a hardware clock that cannot be read is not believed', () => {
  const verdict = rtcVerdict({ rtc: { present: true, epochMs: null }, nowMs: NOW });
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /battery/);
});

// A flat battery: the module restarts from its own year zero, and the kernel
// sets the system clock to match — so the two agree, and both are wrong.
test('a hardware clock that restarted from zero is not believed, even though the system agrees with it', () => {
  for (const reset of [0, Date.UTC(2000, 0, 1, 0, 3)]) {
    const verdict = rtcVerdict({ rtc: { present: true, epochMs: reset }, nowMs: reset, floorMs: LAST_TAP });
    assert.strictEqual(verdict.ok, false);
  }
  // Even with an empty database there is a floor: this software's own age.
  assert.strictEqual(rtcVerdict({ rtc: { present: true, epochMs: 0 }, nowMs: 0, floorMs: 0 }).ok, false);
});

// Time doesn't run backwards: a clock earlier than a tap already recorded is
// wrong, however plausible the date looks.
test('a hardware clock behind the last recorded tap is not believed', () => {
  const behind = LAST_TAP - 60_000;
  const verdict = rtcVerdict({ rtc: { present: true, epochMs: behind }, nowMs: behind, floorMs: LAST_TAP });
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /behind the last recorded tap/);
});

// Tap times come from the system clock. If it was set from somewhere else
// (last night's saved time, say), a correct RTC doesn't make it right.
test('a hardware clock the system clock does not match is not believed', () => {
  const verdict = rtcVerdict({ rtc: good, nowMs: NOW - 15 * 3_600_000, floorMs: LAST_TAP });
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /doesn't match/);
});

test('with a good hardware clock taps start without any network', () => {
  const logged = [];
  let changes = 0;
  const clock = watchClock({
    platform: 'linux',
    check: (cb) => cb(null, false), // wifi is down all day
    rtc: () => good,
    now: () => NOW,
    floor: () => LAST_TAP,
    onChange: () => changes++,
    log: (m) => logged.push(m),
  });
  assert.strictEqual(clock.isReady(), true);
  assert.strictEqual(clock.source(), 'rtc');
  assert.strictEqual(changes, 1);
  assert.ok(logged.some((m) => m.includes('from the hardware clock')));
});

test('with a flat hardware clock taps still wait for the network, and the log says why', async () => {
  const answers = [false, false, true];
  const logged = [];
  const clock = watchClock({
    platform: 'linux',
    intervalMs: 1,
    check: (cb) => setImmediate(() => cb(null, answers.shift())),
    rtc: () => ({ present: true, epochMs: Date.UTC(2000, 0, 1) }),
    now: () => Date.UTC(2000, 0, 1),
    floor: () => LAST_TAP,
    log: (m) => logged.push(m),
  });
  assert.strictEqual(clock.isReady(), false);
  while (!clock.isReady()) await new Promise((r) => setTimeout(r, 2));
  clock.stop();
  assert.strictEqual(clock.source(), 'network');
  assert.strictEqual(logged.filter((m) => m.includes('not trusting the hardware clock')).length, 1, 'said once');
});

test('the network setting the clock wins over a hardware clock', () => {
  const clock = watchClock({ platform: 'linux', check: (cb) => cb(null, true), rtc: () => good, now: () => NOW });
  assert.strictEqual(clock.source(), 'network');
});

test('the hardware clock is read from the kernel\'s file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-'));
  fs.writeFileSync(path.join(dir, 'since_epoch'), '1791162000\n');
  assert.deepStrictEqual(readRtc(dir), { present: true, epochMs: 1791162000000 });
});

test('no rtc directory means no hardware clock', () => {
  assert.deepStrictEqual(readRtc(path.join(os.tmpdir(), 'no-such-rtc')), { present: false });
});

test('an rtc whose time cannot be read is present but unreadable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-'));
  fs.mkdirSync(path.join(dir, 'since_epoch')); // reading it fails, as a module refusing to give a time does
  assert.deepStrictEqual(readRtc(dir), { present: true, epochMs: null });
});
