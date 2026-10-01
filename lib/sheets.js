'use strict';

/*
 * The few Google Sheets calls the sync needs, signed in as a service account.
 *
 * No Google library: a service account signs a short JWT with its private key,
 * swaps it for an access token, and the rest is three plain HTTPS calls.
 *
 * Every write names the exact cells it fills (never "append"), so sending the
 * same write twice leaves the sheet as it was — see lib/sync.js.
 *
 * Errors carry `offline: true` when Google couldn't be reached at all, as
 * opposed to reached and refused. The admin site shows those differently:
 * one needs the wifi back, the other needs someone to fix something.
 */

const fs = require('fs');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

// A new tab. Writing outside a tab's grid is an error, so make it big enough
// for a month: far more rows than a month of taps.
const TAB_ROWS = 10000;
const TAB_COLUMNS = 8;

// The setting is meant to hold the spreadsheet's ID, but the thing people have
// to hand is its address — accept either.
function spreadsheetIdFrom(text) {
  const value = String(text || '').trim();
  const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(value);
  return match ? match[1] : value;
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function createSheetsClient({
  spreadsheetId, keyFile, fetch = globalThis.fetch, now = Date.now, timeoutMs = 15000,
}) {
  let token = null; // { value, expiresAt }

  async function request(url, options) {
    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const why = (e.cause && e.cause.code) || e.name || e.message;
      throw Object.assign(new Error(`Could not reach Google (${why}).`), { offline: true });
    }
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON — reported below */ }
    if (!res.ok) {
      const detail = (body.error && (body.error.message || body.error_description)) || body.error || text;
      if (res.status === 401) token = null;
      throw Object.assign(new Error(`Google refused (${res.status}): ${String(detail).slice(0, 300)}`),
        { offline: false });
    }
    return body;
  }

  // The key file is read when first needed, so a missing or broken one shows
  // up as a sync failure in the admin site instead of stopping the server.
  function readKey() {
    try {
      const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      if (!key.client_email || !key.private_key) throw new Error('it has no client_email or private_key');
      return key;
    } catch (e) {
      throw Object.assign(new Error(`Can't use the service account key ${keyFile} — ${e.message}`),
        { offline: false });
    }
  }

  async function accessToken() {
    if (token && now() < token.expiresAt) return token.value;
    const key = readKey();
    const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(now() / 1000);
    const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' +
      b64({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 });
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');

    const body = await request(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: unsigned + '.' + signature,
      }).toString(),
    });
    // Renew a minute early rather than have a call fail on the boundary.
    token = { value: body.access_token, expiresAt: now() + (Number(body.expires_in || 3600) - 60) * 1000 };
    return token.value;
  }

  async function call(method, path, payload) {
    const headers = { Authorization: `Bearer ${await accessToken()}` };
    if (payload) headers['Content-Type'] = 'application/json';
    return request(`${API}/${encodeURIComponent(spreadsheetId)}${path}`, {
      method, headers, body: payload ? JSON.stringify(payload) : undefined,
    });
  }

  return {
    spreadsheetId,

    // Titles of the tabs the spreadsheet has now.
    async listTabs() {
      const body = await call('GET', '?fields=sheets.properties.title');
      return (body.sheets || []).map((s) => s.properties.title);
    },

    async addTabs(titles) {
      await call('POST', ':batchUpdate', {
        requests: titles.map((title) => ({
          addSheet: { properties: { title, gridProperties: { rowCount: TAB_ROWS, columnCount: TAB_COLUMNS } } },
        })),
      });
    },

    // data: [{ range: "'October-2026'!A1:B2", values: [[...], ...] }]
    // RAW, so a name beginning with "=" is stored as text, not run as a formula.
    async writeRanges(data) {
      await call('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data });
    },

    // Empty these ranges, e.g. "'October 2026 Logs'!A2:G".
    async clearRanges(ranges) {
      await call('POST', '/values:batchClear', { ranges });
    },
  };
}

module.exports = { createSheetsClient, spreadsheetIdFrom };
