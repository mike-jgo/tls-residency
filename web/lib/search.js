'use strict';

/*
 * The Search tab: type a name or an ID number in B1, and three tables fill in
 * beside each other — that person's hours for every month, their details from
 * the Staffers tab, and their taps.
 *
 * It is all formulas, worked out by the spreadsheet itself, so it answers
 * with the Pi switched off. The formulas name every month tab, so they are
 * written again whenever a month is added — lib/sync.js.
 *
 * A name matches anywhere in it, any case; an ID number has to be exact.
 * Nothing a person typed goes into a formula's text: the formulas read B1.
 */

const TAB = 'Search';
const COLUMNS = 24; // the three tables side by side reach column V
// Raise this when what searchTab writes changes, so every sheet gets it again.
const VERSION = 4;

const quoted = (title) => `'${title.replace(/'/g, "''")}'`;
const text = (value) => `"${value.replace(/"/g, '""')}"`;

// Rows of several tabs as one table. `where` filters it: `all` is the table.
const lookup = (parts, where) => '=ARRAYFORMULA(LET(q,$B$1,all,{' + parts.join(';') + '},' +
  `IF(q="","Type a name or ID number in B1",IFERROR(${where},"No match"))))`;

// Whose row it is: the name is in column `name`, the ID number in column `id`.
const matches = (name, id) => `ISNUMBER(SEARCH(q,INDEX(all,,${name})))+(INDEX(all,,${id})&""=q&"")`;

// `hoursTabs` and `logsTabs` are the month tabs that exist, newest first.
// The headers are lib/sync.js's and lib/roster.js's own. Returns ranges for the
// client's writeFormulas.
function searchTab({ hoursTabs, logsTabs, totalsTab, staffersTab, hoursHeader, tapsHeader, staffersHeader }) {
  // Each month's hours table, with the month in front of every row.
  const labelled = (label, title, from) =>
    `IF(LEN(${quoted(title)}!A${from}:A),${text(label)},""),${quoted(title)}!A${from}:G`;
  const hours = lookup(
    [labelled('All time', totalsTab, 4), ...hoursTabs.map((title) => labelled(title, title, 2))],
    `FILTER(all,${matches(2, 3)})`,
  );
  const details = lookup([`${quoted(staffersTab)}!A2:F`], `FILTER(all,${matches(1, 2)})`);
  const taps = logsTabs.length
    ? lookup(logsTabs.map((title) => `${quoted(title)}!A2:F`), `SORT(FILTER(all,${matches(4, 5)}),1,FALSE)`)
    : 'No taps yet';

  const at = (range) => `${quoted(TAB)}!${range}`;
  return [
    // B1 is where people type; it is never written to. lib/style.js makes it
    // a box three columns wide, so the hint goes after that.
    { range: at('A1:A1'), values: [['Name or ID number:']] },
    { range: at('E1:E1'), values: [['← type here, then press Enter']] },
    { range: at('A3:A3'), values: [['Hours']] },
    { range: at('A4:H4'), values: [['Month', ...hoursHeader]] },
    { range: at('A5:A5'), values: [[hours]] },
    { range: at('J3:J3'), values: [['Details']] },
    { range: at('J4:O4'), values: [staffersHeader.slice(0, 6)] }, // not the card
    { range: at('J5:J5'), values: [[details]] },
    { range: at('Q3:Q3'), values: [['Taps, newest first']] },
    { range: at('Q4:V4'), values: [tapsHeader] },
    { range: at('Q5:Q5'), values: [[taps]] },
  ];
}

module.exports = { searchTab, TAB, COLUMNS, VERSION };
