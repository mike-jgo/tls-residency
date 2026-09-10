'use strict';

/*
 * Turns a person's raw in/out events into sessions and totals.
 *
 * A session is one check-in paired with the next check-out. Because the
 * scan endpoint toggles state, you can't normally get two check-ins in a
 * row — but we guard against it anyway.
 *
 * Forgotten check-outs are the one thing that can wreck residency hours:
 * someone taps in, leaves without tapping out, and their next tap days
 * later would close a 40-hour "session". Nothing here tries to guess what
 * they actually worked. A session longer than MAX_SESSION_HOURS is worth
 * nothing and is flagged, so forgetting to tap out costs you the session
 * rather than inflating it.
 *
 * The same limit drives the scan toggle (see lib/scan.js): a tap arriving
 * more than MAX_SESSION_HOURS after a check-in is treated as a new arrival,
 * not a check-out. That costs the person nothing they would otherwise have
 * kept — a session closed that late is worth zero either way — and it stops
 * one forgotten check-out from turning tomorrow's arrival into a check-out.
 */

const MAX_SESSION_HOURS = Number(process.env.MAX_SESSION_HOURS || 10);
const MAX_SESSION_MS = MAX_SESSION_HOURS * 60 * 60 * 1000;

// An abandoned check-in: a later check-in exists, so this one was never
// closed and never will be. Worth nothing, flagged for a human.
function abandoned(inAt) {
  return { inAt, outAt: null, ms: 0, open: true, invalid: true };
}

function buildSessions(events) {
  const sessions = [];
  let openIn = null;

  for (const e of events) {
    if (e.type === 'in') {
      // A new check-in while one is already open. With the stale rule in
      // lib/scan.js this is the normal shape of a forgotten check-out.
      if (openIn) sessions.push(abandoned(openIn.ts));
      openIn = e;
    } else { // 'out'
      if (!openIn) continue; // a stray check-out with no matching check-in — ignore
      let ms = new Date(e.ts) - new Date(openIn.ts);
      let invalid = false;
      if (ms < 0) ms = 0;
      if (ms > MAX_SESSION_MS) { ms = 0; invalid = true; }
      sessions.push({ inAt: openIn.ts, outAt: e.ts, ms, open: false, invalid });
      openIn = null;
    }
  }

  // Still checked in right now — an open session, contributes 0 to totals.
  // Unlike the abandoned ones above, this is the person's live state.
  if (openIn) sessions.push({ inAt: openIn.ts, outAt: null, ms: 0, open: true, invalid: false });

  return sessions;
}

// Sessions whose check-in falls within [startISO, endISO] (inclusive start,
// exclusive end). Pass null for either bound to leave it open.
function filterByRange(sessions, startISO, endISO) {
  return sessions.filter((s) => {
    if (startISO && s.inAt < startISO) return false;
    if (endISO && s.inAt >= endISO) return false;
    return true;
  });
}

function sumMs(sessions) {
  return sessions.reduce((total, s) => total + s.ms, 0);
}

function msToHours(ms) {
  return Math.round((ms / 3_600_000) * 100) / 100; // 2 decimal places
}

module.exports = {
  MAX_SESSION_HOURS,
  MAX_SESSION_MS,
  buildSessions,
  filterByRange,
  sumMs,
  msToHours,
};
