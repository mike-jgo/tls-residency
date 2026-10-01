'use strict';

/*
 * Facts about the machine this is running on that the tap rules depend on.
 *
 * The office computer is switched on each morning and shut down and unplugged
 * each night. Two consequences follow, and this module answers both:
 *
 *   - Which boot is this? Nobody can tap in or out while the machine is off,
 *     so no session can span a shutdown. A check-in left open from an earlier
 *     boot was abandoned — its owner went home without tapping out. Linux gives
 *     every boot a random id; we store it with each event so lib/scan.js can
 *     tell "checked in this morning" from "checked in yesterday" without asking
 *     the clock, which is exactly the thing that's wrong first thing in the day.
 *
 *   - Is the clock right yet? A Pi has no battery-backed clock. It boots
 *     believing it is whenever it last shut down — last night — and only learns
 *     the real time from the internet over wifi. Until then every timestamp we
 *     write is wrong, so taps are refused rather than recorded wrong.
 */

const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

// How often to ask whether the clock has synced. Only until it has — after
// that the answer can't change for the rest of the day.
const CLOCK_POLL_MS = 2000;

// Off Linux (a Mac used for development) there is no boot id to read, so each
// run of the server counts as a boot of its own. Close enough for development.
function readBootId(file = BOOT_ID_PATH) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return 'process-' + crypto.randomUUID();
  }
}

const BOOT_ID = readBootId();

// Ask systemd whether the kernel clock has been synchronised from the network.
// Covers timesyncd (Raspberry Pi OS's default) and chrony alike.
function ntpSynchronized(callback) {
  execFile('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5000 },
    (err, stdout) => callback(err, !err && String(stdout).trim() === 'yes'));
}

/*
 * Poll until the clock has synced, then stop. onChange fires once, when it does.
 *
 * Off Linux the clock is the laptop's own and always right, so it starts ready.
 * If timedatectl itself can't be run we can't tell either way; refusing every
 * tap forever would be worse than trusting the clock, so we say so in the log
 * and trust it.
 */
function watchClock({ onChange = () => {}, log = () => {}, check = ntpSynchronized,
  platform = process.platform, intervalMs = CLOCK_POLL_MS } = {}) {
  let ready = platform !== 'linux';
  let timer = null;

  function poll() {
    check((err, synced) => {
      if (err && err.code === 'ENOENT') {
        log('timedatectl not found — cannot check the clock, trusting it as it is');
        synced = true;
      }
      if (synced) {
        ready = true;
        log('clock is set — taps are being recorded');
        onChange(true);
      } else {
        timer = setTimeout(poll, intervalMs);
      }
    });
  }

  if (!ready) {
    log('waiting for the clock to be set over the network — taps are refused until then');
    poll();
  }

  return {
    isReady: () => ready,
    stop: () => clearTimeout(timer),
  };
}

module.exports = { BOOT_ID, readBootId, watchClock };
