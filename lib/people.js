'use strict';

/*
 * The staffer directory: what is kept about a person besides their card, and
 * the check every register or edit goes through before it is saved. Shared by
 * the People page (the form), the server (the check) and the sheet sync (the
 * Staffers tab), so all three agree on the fields.
 */

const SECTIONS = ['University', 'Menagerie', 'Sports', 'Vanguard', 'Intermedia', 'Photo', 'A&G', 'Layout', 'Web'];
const STATUSES = ['Newbie', 'Probie', 'Regular', 'EB'];

// Stored with its @ however it was typed — "ana", "@ana" and " @ana " are the
// same handle. Null when it isn't one: Telegram allows letters, digits and
// underscores, up to 32 of them.
function telegramHandle(text) {
  const name = String(text || '').trim().replace(/^@+/, '');
  return /^[A-Za-z0-9_]{1,32}$/.test(name) ? '@' + name : null;
}

// A submitted form -> { person } ready to save, or { error } to show.
function readPerson(body) {
  const field = (key) => String((body && body[key]) || '').trim();
  const person = {
    name: field('name'),
    student_id: field('student_id'),
    section: field('section'),
    status: field('status'),
    telegram: telegramHandle(field('telegram')),
  };
  if (!person.name) return { error: 'A name is required.' };
  if (!person.student_id) return { error: 'An ID number is required.' };
  if (!SECTIONS.includes(person.section)) return { error: 'Pick a section.' };
  if (!STATUSES.includes(person.status)) return { error: 'Pick a status.' };
  if (!person.telegram) {
    return { error: 'A Telegram handle is required — letters, digits and underscores only.' };
  }
  return { person };
}

module.exports = { SECTIONS, STATUSES, telegramHandle, readPerson };
