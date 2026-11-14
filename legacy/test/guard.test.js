'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sameOrigin } = require('../lib/guard');

// ---- sameOrigin ----------------------------------------------------------

test('our own pages may post', () => {
  assert.ok(sameOrigin({ host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }));
  // Over the office LAN there is no Sec-Fetch-Site (plain http), only Origin.
  assert.ok(sameOrigin({ host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' }));
});

test('another site may not', () => {
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'http://untrusted.example', 'sec-fetch-site': 'cross-site' }));
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'http://untrusted.example' }));
  // Another port on this computer is another site.
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'http://localhost:8080', 'sec-fetch-site': 'same-site' }));
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'http://localhost:8080' }));
  assert.ok(!sameOrigin({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }));
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'null' }));
});

test('a request with neither header is not from a browser, and may', () => {
  assert.ok(sameOrigin({ host: 'localhost:3000' }));
});

test('another site may not', () => {
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'http://untrusted.example', 'sec-fetch-site': 'cross-site' }));
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'http://untrusted.example' }));
  // Another port on this computer is another site.
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'http://localhost:8080', 'sec-fetch-site': 'same-site' }));
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'http://localhost:8080' }));
  assert.ok(!sameOrigin({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }));
  assert.ok(!sameOrigin({ host: 'localhost:3000', origin: 'null' }));
});

test('a request with neither header is not from a browser, and may', () => {
  assert.ok(sameOrigin({ host: 'localhost:3000' }));
});
