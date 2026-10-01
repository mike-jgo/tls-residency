'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readBootId, watchClock } = require('../lib/machine');

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
