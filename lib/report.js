'use strict';

/*
 * The hours report: each person's sessions, optionally filtered to a date
 * range, totalled up. Shared by the admin Hours page, the CSV export and the
 * Google Sheets sync, so all three always show the same numbers.
 */

const hours = require('./hours');

function buildReport(store, bootId, startISO, endISO) {
  const users = store.listUsers();
  let anyInvalid = false;
  const report = users.map((u) => {
    const events = store.getEventsForUser(u.id);
    const all = hours.buildSessions(events, { bootId });
    const inRange = hours.filterByRange(all, startISO, endISO);
    const invalid = inRange.some((s) => s.invalid);
    if (invalid) anyInvalid = true;
    return {
      name: u.name,
      student_id: u.student_id,
      active: Boolean(u.active),
      hours: hours.msToHours(hours.sumMs(inRange)),
      // Discarded sessions earned nothing, so they are not sessions worked.
      sessions: inRange.filter((s) => !s.open && !s.invalid).length,
      // Only the live session means "still in". An abandoned check-in is also
      // open, but that person went home — saying they are in would be a lie
      // that never expires. That includes one left open at last night's
      // shutdown, which buildSessions flags as abandoned given the boot id.
      open: Boolean(u.active) && inRange.some((s) => s.open && !s.invalid),
      // Which sessions earned nothing, so the page can say when and why.
      uncounted: inRange.filter((s) => s.invalid).map((s) => ({ inAt: s.inAt, outAt: s.outAt })),
      // Whether they tapped at all in the range, counted or not.
      any: inRange.length > 0,
    };
  });
  return { report, anyInvalid };
}

// One cell of the CSV. Names and ID numbers are whatever somebody typed, and a
// spreadsheet runs a cell starting with = + - or @ (or a tab or return ahead
// of one) as a formula — so those get a leading apostrophe, which makes the
// cell text.
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// The report as the CSV file. "Uncounted sessions" travels with the numbers: a
// discarded session shows up as a silent zero otherwise, and this is the file
// someone signs off residency on.
function hoursCsv(report) {
  const lines = [['Name', 'Student ID', 'Hours', 'Sessions', 'Still in', 'Uncounted sessions', 'Deactivated'].join(',')];
  for (const r of report) {
    lines.push([
      r.name, r.student_id, r.hours.toFixed(2), r.sessions,
      r.open ? 'yes' : '', r.uncounted.length || '', r.active ? '' : 'yes',
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

module.exports = { buildReport, hoursCsv };
