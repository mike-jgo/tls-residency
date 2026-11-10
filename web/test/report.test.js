'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildReport, hoursCsv, leaderboards } = require('../lib/report');
const { SECTIONS } = require('../lib/people');

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

test('sections are ranked by their staffers hours, and every section is listed', () => {
  const { sections } = leaderboards([
    row({ section: 'Web', hours: 1.25 }), row({ section: 'Web', hours: 2.5 }),
    row({ section: 'Photo', hours: 3 }), row({ section: 'Photo', hours: 2, active: false }),
    row({ section: null, hours: 9 }),
  ]);
  assert.deepStrictEqual(sections.slice(0, 2), [{ section: 'Photo', hours: 5 }, { section: 'Web', hours: 3.75 }]);
  assert.strictEqual(sections.length, SECTIONS.length);
  assert.ok(sections.slice(2).every((s) => s.hours === 0));
});

test('the top ten staffers are active people with hours, most first', () => {
  const people = Array.from({ length: 12 }, (_, i) => row({ name: 'P' + String(i).padStart(2, '0'), section: 'Web', hours: i }));
  people.push(row({ name: 'Gone', hours: 99, active: false }));
  const { staffers } = leaderboards(people);
  assert.strictEqual(staffers.length, 10);
  assert.deepStrictEqual(staffers[0], { name: 'P11', section: 'Web', hours: 11 });
  assert.ok(!staffers.some((p) => p.name === 'Gone' || p.hours === 0));
});

test('dummy staffers are left out of the report, so out of every total', () => {
  const users = [
    { id: 1, name: 'Ana Cruz', status: 'Regular', section: 'Web', active: 1 },
    { id: 2, name: 'Bobet', status: 'Dummy', section: 'Sports', active: 1 },
  ];
  const store = { listUsers: () => users, getEventsForUser: () => [] };
  assert.deepStrictEqual(buildReport(store, 'boot', null, null).report.map((r) => r.name), ['Ana Cruz']);
});

test('EB and EAL staffers count for their section but are left out of the top ten', () => {
  const { sections, staffers } = leaderboards([
    row({ name: 'Eb', section: 'Web', status: 'EB', hours: 9 }),
    row({ name: 'Eal', section: 'Web', status: 'EAL', hours: 8 }),
    row({ name: 'Reg', section: 'Web', status: 'Regular', hours: 1 }),
  ]);
  assert.deepStrictEqual(staffers.map((p) => p.name), ['Reg']);
  assert.deepStrictEqual(sections[0], { section: 'Web', hours: 18 });
});
