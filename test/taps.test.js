'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.TZ = 'Asia/Manila';
const { read } = require('../lib/taps');

const OCT = 'October 2026 Logs';
const row = (id, time, direction, date = '2026-10-01') => [id, date, time, 'Ana Cruz', '111', direction];

test('tabs as an upload wrote them are read back as they are', () => {
  const { rows, tidy, errors } = read([
    { title: 'September 2026 Logs', values: [row(1, '09:00:00', 'IN', '2026-09-30'), row(2, '12:00:00', 'OUT', '2026-09-30')] },
    { title: OCT, values: [row('3', '09:00:00', 'IN'), row('1,004', '10:30:00', 'out')] },
  ]);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(tidy, true);
  assert.deepStrictEqual(rows.map((r) => r.id), [1, 2, 3, 1004]);
  assert.deepStrictEqual(rows[3], { id: 1004, ts: '2026-10-01T02:30:00.000Z', type: 'out', name: 'Ana Cruz', student_id: '111' });
});

test('tabs edited by hand are put in time order and numbered again', () => {
  const edited = [
    [[row(1, '09:00:00', 'IN'), [], row(3, '12:00:00', 'OUT')], 'a deleted row'],
    [[row(1, '09:00:00', 'IN'), row('', '12:00:00', 'OUT')], 'a typed-in row with no number'],
    [[row(2, '09:00:00', 'IN'), row(1, '12:00:00', 'OUT')], 'numbers out of order'],
    [[row(1, '09:00:00', 'IN'), row(2, '12:00:00', 'OUT', '2026-11-02')], 'a tap in the wrong month\'s tab'],
  ];
  for (const [values, why] of edited) {
    const { rows, tidy, errors } = read([{ title: OCT, values }]);
    assert.deepStrictEqual(errors, [], why);
    assert.strictEqual(tidy, false, why);
    assert.deepStrictEqual(rows.map((r) => [r.id, r.type]), [[1, 'in'], [2, 'out']], why);
  }
  const late = read([{ title: OCT, values: [row(1, '09:00:00', 'IN'), row(2, '17:00:00', 'OUT'), row('', '12:00', 'OUT')] }]);
  assert.deepStrictEqual(late.rows.map((r) => r.ts.slice(11, 16)), ['01:00', '04:00', '09:00'], 'by time, not by row');
});

test('a row that cannot be read is an error that says where', () => {
  const { errors } = read([{
    title: OCT,
    values: [row(1, '9am', 'IN'), row(2, '09:00:00', 'ARRIVED'), [3, '2026-10-01', '09:00:00', '', '', 'IN']],
  }]);
  assert.strictEqual(errors.length, 3);
  assert.match(errors[0], /^October 2026 Logs, row 2: "2026-10-01 9am" is not a date and time/);
  assert.match(errors[1], /row 3: the direction must be IN or OUT/);
  assert.match(errors[2], /row 4: no name or student ID/);
});

test('no Logs tabs is no taps', () => {
  assert.deepStrictEqual(read([]), { rows: [], tidy: true, errors: [] });
  assert.deepStrictEqual(read([{ title: OCT, values: [] }]), { rows: [], tidy: true, errors: [] });
});
