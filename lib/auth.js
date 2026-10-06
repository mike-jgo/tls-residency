'use strict';

const { randomBytes, timingSafeEqual, createHash } = require('crypto');

const COOKIE = 'residency_admin';
const IDLE_MS = 30 * 60 * 1000;
const digest = (value) => createHash('sha256').update(String(value || '')).digest();

// Server-owned sessions can actually be revoked on the shared station. Basic
// auth cannot: the browser keeps sending the password after "logging out".
function createAuth({ user, password, now = Date.now }) {
  const sessions = new Map();
  const token = (req) => (req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  const cookieOptions = (req) => ({ httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });

  function logout(req, res) {
    sessions.delete(token(req));
    res.clearCookie(COOKIE, cookieOptions(req));
  }

  return {
    logout,
    login(req, res, name, pass) {
      if (!timingSafeEqual(digest(name), digest(user)) || !timingSafeEqual(digest(pass), digest(password))) return false;
      logout(req, res);
      for (const [id, until] of sessions) if (until <= now()) sessions.delete(id);
      const id = randomBytes(32).toString('hex');
      sessions.set(id, now() + IDLE_MS);
      res.cookie(COOKIE, id, cookieOptions(req));
      return true;
    },
    authenticated(req) {
      const id = token(req);
      if (!id || !sessions.has(id)) return false;
      if (sessions.get(id) <= now()) { sessions.delete(id); return false; }
      sessions.set(id, now() + IDLE_MS);
      return true;
    },
  };
}

module.exports = { createAuth, IDLE_MS };
