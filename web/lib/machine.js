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
 *
 *     With a battery-backed clock (an RTC module, or the Pi 5's RTC with its
 *     battery) the Pi does know the time at boot, and taps can start without
 *     wifi — but only if that clock can be believed. See rtcVerdict.
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

// The first hardware clock, where Linux exposes it. The kernel sets the system
// clock from it at boot.
const RTC_DIR = '/sys/class/rtc/rtc0';

// No tap can be older than this software. A clock reading earlier than this
// is a clock that lost power, whatever else is true.
const EARLIEST_MS = Date.UTC(2026, 0, 1);

// How far the system clock and the RTC may differ and still be "the same
// time". The RTC is read in whole seconds.
const RTC_TOLERANCE_MS = 5000;

/*
 * What the hardware clock says. { present: false } when there is none;
 * otherwise { present: true, epochMs }, with epochMs null if it is there but
 * can't be read — which is what a module does when its battery has run out
 * and it knows its time is no longer valid.
 */
function readRtc(dir = RTC_DIR) {
  try {
    const seconds = Number(fs.readFileSync(dir + '/since_epoch', 'utf8').trim());
    return { present: true, epochMs: Number.isFinite(seconds) ? seconds * 1000 : null };
  } catch (e) {
    return e.code === 'ENOENT' ? { present: false } : { present: true, epochMs: null };
  }
}

/*
 * Can the system clock be believed on the strength of the hardware clock
 * alone, with no network? Returns { ok, reason }.
 *
 * Having an RTC is not enough. A dead or missing battery leaves one that
 * restarts from its own year zero each morning, and a Pi 5 has an RTC built
 * in whether or not anyone fitted a battery. So the RTC is believed only if:
 *
 *   - it can be read at all;
 *   - its time is not before `floorMs`, the latest moment we know was real
 *     (the last recorded tap). Time doesn't run backwards, so a clock that
 *     says it is earlier than something that already happened has lost power;
 *   - the system clock agrees with it. Tap times come from the system clock,
 *     so if that was set from somewhere else, the RTC being right is no help.
 *
 * Anything else falls back to waiting for the network, exactly as without one.
 */
function rtcVerdict({ rtc, nowMs, floorMs = 0 }) {
  if (!rtc || !rtc.present) return { ok: false, reason: 'no hardware clock' };
  if (rtc.epochMs === null) {
    return { ok: false, reason: 'the hardware clock can\'t be read — its battery may be flat' };
  }
  if (rtc.epochMs < Math.max(floorMs, EARLIEST_MS)) {
    return { ok: false, reason: 'the hardware clock is behind the last recorded tap — its battery may be flat' };
  }
  if (Math.abs(nowMs - rtc.epochMs) > RTC_TOLERANCE_MS) {
    return { ok: false, reason: 'the system clock doesn\'t match the hardware clock' };
  }
  return { ok: true, reason: null };
}

// Ask systemd whether the kernel clock has been synchronised from the network.
// Covers timesyncd (Raspberry Pi OS's default) and chrony alike.
function ntpSynchronized(callback) {
  execFile('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5000 },
    (err, stdout) => callback(err, !err && String(stdout).trim() === 'yes'));
}

/*
 * Poll until the clock can be believed, then stop. onChange fires once, when
 * it can. That is when the network has set it, or straight away if a hardware
 * clock vouches for it (rtcVerdict). `floor` returns the latest time known to
 * be real, in ms — server.js passes the last recorded tap.
 *
 * Off Linux the clock is the laptop's own and always right, so it starts ready.
 * If timedatectl itself can't be run we can't tell either way; refusing every
 * tap forever would be worse than trusting the clock, so we say so in the log
 * and trust it.
 */
function watchClock({ onChange = () => {}, log = () => {}, check = ntpSynchronized,
  platform = process.platform, intervalMs = CLOCK_POLL_MS,
  rtc = readRtc, floor = () => 0, now = Date.now } = {}) {
  let ready = platform !== 'linux';
  let source = ready ? 'host' : null; // 'network' | 'rtc' | 'unchecked' once ready
  let timer = null;
  let rtcReason = null;

  function poll() {
    check((err, synced) => {
      if (err && err.code === 'ENOENT') {
        log('timedatectl not found — cannot check the clock, trusting it as it is');
        synced = true;
        source = 'unchecked';
      }
      let verdict = null;
      if (!synced) {
        verdict = rtcVerdict({ rtc: rtc(), nowMs: now(), floorMs: floor() });
        // Said once per reason. "No hardware clock" is the ordinary case and
        // not worth a line.
        if (!verdict.ok && verdict.reason !== rtcReason && verdict.reason !== 'no hardware clock') {
          log(`not trusting the hardware clock: ${verdict.reason}`);
        }
        rtcReason = verdict.reason;
      }
      if (synced || verdict.ok) {
        ready = true;
        source = source || (synced ? 'network' : 'rtc');
        log(source === 'rtc'
          ? 'clock is set from the hardware clock — taps are being recorded'
          : 'clock is set — taps are being recorded');
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
    source: () => source,
    stop: () => clearTimeout(timer),
  };
}

module.exports = { BOOT_ID, readBootId, watchClock, readRtc, rtcVerdict, RTC_TOLERANCE_MS };
