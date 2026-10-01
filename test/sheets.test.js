'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSheetsClient } = require('../lib/sheets');

// A throwaway service account: a real key pair, so the signature can be
// checked the way Google checks it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'residency-sheets-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const keyFile = path.join(tmp, 'service-account.json');
fs.writeFileSync(keyFile, JSON.stringify({
  client_email: 'pi@example.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.googleapis.com/token',
}));

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignored */ }
});

const reply = (status, body) => ({
  ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body),
});

// Answers the token exchange, records everything, and hands API calls to `api`.
function fakeGoogle(api = () => reply(200, {})) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (url.includes('oauth2')) return reply(200, { access_token: 'token-' + calls.length, expires_in: 3600 });
    return api(url, options);
  };
  return { fetch, calls };
}

test('it signs in as the service account with a JWT Google can verify', async () => {
  const google = fakeGoogle(() => reply(200, { sheets: [{ properties: { title: 'Totals' } }] }));
  const now = Date.UTC(2026, 9, 1);
  const client = createSheetsClient({ spreadsheetId: 'abc', keyFile, fetch: google.fetch, now: () => now });

  assert.deepStrictEqual(await client.listTabs(), ['Totals']);

  const [tokenCall, apiCall] = google.calls;
  const params = new URLSearchParams(tokenCall.body);
  assert.strictEqual(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims, signature] = params.get('assertion').split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url'));
  assert.deepStrictEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
    iss: 'pi@example.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now / 1000,
    exp: now / 1000 + 3600,
  });
  assert.strictEqual(apiCall.headers.Authorization, 'Bearer token-1');
  assert.match(apiCall.url, /\/spreadsheets\/abc\?fields=/);
});

test('the access token is reused until it is about to expire', async () => {
  const google = fakeGoogle();
  let now = Date.UTC(2026, 9, 1);
  const client = createSheetsClient({ spreadsheetId: 'abc', keyFile, fetch: google.fetch, now: () => now });
  const tokenCalls = () => google.calls.filter((c) => c.url.includes('oauth2')).length;

  await client.listTabs();
  await client.listTabs();
  assert.strictEqual(tokenCalls(), 1);
  now += 3600 * 1000;
  await client.listTabs();
  assert.strictEqual(tokenCalls(), 2);
});

test('values are written to exact ranges, as plain text rather than formulas', async () => {
  const google = fakeGoogle();
  const client = createSheetsClient({ spreadsheetId: 'abc', keyFile, fetch: google.fetch });
  const data = [{ range: "'October 2026'!I2:N2", values: [[1, '2026-10-01', '09:00:00', '=EVIL()', '', 'IN']] }];
  await client.writeRanges(data);

  const call = google.calls[1];
  assert.match(call.url, /\/spreadsheets\/abc\/values:batchUpdate$/);
  assert.deepStrictEqual(JSON.parse(call.body), { valueInputOption: 'RAW', data });
});

test('new tabs are made big enough to write a month into', async () => {
  const google = fakeGoogle();
  const client = createSheetsClient({ spreadsheetId: 'abc', keyFile, fetch: google.fetch });
  await client.addTabs(['October 2026', 'Totals']);
  const { requests } = JSON.parse(google.calls[1].body);
  assert.deepStrictEqual(requests.map((r) => r.addSheet.properties.title), ['October 2026', 'Totals']);
  assert.ok(requests[0].addSheet.properties.gridProperties.rowCount >= 10000);
});

test('no network is reported as offline', async () => {
  const fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const client = createSheetsClient({ spreadsheetId: 'abc', keyFile, fetch });
  await assert.rejects(client.listTabs(), (e) => e.offline === true && /ENOTFOUND/.test(e.message));
});

test('a refusal from Google is not offline, and carries Google\'s reason', async () => {
  const google = fakeGoogle(() => reply(403, { error: { message: 'The caller does not have permission' } }));
  const client = createSheetsClient({ spreadsheetId: 'abc', keyFile, fetch: google.fetch });
  await assert.rejects(client.listTabs(),
    (e) => e.offline === false && /403/.test(e.message) && /does not have permission/.test(e.message));
});

test('a missing key file is a sync failure with a clear message, not a crash', async () => {
  const google = fakeGoogle();
  const client = createSheetsClient({ spreadsheetId: 'abc', keyFile: path.join(tmp, 'nope.json'), fetch: google.fetch });
  await assert.rejects(client.listTabs(), (e) => e.offline === false && /service account key/.test(e.message));
  assert.strictEqual(google.calls.length, 0);
});

test('the spreadsheet setting may be the ID or the whole address', () => {
  const { spreadsheetIdFrom } = require('../lib/sheets');
  assert.strictEqual(spreadsheetIdFrom('1AbC_d-9'), '1AbC_d-9');
  assert.strictEqual(spreadsheetIdFrom('https://docs.google.com/spreadsheets/d/1AbC_d-9/edit?gid=0#gid=0'), '1AbC_d-9');
  assert.strictEqual(spreadsheetIdFrom(undefined), '');
});
