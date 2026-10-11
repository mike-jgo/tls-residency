'use strict';

/*
 * The few Google Sheets calls the sync needs, signed in as a service account.
 *
 * No Google library: a service account signs a short JWT with its private key,
 * swaps it for an access token, and the rest is a few plain HTTPS calls.
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
const TAB_COLUMNS = 9;

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

    // The tabs, with what dressTabs needs to know: [{ title, sheetId, views }],
    // `views` being the titles of the filter views each has.
    async describeTabs() {
      const body = await call('GET', '?fields=sheets(properties(sheetId,title),filterViews(title))');
      return (body.sheets || []).map((s) => ({
        title: s.properties.title,
        sheetId: s.properties.sheetId,
        views: (s.filterViews || []).map((v) => v.title),
      }));
    },

    async addTabs(titles, columns = TAB_COLUMNS) {
      await call('POST', ':batchUpdate', {
        requests: titles.map((title) => ({
          addSheet: { properties: { title, gridProperties: { rowCount: TAB_ROWS, columnCount: columns } } },
        })),
      });
    },

    // Freeze header rows and add filter views:
    //   [{ sheetId, frozen, views: [{ title, headerRow, columns, sort }] }]
    // A view covers `columns` columns from `headerRow` (0 = row 1) down, and
    // `sort` is [column, 'ASCENDING' | 'DESCENDING'] or null. A filter view
    // sorts and filters for whoever opens it and moves no cells — unlike
    // sorting the tab itself, which would put the next upload on wrong rows.
    async dressTabs(tabs) {
      const requests = [];
      for (const { sheetId, frozen, views } of tabs) {
        requests.push({
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: frozen } },
            fields: 'gridProperties.frozenRowCount',
          },
        });
        for (const { title, headerRow, columns, sort } of views) {
          requests.push({
            addFilterView: {
              filter: {
                title,
                range: { sheetId, startRowIndex: headerRow, startColumnIndex: 0, endColumnIndex: columns },
                sortSpecs: sort ? [{ dimensionIndex: sort[0], sortOrder: sort[1] }] : [],
              },
            },
          });
        }
      }
      await call('POST', ':batchUpdate', { requests });
    },

    // data: [{ range: "'October-2026'!A1:B2", values: [[...], ...] }]
    // RAW, so a name beginning with "=" is stored as text, not run as a formula.
    async writeRanges(data) {
      await call('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data });
    },

    // How tabs look — see lib/style.js for the shape of `list`. Rows and
    // columns count from 0; a pair is [first, one past the last], and a cell
    // format with neither covers the whole tab.
    async formatTabs(list) {
      const requests = [];
      for (const { sheetId, frozen, merges = [], cells = [], widths = [], heights = [] } of list) {
        const box = ({ rows, columns }) => (rows ? {
          sheetId, startRowIndex: rows[0], endRowIndex: rows[1], startColumnIndex: columns[0], endColumnIndex: columns[1],
        } : { sheetId });
        const size = (dimension, [startIndex, endIndex], pixelSize) => ({
          updateDimensionProperties: {
            range: { sheetId, dimension, startIndex, endIndex }, properties: { pixelSize }, fields: 'pixelSize',
          },
        });
        if (frozen) {
          requests.push({
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: frozen } },
              fields: 'gridProperties.frozenRowCount',
            },
          });
        }
        for (const m of merges) requests.push({ mergeCells: { range: box(m), mergeType: 'MERGE_ALL' } });
        for (const c of cells) {
          requests.push({
            repeatCell: {
              range: box(c),
              cell: { userEnteredFormat: c.format },
              fields: `userEnteredFormat(${Object.keys(c.format).join(',')})`,
            },
          });
        }
        for (const w of widths) requests.push(size('COLUMNS', w.columns, w.pixels));
        for (const h of heights) requests.push(size('ROWS', h.rows, h.pixels));
      }
      await call('POST', ':batchUpdate', { requests });
    },

    // Make every column of these tabs as wide as its longest cell.
    async fitColumns(sheetIds) {
      await call('POST', ':batchUpdate', {
        requests: sheetIds.map((sheetId) => ({
          autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS' } },
        })),
      });
    },

    // Like writeRanges, but a value beginning with "=" is a formula. Only for
    // text this program wrote itself, never anything a person typed.
    async writeFormulas(data) {
      await call('POST', '/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data });
    },

    // The cells of a range, as rows of text. Google leaves off empty rows at
    // the bottom and empty cells at the end of a row.
    async readRange(range) {
      const body = await call('GET', `/values/${encodeURIComponent(range)}`);
      return body.values || [];
    },

    // Several ranges in one request: their cells, in the order asked for.
    async readRanges(ranges) {
      if (!ranges.length) return [];
      const query = ranges.map((range) => `ranges=${encodeURIComponent(range)}`).join('&');
      const body = await call('GET', `/values:batchGet?${query}`);
      return (body.valueRanges || []).map((v) => v.values || []);
    },

    // Get a tab ready to be typed in: at least `columns` wide, and with
    // dropdowns from row 2 down — { C: ['a', 'b'], ... }.
    async shapeTab(title, { columns, dropdowns }) {
      const body = await call('GET', '?fields=sheets.properties(sheetId,title,gridProperties.columnCount)');
      const { sheetId, gridProperties } = (body.sheets || []).find((s) => s.properties.title === title).properties;
      const requests = Object.entries(dropdowns).map(([letter, values]) => {
        const column = letter.charCodeAt(0) - 65;
        return {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: column, endColumnIndex: column + 1 },
            rule: {
              condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
              showCustomUi: true, strict: true,
            },
          },
        };
      });
      if (gridProperties.columnCount < columns) {
        requests.unshift({
          appendDimension: { sheetId, dimension: 'COLUMNS', length: columns - gridProperties.columnCount },
        });
      }
      await call('POST', ':batchUpdate', { requests });
    },

    // Take columns out of a tab, with whatever is in them; the ones after
    // move left. Columns count from 0: [first, one past the last].
    async deleteColumns(title, [startIndex, endIndex]) {
      const body = await call('GET', '?fields=sheets.properties(sheetId,title)');
      const { sheetId } = (body.sheets || []).find((s) => s.properties.title === title).properties;
      await call('POST', ':batchUpdate', {
        requests: [{ deleteDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex, endIndex } } }],
      });
    },

    // Empty these ranges, e.g. "'October 2026 Logs'!A2:H".
    async clearRanges(ranges) {
      await call('POST', '/values:batchClear', { ranges });
    },
  };
}

module.exports = { createSheetsClient, spreadsheetIdFrom };
