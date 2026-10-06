'use strict';

/*
 * The Staffers tab is the record of who the staffers are — their details,
 * their card, whether they are deactivated. The people in this device's
 * database are a copy of it, kept so that a tap can be answered with no
 * internet. Nothing about a person is changed here first:
 *
 *   pull()   every sync: make this device's people match the tab.
 *   place()  a register, edit or deactivation on the People page: where in
 *            the tab it goes. The server writes it there, and saves it here
 *            only once Google has confirmed it — so with no internet, people
 *            can't be added or changed.
 *
 * Both only work out what to do; lib/sync.js does it.
 *
 * A row is matched to a person here by ID number, or failing that by card,
 * so either can be corrected in the sheet without the person's taps coming
 * loose. A row this device can't use (an unknown section, an ID number on two
 * rows) is skipped with a warning and whoever it is about stays as they were.
 *
 * Nothing in the tab can delete taps: a deleted row deactivates the person.
 */

const { readPerson, telegramHandle } = require('./people');

const TAB = 'Staffers';
const HEADER = ['Name', 'ID number', 'Section', 'Status', 'Telegram', 'Deactivated', 'Card number'];
const ID = 1;
const OFF = 5;
const CARD = 6;

const RANGE = `'${TAB}'!A1:G`;
const rowRange = (n) => `'${TAB}'!A${n}:G${n}`;

// A person, as their row.
const rowOf = (u) => [
  u.name, u.student_id || '', u.section || '', u.status || '', u.telegram || '',
  u.active ? '' : 'yes', u.rfid,
];

// A row as read: Google leaves trailing empty cells off, and people type
// "Yes" and handles without their @.
function clean(cells = []) {
  const row = HEADER.map((_, i) => String(cells[i] == null ? '' : cells[i]).trim());
  row[4] = telegramHandle(row[4]) || row[4];
  if (/^yes$/i.test(row[OFF])) row[OFF] = 'yes';
  return row;
}

const asForm = (row) => ({
  name: row[0], student_id: row[1], section: row[2], status: row[3],
  telegram: row[4],
});

// Why a row can't be used, or null.
function problem(row) {
  if (row[OFF] !== '' && row[OFF] !== 'yes') return 'Deactivated must be "yes" or empty.';
  if (row[CARD] && !/^\d{1,64}$/.test(row[CARD])) return 'The card number must be all digits.';
  return readPerson(asForm(row)).error || null;
}

const same = (a, b) => a.join('\u0000') === b.join('\u0000');

// The tab's cells -> its rows that have anything in them, the first row past
// them all, and the header row to write if it isn't there.
function scan(values) {
  const header = HEADER.map((_, i) => String((values[0] || [])[i] || '').trim());
  const rows = values.slice(1)
    .map((cells, i) => ({ n: i + 2, row: clean(cells) }))
    .filter((r) => r.row.some((cell) => cell !== ''));
  return {
    rows,
    next: Math.max(values.length, 1) + 1,
    writes: same(header, HEADER) ? [] : [{ range: rowRange(1), values: [HEADER] }],
  };
}

const tally = (rows, column) => {
  const count = new Map();
  for (const { row } of rows) if (row[column]) count.set(row[column], (count.get(row[column]) || 0) + 1);
  return count;
};

function pull(users, values = []) {
  const { rows, next, writes } = scan(values);
  const plan = {
    create: [],     // { person, active, rfid }      in the tab, not here yet
    update: [],     // { id, person, active, rfid }  differs from the tab
    deactivate: [], // ids whose row is gone
    seen: [],       // ids found in the tab for the first time, unchanged
    writes,         // rows for people here whom the tab has never listed
    seeded: [],     // their ids, to mark once `writes` is confirmed
    warnings: [],   // text for the People page
    unlinked: [],   // { n, row, person }: a row with no card yet
  };
  let last = next;

  // Whoever a skipped row is about stays as they are here.
  const skippedIds = new Set();
  const skippedCards = new Set();
  const skip = ({ n, row }, why) => {
    plan.warnings.push(`Row ${n} (${row[0] || 'no name'}): ${why}`);
    if (row[ID]) skippedIds.add(row[ID]);
    if (row[CARD]) skippedCards.add(row[CARD]);
  };

  const ids = tally(rows, ID);
  const cards = tally(rows, CARD);
  let good = [];
  const cardless = [];
  for (const r of rows) {
    const { row } = r;
    if (!row[ID]) skip(r, 'no ID number.');
    else if (ids.get(row[ID]) > 1) skip(r, `ID number ${row[ID]} is on more than one row.`);
    else if (cards.get(row[CARD]) > 1) skip(r, `card number ${row[CARD]} is on more than one row.`);
    else if (problem(row)) skip(r, problem(row));
    else if (!row[CARD]) cardless.push(r);
    else good.push(r);
  }

  const taken = new Set();
  const match = (r, test) => {
    const user = users.find((u) => !taken.has(u.id) && test(u));
    if (user) { taken.add(user.id); r.user = user; }
  };
  for (const r of good) match(r, (u) => u.student_id === r.row[ID]);
  for (const r of good) if (!r.user) match(r, (u) => u.rfid === r.row[CARD]);

  // A card can't be handed to someone while a person the tab doesn't list
  // still holds it here: cards are never reassigned.
  good = good.filter((r) => {
    const holder = users.find((u) => u.rfid === r.row[CARD]);
    if (!holder || taken.has(holder.id)) return true;
    skip(r, `card number ${r.row[CARD]} belongs to ${holder.name} on this device.`);
    return false;
  });

  for (const { row, user } of good) {
    const entry = { person: readPerson(asForm(row)).person, active: row[OFF] !== 'yes', rfid: row[CARD] };
    if (!user) plan.create.push(entry);
    else if (!same(rowOf(user), row)) plan.update.push({ id: user.id, ...entry });
    else if (!user.in_sheet) plan.seen.push(user.id);
  }

  for (const r of cardless) {
    match(r, (u) => u.student_id === r.row[ID]);
    if (r.user) plan.warnings.push(`Row ${r.n} (${r.row[0]}): no card number.`);
    else plan.unlinked.push({ n: r.n, row: r.row, person: readPerson(asForm(r.row)).person });
  }

  for (const u of users) {
    if (taken.has(u.id) || skippedIds.has(u.student_id) || skippedCards.has(u.rfid)) continue;
    if (!u.in_sheet) {
      // Registered before the tab was the record, or the tab is a new one.
      plan.writes.push({ range: rowRange(last++), values: [rowOf(u)] });
      plan.seeded.push(u.id);
    } else if (u.active) {
      plan.deactivate.push(u.id);
    }
  }
  return plan;
}

// Where a person's row goes: { writes }, or { error } when the tab already
// has their ID number or card on someone else's row. `own` is the person as
// this device has them, or null for someone new — who takes up a row that
// has their ID number and is only waiting for a card, if there is one.
function place(values, row, own) {
  const { rows, next, writes } = scan(values);
  const mine = own
    ? rows.find((r) => own.student_id && r.row[ID] === own.student_id) || rows.find((r) => r.row[CARD] === own.rfid)
    : rows.find((r) => r.row[ID] === row[ID] && !r.row[CARD]);
  for (const r of rows) {
    if (r === mine) continue;
    const whose = `${r.row[0] || 'someone'} (row ${r.n} of the sheet)`;
    if (r.row[ID] === row[ID]) return { error: `ID number ${row[ID]} already belongs to ${whose}.` };
    if (r.row[CARD] === row[CARD]) return { error: `That card number already belongs to ${whose}.` };
  }
  return { writes: [...writes, { range: rowRange(mine ? mine.n : next), values: [row] }] };
}

module.exports = { pull, place, rowOf, TAB, HEADER, RANGE };
