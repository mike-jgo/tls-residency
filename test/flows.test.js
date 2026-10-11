'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const views = require('../views');

const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

// Exercise the actual inline station script with controlled network failures
// and keyboard events. Browser layout is checked separately in Chrome.
function station({ storage = {}, fetch = async () => ({ ok: true, json: async () => ({ status: 'unknown', rfid: '123' }) }) } = {}) {
  const listeners = {}, elements = {}, sent = [];
  let stream;
  const document = {
    activeElement: null,
    hasFocus: () => true,
    createElement: node,
    createTextNode: (text) => node('text', text),
    getElementById: (id) => elements[id] || (elements[id] = node('div')),
  };
  function node(tag, text = '') {
    let ownText = text;
    const n = {
      tag, children: [], style: {}, className: '',
      appendChild(child) { this.children.push(child); return child; },
      focus() { document.activeElement = this; },
      querySelectorAll(kind) {
        return this.children.flatMap((c) => [...(c.tag === kind ? [c] : []), ...c.querySelectorAll(kind)]);
      },
      get textContent() { return ownText + this.children.map((c) => c.textContent).join(' '); },
      set textContent(value) { ownText = value; this.children = []; },
    };
    n.classList = {
      contains: (name) => n.className.split(' ').includes(name),
      add: (name) => { n.className += ' ' + name; },
      remove: (name) => { n.className = n.className.split(' ').filter((c) => c !== name).join(' '); },
    };
    return n;
  }
  const context = {
    document, Date, JSON, Object, AbortController, crypto: { randomUUID },
    performance: { now: () => 1 },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    sessionStorage: { getItem: (key) => storage[key], setItem: (key, value) => { storage[key] = value; } },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    EventSource: class {
      constructor() { stream = this; }
      addEventListener(name, fn) { this[name] = fn; }
    },
    fetch: async (url, options) => { sent.push({ url, ...options }); return fetch(url, options); },
  };
  document.getElementById('shut').appendChild(document.getElementById('shut-body'));
  vm.runInNewContext(scripts(views.stationPage({ readerOnly: false }))[0], context);
  const key = (value, shiftKey = false) => {
    const event = { key: value, shiftKey, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    listeners.keydown(event);
    return event;
  };
  const tap = (card) => { for (const digit of card) key(digit); key('Enter'); };
  return { key, tap, elements, sent, storage, document, stream };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a lost tap response keeps its receipt across reload and safely reuses it', async () => {
  const storage = {};
  const first = station({ storage, fetch: async () => { throw new Error('reply lost'); } });
  first.tap('123');
  await settle();
  const request = JSON.parse(first.sent[0].body);
  assert.match(first.elements.main.textContent, /Not confirmed yet/);
  assert.doesNotMatch(first.elements.main.textContent, /Not recorded/);
  const retry = station({ storage, fetch: async () => ({ ok: true, json: async () => ({
    status: 'ok', direction: 'in', name: 'Test user', time: '2026-10-06T01:00:00.000Z', replayed: true,
  }) }) });
  retry.tap('123');
  await settle();
  assert.equal(JSON.parse(retry.sent[0].body).requestId, request.requestId);
  assert.match(retry.elements.main.textContent, /Tap confirmed/);
  assert.match(retry.elements.main.textContent, /No second tap was recorded/);
  assert.deepEqual(JSON.parse(storage['residency-pending-taps']), {});
});

test('plain Enter works but an oversized scanner burst cannot press a focused button', () => {
  const page = station();
  assert.equal(page.key('Enter').prevented, false);
  for (let i = 0; i < 65; i++) page.key('1');
  assert.equal(page.key('Enter').prevented, true);
  assert.equal(page.sent.length, 0);
  assert.equal(page.key('Enter').prevented, false);
});

test('shutdown keeps keyboard focus inside the dialog and restores it on Escape', () => {
  const page = station();
  page.stream.status({ data: JSON.stringify({ clockReady: true, currentlyIn: [], sync: null }) });
  page.elements['shut-open'].onclick();
  const buttons = page.elements['shut-body'].querySelectorAll('button');
  assert.equal(page.document.activeElement, buttons[0]);
  assert.equal(page.key('Tab', true).prevented, true);
  assert.equal(page.document.activeElement, buttons[1]);
  assert.equal(page.key('Tab').prevented, true);
  assert.equal(page.document.activeElement, buttons[0]);
  page.key('Escape');
  assert.equal(page.document.activeElement, page.elements['shut-open']);
});

test('a disconnected shutdown dialog does not offer a destructive action', () => {
  const page = station();
  page.elements['shut-open'].onclick();
  const buttons = page.elements['shut-body'].querySelectorAll('button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Cancel']);
  assert.match(page.elements['shut-body'].textContent, /Checking attendance/);
});

test('idle return saves a draft and restores it after returning to the form', () => {
  const storage = {};
  function page() {
    const events = {}, timers = [], notes = [], fields = { name: { value: '' }, telegram: { value: '' } };
    const form = {
      getAttribute: () => '/register', elements: { namedItem: (name) => fields[name] },
      addEventListener: (type, fn) => { events[type] = fn; }, before(note) { notes.push(note); },
      querySelectorAll: () => [],
      reset() { for (const field of Object.values(fields)) field.value = ''; },
    };
    const location = { pathname: '/register', search: '', href: '/register' };
    const context = {
      location, Object, JSON, URLSearchParams,
      window: { addEventListener() {} },
      document: { querySelector: (sel) => (sel === 'form.scanbox' ? form : null), querySelectorAll: () => [], createElement: () => ({
        setAttribute() {}, appendChild(child) { this.child = child; }, remove() { notes.length = 0; },
      }) },
      sessionStorage: {
        getItem: (key) => storage[key], setItem: (key, value) => { storage[key] = value; },
        removeItem: (key) => { delete storage[key]; },
      },
      FormData: class { *[Symbol.iterator]() { for (const [name, field] of Object.entries(fields)) yield [name, field.value]; } },
      setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
    };
    vm.createContext(context);
    // The form-specific script precedes the two shared layout scripts.
    for (const script of scripts(views.registerPage({})).slice(-2)) vm.runInContext(script, context);
    return { fields, events, timers, location, notes };
  }
  const first = page();
  first.fields.name.value = 'Waiting for wifi'; first.fields.telegram.value = '@draft';
  first.events.input();
  first.timers.find((t) => t.delay === 120000).fn();
  assert.equal(first.location.href, '/station');
  const restored = page();
  assert.equal(restored.fields.name.value, 'Waiting for wifi');
  assert.equal(restored.fields.telegram.value, '@draft');

  // On the shared computer the restored details may be somebody else's.
  assert.match(restored.notes[0].textContent, /restored/);
  restored.notes[0].child.onclick();
  assert.equal(restored.fields.name.value, '');
  assert.equal(restored.notes.length, 0);
  assert.equal(page().notes.length, 0, 'and it stays discarded');
});

test('attendance is not shown as empty before or after a lost live connection', () => {
  const page = station();
  assert.match(page.elements['in-list'].textContent, /Waiting/);
  page.stream.status({ data: JSON.stringify({ clockReady: true, currentlyIn: [], sync: null }) });
  assert.match(page.elements['in-list'].textContent, /Nobody/);
  page.stream.onerror();
  assert.match(page.elements['in-list'].textContent, /Waiting/);
  assert.match(page.elements.main.textContent, /Connecting/);
});

test('offline registration and admin errors retain their forms and every draft field', () => {
  const person = { id: 1, name: 'Draft Test', student_id: 'DRAFT01', section: 'Web', status: 'Regular', telegram: '@draft', rfid: '123' };
  for (const html of [
    views.registerPage({ online: false, draft: true, prefill: person }),
    views.usersPage({ users: [], online: false, draft: true, editing: person, local: true }),
  ]) {
    for (const field of ['name', 'student_id', 'telegram', 'rfid']) assert.ok(html.includes(`value="${person[field]}"`));
    assert.match(html, /<option selected>Web<\/option>/);
    assert.match(html, /<option selected>Regular<\/option>/);
    assert.match(html, /<form method="post"/);
  }
});

test('all generated page scripts parse', () => {
  for (const html of [
    views.loginPage({ local: true }), views.registerPage({}),
    views.usersPage({ users: [], local: true }),
    views.dashboardPage({ currentlyIn: [], local: true }),
    views.hoursPage({ report: [], local: true }), views.stationPage(),
  ]) for (const script of scripts(html)) new vm.Script(script);
});
