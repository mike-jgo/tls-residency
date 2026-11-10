'use strict';

/*
 * How the Pi's tabs look: green header rows in The LaSallian's colour, and on
 * the Search tab a box that looks like somewhere to type. Applied once to
 * each tab (lib/sync.js keeps count), so anything restyled by hand afterwards
 * stays restyled.
 *
 * styleFor() describes a tab for the client's formatTabs. Rows and columns
 * are counted from 0, and a pair is [first, one past the last].
 */

const dates = require('./dates');
const search = require('./search');

// Raise this to restyle every tab once more.
const VERSION = 3;

const rgb = (hex) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
});
const GREEN = rgb('#054805');
const PALE = rgb('#e4f6ec');
const WHITE = rgb('#ffffff');
const GREY = rgb('#647082');

const HEADER = { backgroundColor: GREEN, textFormat: { bold: true, foregroundColor: WHITE } };
const BOLD = { textFormat: { bold: true } };
const edge = { style: 'SOLID_MEDIUM', color: GREEN };

// Room around the text in every cell of a tab, in pixels.
const ROOMY = { format: { padding: { top: 4, right: 10, bottom: 4, left: 10 } } };

const header = (row, columns) => ({ rows: [row, row + 1], columns: [0, columns], format: HEADER });

const SEARCH = {
  frozen: 4,
  // The box: B1, made three columns wide.
  merges: [{ rows: [0, 1], columns: [1, 4] }],
  cells: [
    ROOMY,
    { rows: [0, 1], columns: [0, 1], format: { textFormat: { bold: true, fontSize: 12 }, horizontalAlignment: 'RIGHT', verticalAlignment: 'MIDDLE' } },
    {
      rows: [0, 1], columns: [1, 4],
      format: {
        backgroundColor: PALE, textFormat: { bold: true, fontSize: 14 }, verticalAlignment: 'MIDDLE',
        borders: { top: edge, bottom: edge, left: edge, right: edge },
      },
    },
    { rows: [0, 1], columns: [4, 5], format: { textFormat: { italic: true, foregroundColor: GREY }, verticalAlignment: 'MIDDLE' } },
    // The three tables' titles, then their header rows: A-H, J-O, Q-V.
    { rows: [2, 3], columns: [0, search.COLUMNS], format: { textFormat: { bold: true, fontSize: 12, foregroundColor: GREEN } } },
    { rows: [3, 4], columns: [0, 8], format: HEADER },
    { rows: [3, 4], columns: [9, 15], format: HEADER },
    { rows: [3, 4], columns: [16, 22], format: HEADER },
  ],
  heights: [{ rows: [0, 1], pixels: 36 }],
  widths: [
    { columns: [0, search.COLUMNS], pixels: 110 },
    { columns: [0, 1], pixels: 210 },   // Month, and the box's label in full
    { columns: [1, 2], pixels: 200 },   // the names, in each table
    { columns: [9, 10], pixels: 200 },
    { columns: [19, 20], pixels: 200 },
    { columns: [8, 9], pixels: 30 },    // the gaps between the tables
    { columns: [15, 16], pixels: 30 },
  ],
};

function styleFor(title, { totalsTab, staffersTab }) {
  if (title === search.TAB) return SEARCH;
  // Staffers is other people's to format; it gets only this to start with.
  if (title === staffersTab) return { frozen: 1, cells: [ROOMY, header(0, 7)] };
  if (title === totalsTab) {
    return { cells: [ROOMY, { rows: [0, 2], columns: [0, 1], format: BOLD }, header(2, 7)] };
  }
  if (!dates.MONTH_TAB_RE.test(title)) return null;
  return { cells: [ROOMY, header(0, title.endsWith(' Logs') ? 6 : 7)] };
}

module.exports = { styleFor, VERSION };
