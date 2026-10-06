'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pull, place, rowOf, HEADER } = require('../lib/roster');

const ANA = ['Ana Cruz', '111', 'Sports', 'Probie', '@ana', '', '9001'];
const BEN = ['Ben Dy', '222', 'Web', 'Regular', '@ben', '', '9002'];

let ids = 0;
// A person on this device, from their row. `inSheet`: the tab has listed them.
function user(row, inSheet = true) {
  return {
    id: ++ids, name: row[0], student_id: row[1] || null, section: row[2] || null, status: row[3] || null,
    telegram: row[4] || null, active: row[5] === 'yes' ? 0 : 1,
    rfid: row[6], in_sheet: inSheet ? 1 : 0,
  };
}
const edit = (row, changes) => row.map((cell, i) => (i in changes ? changes[i] : cell));
const NOTHING = {
  create: [], update: [], deactivate: [], seen: [], writes: [], seeded: [], warnings: [], unlinked: [],
};

// ---- pull: this device follows the tab ----------------------------------

test('nothing to do when the tab and this device agree', () => {
  assert.deepStrictEqual(pull([user(ANA), user(BEN)], [HEADER, ANA, BEN]), NOTHING);
});

test('a row changed in the tab changes the person here', () => {
  const ana = user(ANA);
  const plan = pull([ana], [HEADER, edit(ANA, { 0: 'Ana Reyes', 3: 'Regular', 5: 'Yes' })]);
  assert.deepStrictEqual(plan.update, [{
    id: ana.id, active: false, rfid: '9001',
    person: {
      name: 'Ana Reyes', student_id: '111', section: 'Sports', status: 'Regular',
      telegram: '@ana',
    },
  }]);
  assert.deepStrictEqual(plan.writes, []);
});

test('a person is still found when their ID number or their card is corrected in the tab', () => {
  const ana = user(ANA);
  assert.strictEqual(pull([ana], [HEADER, edit(ANA, { 1: '119' })]).update[0].id, ana.id);
  const recarded = pull([ana], [HEADER, edit(ANA, { 6: '9555' })]);
  assert.strictEqual(recarded.update[0].id, ana.id);
  assert.strictEqual(recarded.update[0].rfid, '9555');
  assert.deepStrictEqual(recarded.create, []);
});

test('two cards swapped in the tab are swapped here, nobody is created', () => {
  const plan = pull([user(ANA), user(BEN)], [HEADER, edit(ANA, { 6: '9002' }), edit(BEN, { 6: '9001' })]);
  assert.deepStrictEqual(plan.update.map((u) => u.rfid), ['9002', '9001']);
  assert.deepStrictEqual(plan.create, []);
  assert.deepStrictEqual(plan.warnings, []);
});

test('a row with a card for someone not here creates them — a second device fills itself', () => {
  const plan = pull([], [HEADER, ANA, edit(BEN, { 5: 'yes' })]);
  assert.deepStrictEqual(plan.create.map((c) => [c.person.name, c.rfid, c.active]), [
    ['Ana Cruz', '9001', true], ['Ben Dy', '9002', false],
  ]);
  assert.deepStrictEqual(plan.writes, []);
});

test('what was typed in the tab is tidied before it is compared', () => {
  const typed = ['  Ana Cruz ', 111, 'Sports', 'Probie', 'ana', '', 9001];
  assert.deepStrictEqual(pull([user(ANA)], [HEADER, typed]), NOTHING);
});

test('a row deleted from the tab deactivates the person, and only that', () => {
  const ana = user(ANA);
  const plan = pull([ana, user(BEN)], [HEADER, BEN]);
  assert.deepStrictEqual(plan.deactivate, [ana.id]);
  assert.deepStrictEqual(plan.writes, [], 'the row is not put back');
  assert.deepStrictEqual(pull([user(edit(ANA, { 5: 'yes' }))], [HEADER]).deactivate, [], 'already deactivated');
});

test('people the tab has never listed are added to it, below everything', () => {
  const old = ['Old Timer', '333', '', '', '', '', '9003']; // from before the directory fields
  const [ana, timer] = [user(ANA, false), user(old, false)];
  const plan = pull([ana, timer, user(BEN)], [[], BEN, [], ['stray note']]);
  assert.deepStrictEqual(plan.writes, [
    { range: "'Staffers'!A1:G1", values: [HEADER] },
    { range: "'Staffers'!A5:G5", values: [ANA] },
    { range: "'Staffers'!A6:G6", values: [old] },
  ]);
  assert.deepStrictEqual(plan.seeded, [ana.id, timer.id]);
  assert.deepStrictEqual(plan.deactivate, []);
});

test('someone added that way is recognised next time, not added twice', () => {
  const ana = user(ANA, false);
  const plan = pull([ana], [HEADER, ANA]);
  assert.deepStrictEqual(plan.seen, [ana.id]);
  assert.deepStrictEqual(plan.writes, []);
});

test('a bad row is skipped with a warning, and its person stays as they are', () => {
  const cases = [
    [{ 2: 'Gossip' }, /section/], [{ 4: 'two words' }, /Telegram/], [{ 5: 'maybe' }, /Deactivated/],
    [{ 6: 'abc' }, /card number must be all digits/], [{ 1: '' }, /no ID number/], [{ 6: '' }, /no card number/],
  ];
  for (const [changes, why] of cases) {
    const plan = pull([user(ANA), user(BEN)], [HEADER, BEN, edit(ANA, changes)]);
    assert.deepStrictEqual({ ...plan, warnings: [] }, NOTHING, JSON.stringify(changes));
    assert.match(plan.warnings.find((w) => w.startsWith('Row 3 (Ana Cruz)')), why);
  }
});

test('an ID number or a card on two rows is used for neither', () => {
  for (const column of [1, 6]) {
    const plan = pull([user(ANA), user(BEN)], [HEADER, ANA, edit(BEN, { [column]: ANA[column] })]);
    assert.deepStrictEqual({ ...plan, warnings: [] }, NOTHING);
    assert.strictEqual(plan.warnings.length, 2);
    assert.match(plan.warnings[0], /more than one row/);
  }
});

test('a card still held here by someone the tab does not list is not handed on', () => {
  const gone = user(edit(ANA, { 5: 'yes' })); // row deleted long ago; card 9001 stays theirs
  const plan = pull([gone], [HEADER, edit(BEN, { 6: '9001', 1: '444' })]);
  // By card, this row is Ana: the tab says she is now Ben Dy with ID 444.
  assert.strictEqual(plan.update[0].id, gone.id);

  const both = pull([gone, user(BEN)], [HEADER, edit(BEN, { 6: '9001' })]);
  assert.deepStrictEqual(both.update, []);
  assert.match(both.warnings[0], /card number 9001 belongs to Ana Cruz/);
  assert.deepStrictEqual(both.deactivate, [], 'and Ben is not taken for deleted');
});

// Ana is given Ben's card and Ben is given Cy's — but Cy is not in the tab, so
// Ben keeps his, so Ana can't have it. Moving Ana anyway would put one card on
// two people, which the database refuses, failing every sync after it.
test('a card is not handed on when its holder, in turn, cannot move off it', () => {
  const CY = ['Cy Lim', '333', 'Photo', 'EB', '@cy', '', '9003'];
  const users = [user(ANA), user(BEN), user(CY)];
  const plan = pull(users, [HEADER, edit(ANA, { 6: '9002' }), edit(BEN, { 6: '9003' })]);
  assert.deepStrictEqual(plan.update, []);
  assert.deepStrictEqual(plan.create, []);
  assert.deepStrictEqual(plan.deactivate, [], 'nobody a skipped row is about is taken for deleted');
  assert.strictEqual(plan.warnings.length, 2);
  assert.match(plan.warnings[0], /Row 3 \(Ben Dy\): card number 9003 belongs to Cy Lim/);
  assert.match(plan.warnings[1], /Row 2 \(Ana Cruz\): card number 9002 belongs to Ben Dy/);

  // The rest of the tab still goes through.
  const rest = pull(users, [HEADER, edit(ANA, { 6: '9002' }), edit(BEN, { 6: '9003' }), edit(CY, { 0: 'Cy Lim Jr', 6: '9004' })]);
  assert.deepStrictEqual(rest.update.map((u) => u.rfid), ['9002', '9003', '9004'], 'a chain that ends on a free card moves');
});

test('a row with no card for someone not here waits for one', () => {
  const plan = pull([], [HEADER, edit(ANA, { 6: '' })]);
  assert.deepStrictEqual(plan.create, []);
  assert.strictEqual(plan.unlinked[0].n, 2);
  assert.strictEqual(plan.unlinked[0].person.name, 'Ana Cruz');
});

// ---- place: a save from the People page ---------------------------------

test('someone new goes on the first row past everything', () => {
  assert.deepStrictEqual(place([HEADER, BEN, [], ['stray note']], ANA, null), {
    writes: [{ range: "'Staffers'!A5:G5", values: [ANA] }],
  });
  assert.deepStrictEqual(place([], ANA, null).writes.map((w) => w.range), ["'Staffers'!A1:G1", "'Staffers'!A2:G2"]);
});

test('someone new takes up the row that was waiting for their card', () => {
  const spot = place([HEADER, BEN, edit(ANA, { 6: '' })], ANA, null);
  assert.deepStrictEqual(spot.writes, [{ range: "'Staffers'!A3:G3", values: [ANA] }]);
});

test('an ID number or card the tab already has is refused', () => {
  assert.match(place([HEADER, BEN, ANA], edit(ANA, { 6: '9999' }), null).error, /ID number 111 already belongs to Ana Cruz \(row 3/);
  assert.match(place([HEADER, BEN, ANA], edit(ANA, { 1: '999' }), null).error, /card number already belongs to Ana Cruz/);
  // ...also when editing someone into another person's ID number.
  assert.match(place([HEADER, BEN, ANA], edit(ANA, { 1: '222' }), user(ANA)).error, /222 already belongs to Ben Dy/);
});

test('an edit goes to the person\'s own row, found by ID number or by card', () => {
  const changed = edit(ANA, { 1: '119', 3: 'Regular', 5: 'yes' });
  assert.deepStrictEqual(place([HEADER, BEN, ANA], changed, user(ANA)).writes, [
    { range: "'Staffers'!A3:G3", values: [changed] },
  ]);
  const noId = user(edit(ANA, { 1: '' }));
  assert.deepStrictEqual(place([HEADER, BEN, edit(ANA, { 1: '' })], ANA, noId).writes[0].range, "'Staffers'!A3:G3");
});

test('reactivating someone whose row was deleted puts the row back', () => {
  assert.deepStrictEqual(place([HEADER, BEN], ANA, user(ANA)).writes, [
    { range: "'Staffers'!A3:G3", values: [ANA] },
  ]);
});

test('rowOf is the row pull compares against', () => {
  assert.deepStrictEqual(rowOf(user(ANA)), ANA);
  assert.deepStrictEqual(rowOf(user(edit(BEN, { 5: 'yes' }))), edit(BEN, { 5: 'yes' }));
});
