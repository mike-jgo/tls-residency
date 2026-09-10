'use strict';

/*
 * What happens when a card is tapped.
 *
 * Lives here rather than in server.js so it can be tested without starting a
 * listener: the toggle is the part of this system that has to be right, and
 * it is the part nobody can see going wrong. There is no display at the
 * reader, so a wrong decision is silent until the hours report is due.
 *
 * Three rules, in order:
 *
 *   1. Repeat taps. Someone unsure whether their tap landed taps again, and a
 *      plain toggle would check them straight back out. A second tap of the
 *      same card within REPEAT_IGNORE_MS is ignored.
 *
 *   2. Stale check-ins. Someone taps in, goes home without tapping out, and
 *      comes back the next morning. A plain toggle reads that arrival as a
 *      departure — so they are marked out while they are in, and every tap
 *      after that is inverted too. If the open check-in is older than
 *      MAX_SESSION_HOURS the tap is an arrival, not a departure. The
 *      abandoned check-in is left as it is: lib/hours.js already counts an
 *      unclosed session as zero, and forgetting to tap out is meant to cost
 *      the session rather than mint a fake one.
 *
 *   3. Otherwise toggle on the person's last event.
 *
 * Rule 2 misfires on a genuine stretch longer than MAX_SESSION_HOURS — the
 * tap-out is read as a fresh arrival. That costs nothing: a session that long
 * is worth zero either way, and the alternative (rule 2 absent) inverts every
 * tap that follows.
 *
 * ---- Why elapsed time is measured monotonically ------------------------
 *
 * Rule 2 is the only part of the toggle that asks how much time has passed,
 * which on a Pi with no RTC is a loaded question. The box boots believing it
 * is whenever it last shut down and jumps forward when NTP reaches it. Two
 * wall-clock readings taken either side of that jump are not comparable:
 *
 *   09:00  Pi boots a day behind, someone taps in     (recorded 04 Jan 09:00)
 *   09:30  network returns, NTP corrects the clock    (now really 05 Jan)
 *   10:00  they tap out, one real hour later          (looks like 25 hours)
 *
 * Rule 2 then fires on a departure and records an arrival, leaving someone
 * who has gone home marked present — the exact inversion the rule exists to
 * prevent, and worse than not having it, because it repeats every day the
 * clock is wrong.
 *
 * So elapsed time comes from a monotonic clock, which counts real time since
 * the process started and cannot be rewritten by NTP. Wall-clock time is
 * still what gets *stored* — the timestamps have to mean something to a human
 * reading the report — but it is never used to measure a duration.
 *
 * That works for any check-in this process saw. Across a restart there is no
 * monotonic reading to compare against and the stored timestamp is all there
 * is, so the measurement is uncertain; `measureAge` marks it as such and the
 * comment there explains what we do about it.
 */

const { MAX_SESSION_MS } = require('./hours');

const REPEAT_IGNORE_MS = 5000;

// How many unrecognized cards to remember for the registration page.
const UNKNOWN_KEEP = 20;

// Real milliseconds since this process started. Unaffected by NTP, by manual
// clock changes, and by the Pi coming up with no idea what day it is.
const elapsedSinceBoot = () => performance.now();

/*
 * The reader is wired to the Pi, not to whatever browser the admin is using,
 * so a new card can't be tapped into the registration form. Remember the last
 * few unrecognized cards instead and offer them on the People page — with no
 * display at the reader, this is the only way to learn a card number.
 *
 * In memory on purpose: it's a registration convenience, not a record.
 *
 * `now` (wall clock, for the timestamps we store) and `mono` (elapsed real
 * time, for every duration) are injectable so the tests can drive the repeat
 * window, the staleness cutoff and a clock correction independently.
 */
function createScanner({ store, now = Date.now, mono = elapsedSinceBoot }) {
  const unknownScans = []; // newest first: { rfid, ts }

  // rfid -> monotonic reading of the tap we acted on.
  const lastTap = new Map();

  // user id -> { eventId, mono } for a check-in this process recorded. Lets us
  // measure how long someone has been in without trusting the wall clock.
  // One entry per person currently checked in, dropped when they tap out.
  const openCheckIn = new Map();

  function rememberUnknown(rfid, at) {
    forgetUnknown(rfid);
    unknownScans.unshift({ rfid, ts: new Date(at).toISOString() });
    if (unknownScans.length > UNKNOWN_KEEP) unknownScans.pop();
  }

  function forgetUnknown(rfid) {
    const i = unknownScans.findIndex((u) => u.rfid === rfid);
    if (i !== -1) unknownScans.splice(i, 1);
  }

  /*
   * How long has this check-in been open, and how much do we trust the answer?
   *
   * If we recorded the check-in ourselves, the monotonic reading we kept is
   * exact no matter what the clock has done since.
   *
   * Otherwise the process restarted between the two taps and the stored
   * timestamp is the only evidence there is. It may have been written while
   * the clock was wrong, so an inflated age can't be ruled out. We use it
   * anyway, deliberately: the alternative is to skip rule 2 across restarts,
   * which restores the original bug — an arrival recorded as a departure,
   * inverting every tap that follows and zeroing the person's hours day after
   * day. A wrong "stale" costs one session and rights itself on the next tap;
   * a wrong "not stale" compounds. Given an uncertain measurement, the
   * cheaper mistake is the one to make.
   */
  function measureAge(last, atMono) {
    const observed = openCheckIn.get(last.user_id);
    if (observed && observed.eventId === last.id) {
      return { ms: atMono - observed.mono, certain: true };
    }
    return { ms: now() - Date.parse(last.ts), certain: false };
  }

  function handle(rfid) {
    const atMono = mono();

    // Monotonic, so a clock correction can neither swallow taps (a backwards
    // jump making every tap look like a repeat) nor stop suppressing them.
    const previous = lastTap.get(rfid);
    if (previous !== undefined && atMono - previous < REPEAT_IGNORE_MS) {
      return { status: 'ignored', rfid };
    }
    lastTap.set(rfid, atMono);

    const user = store.getUserByRfid(rfid);
    if (!user) {
      // Unknown card: report it clearly instead of failing silently, and
      // remember it so it can be registered from the People page.
      rememberUnknown(rfid, now());
      return { status: 'unknown', rfid };
    }

    const last = store.getLastEvent(user.id);

    let stale = false;
    let certain = true;
    if (last && last.type === 'in') {
      const age = measureAge(last, atMono);
      certain = age.certain;
      stale = Number.isFinite(age.ms) && age.ms > MAX_SESSION_MS;
    }

    const direction = (!last || last.type === 'out' || stale) ? 'in' : 'out';

    const ts = new Date(now()).toISOString();
    const written = store.insertEvent(user.id, direction, ts);

    if (direction === 'in') {
      // Start the clock on this check-in. If it replaced an abandoned one,
      // that reading goes with it.
      openCheckIn.set(user.id, { eventId: Number(written.lastInsertRowid), mono: atMono });
    } else {
      openCheckIn.delete(user.id);
    }

    return { status: 'ok', direction, stale, certain, name: user.name, time: ts };
  }

  return { handle, forgetUnknown, unknownScans };
}

module.exports = { createScanner, REPEAT_IGNORE_MS, UNKNOWN_KEEP };
