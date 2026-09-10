'use strict';

/*
 * Report date ranges.
 *
 * The hours page hands us two YYYY-MM-DD boxes and expects ISO instants back.
 * Two things went wrong doing that inline:
 *
 *   - `new Date('2026-01-05T00:00:00')` is parsed in the *host's* timezone, so
 *     the range boundaries moved with whatever machine ran the server. The Pi
 *     and a laptop would disagree about which taps fall in a day.
 *   - A box that didn't contain a date produced an Invalid Date, and calling
 *     .toISOString() on that throws — so `?start=x` was a 500, not a message.
 *
 * Both are fixed here: bounds are resolved in TZ (the same zone views.js
 * formats in, so the report agrees with the times on screen), and anything
 * unparseable comes back as an `error` string for the page to show.
 */

const TZ = process.env.TZ || 'Asia/Manila';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// How far `instant` is ahead of UTC in TZ: format it there, read the wall
// clock back, and diff. Manila is a fixed +08:00, but reading it from the
// zone keeps this correct for whatever TZ the deployment is configured with.
function zoneOffsetMs(instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);

  const at = {};
  for (const { type, value } of parts) at[type] = Number(value);
  // Some ICU versions render midnight as hour 24.
  const wall = Date.UTC(at.year, at.month - 1, at.day, at.hour % 24, at.minute, at.second);
  return wall - instant.getTime();
}

// The instant at which the given calendar day began in TZ. Out-of-range parts
// roll over the way Date.UTC does, so day + 1 is a safe "next day".
//
// Guess at UTC, correct by that guess's offset, then correct once more: the
// second pass only matters in zones with DST, where the first guess can land
// on the wrong side of a transition. Manila has none, so it is a no-op there.
function startOfDay(y, m, d) {
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - zoneOffsetMs(new Date(guess));
  return new Date(guess);
}

/*
 * Strict YYYY-MM-DD. Returns { y, m, d, instant } or null.
 *
 * The round-trip check is what rejects a date that doesn't exist: Date.UTC
 * rolls '2026-02-30' into March, which would silently shift the range instead
 * of telling anyone. Formatting the result back and comparing catches it.
 */
function parseDay(text) {
  const match = DATE_RE.exec(text);
  if (!match) return null;

  const [, y, m, d] = match.map(Number);
  const instant = startOfDay(y, m, d);
  const roundTrip = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);

  return roundTrip === text ? { y, m, d, instant } : null;
}

const badDate = (text) =>
  `"${text}" is not a valid date — use the date picker, or type it as YYYY-MM-DD.`;

/*
 * Turn the two date boxes into ISO bounds: start = 00:00 of `start` in TZ,
 * end = 00:00 of the day *after* `end`, so the To date is itself included.
 *
 * Returns { startISO, endISO, error }. A blank box is an open bound, not an
 * error. Whenever `error` is set both bounds are null, so a caller that
 * forgets to check it reports on everything rather than crashing.
 */
function dayBounds(start, end) {
  const from = start ? parseDay(start) : null;
  if (start && !from) return { startISO: null, endISO: null, error: badDate(start) };

  const to = end ? parseDay(end) : null;
  if (end && !to) return { startISO: null, endISO: null, error: badDate(end) };

  if (from && to && from.instant > to.instant) {
    return {
      startISO: null,
      endISO: null,
      error: 'The "From" date is after the "To" date — nothing could fall in that range.',
    };
  }

  return {
    startISO: from ? from.instant.toISOString() : null,
    endISO: to ? startOfDay(to.y, to.m, to.d + 1).toISOString() : null,
    error: null,
  };
}

module.exports = { TZ, dayBounds, parseDay };
