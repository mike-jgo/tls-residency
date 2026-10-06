'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, IDLE_MS } = require('../lib/auth');

function browser() {
  const req = { headers: {}, secure: false };
  const res = {
    cookie(name, value, options) {
      assert.equal(options.httpOnly, true);
      assert.equal(options.sameSite, 'strict');
      req.headers.cookie = `${name}=${value}`;
    },
    clearCookie() { delete req.headers.cookie; },
  };
  return { req, res };
}

test('login accepts a colon password, rejects wrong credentials and ignores cached Basic auth', () => {
  const auth = createAuth({ user: 'admin', password: 'correct:password' });
  const { req, res } = browser();
  req.headers.authorization = 'Basic ' + Buffer.from('admin:correct:password').toString('base64');
  assert.equal(auth.authenticated(req), false);
  assert.equal(auth.login(req, res, 'admin', 'wrong'), false);
  assert.equal(auth.login(req, res, 'wrong', 'correct:password'), false);
  assert.equal(auth.login(req, res, 'admin', 'correct:password'), true);
  assert.equal(auth.authenticated(req), true);
});

test('logging out revokes the session even if someone retains its cookie', () => {
  const auth = createAuth({ user: 'admin', password: 'secret' });
  const { req, res } = browser();
  auth.login(req, res, 'admin', 'secret');
  const oldCookie = req.headers.cookie;
  auth.logout(req, res);
  req.headers.cookie = oldCookie;
  assert.equal(auth.authenticated(req), false);
});

test('sessions expire after inactivity and are lost on server restart', () => {
  let at = 0;
  const auth = createAuth({ user: 'admin', password: 'secret', now: () => at });
  const { req, res } = browser();
  auth.login(req, res, 'admin', 'secret');
  at = IDLE_MS - 1;
  assert.equal(auth.authenticated(req), true);
  at += IDLE_MS;
  assert.equal(auth.authenticated(req), false);
  auth.login(req, res, 'admin', 'secret');
  assert.equal(createAuth({ user: 'admin', password: 'secret' }).authenticated(req), false);
});

test('a new login rotates the cookie and invalidates the old session', () => {
  const auth = createAuth({ user: 'admin', password: 'secret' });
  const { req, res } = browser();
  auth.login(req, res, 'admin', 'secret');
  const oldCookie = req.headers.cookie;
  auth.login(req, res, 'admin', 'secret');
  assert.notEqual(req.headers.cookie, oldCookie);
  assert.equal(auth.authenticated({ headers: { cookie: oldCookie } }), false);
});
