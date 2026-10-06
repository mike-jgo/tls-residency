'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { hoursCsv } = require('../lib/report');

const row = (changes) => ({
  name: 'Ana Cruz', student_id: '111', hours: 1.5, sessions: 2, open: false, uncounted: [], active: true, ...changes,
});
const HEAD = 'Name,Student ID,Hours,Sessions,Still in,Uncounted sessions,Deactivated\n';
const cells = (changes) => hoursCsv([row(changes)]).slice(HEAD.length);

test('the CSV has a header and a line per person', () => {
  assert.strictEqual(hoursCsv([row(), row({ name: 'Ben Dy', open: true, uncounted: [{}], active: false })]), [
    'Name,Student ID,Hours,Sessions,Still in,Uncounted sessions,Deactivated',
    'Ana Cruz,111,1.50,2,,,',
    'Ben Dy,111,1.50,2,yes,1,yes',
  ].join('\n'));
});

test('commas, quotes and line breaks are quoted', () => {
  assert.strictEqual(cells({ name: 'Cruz, Ana "AC"' }), '"Cruz, Ana ""AC""",111,1.50,2,,,');
  assert.strictEqual(cells({ name: 'Ana\r\nCruz' }), '"Ana\r\nCruz",111,1.50,2,,,');
});

// The name and ID number are whatever was typed at registration.
test('a name or ID number a spreadsheet would run as a formula is made text', () => {
  assert.strictEqual(cells({ name: '=1+1', student_id: 'AUDITCSV' }), "'=1+1,AUDITCSV,1.50,2,,,");
  for (const start of ['=', '+', '-', '@', '\t']) {
    assert.ok(cells({ name: `${start}cmd` }).startsWith(`'${start}cmd,`), JSON.stringify(start));
    assert.ok(cells({ student_id: `${start}1` }).startsWith(`Ana Cruz,'${start}1,`), JSON.stringify(start));
  }
  assert.strictEqual(cells({ name: '\r=1+1' }), '"\'\r=1+1",111,1.50,2,,,');
  assert.strictEqual(cells({ name: '=HYPERLINK("http://x","y")' }), '"\'=HYPERLINK(""http://x"",""y"")",111,1.50,2,,,');
});

test('an ordinary name is left alone', () => {
  assert.strictEqual(cells({ name: 'Mary-Ann = O\'Brien' }), 'Mary-Ann = O\'Brien,111,1.50,2,,,');
});
