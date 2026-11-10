'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readPerson, telegramHandle, SECTIONS, STATUSES } = require('../lib/people');

const form = (changes = {}) => ({
  name: ' Ana Cruz ', student_id: '12345678', section: 'Sports', status: 'Probie',
  telegram: 'ana_cruz', ...changes,
});

test('a Telegram handle is stored with one @ however it was typed', () => {
  assert.strictEqual(telegramHandle('ana_cruz'), '@ana_cruz');
  assert.strictEqual(telegramHandle('@ana_cruz'), '@ana_cruz');
  assert.strictEqual(telegramHandle('  @@ana_cruz '), '@ana_cruz');
});

test('something that is not a Telegram handle is refused', () => {
  for (const bad of ['', '@', 'ana cruz', 'https://t.me/ana', 'a'.repeat(33)]) {
    assert.strictEqual(telegramHandle(bad), null, JSON.stringify(bad));
  }
});

test('a filled-in form becomes a person', () => {
  assert.deepStrictEqual(readPerson(form()).person, {
    name: 'Ana Cruz', student_id: '12345678', section: 'Sports', status: 'Probie',
    telegram: '@ana_cruz',
  });
});

test('every section and every status is accepted', () => {
  for (const section of SECTIONS) assert.ok(readPerson(form({ section })).person, section);
  for (const status of STATUSES) assert.ok(readPerson(form({ status })).person, status);
});

test('name, ID number, section and status are all required', () => {
  for (const key of ['name', 'student_id', 'section', 'status']) {
    const { person, error } = readPerson(form({ [key]: '' }));
    assert.strictEqual(person, undefined, key);
    assert.ok(error, key);
  }
});

test('a Telegram handle can be left out, but not mistyped', () => {
  assert.strictEqual(readPerson(form({ telegram: '' })).person.telegram, null);
  assert.strictEqual(readPerson(form({ telegram: '  ' })).person.telegram, null);
  assert.match(readPerson(form({ telegram: 'two words' })).error, /Telegram/);
});

// The dropdowns are only a convenience: a request can carry anything.
test('a section or status that is not on the list is refused', () => {
  assert.ok(readPerson(form({ section: 'Gossip' })).error);
  assert.ok(readPerson(form({ status: 'Boss' })).error);
  assert.ok(readPerson(undefined).error);
});
