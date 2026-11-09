'use strict';

/*
 * The tap screen's background: a picture chosen on the admin site, shown
 * behind the panels, whose opacity is set with a slider.
 *
 * The picture is kept as a file beside the database rather than in it, so the
 * twice-daily backups don't each carry a copy. What kind of picture it is, its
 * version (for the browser's cache) and the opacity live in the meta table.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_OPACITY = 85; // percent: the panels' opacity — the picture shows through a little

// Only what every browser shows, told apart by the file's first bytes — not by
// whatever the upload claims to be.
function imageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

// A whole number from 0 to 100, or null when it isn't a number at all.
function parseOpacity(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.min(100, Math.round(Number(s)));
}

function createAppearance({ store, dir }) {
  const file = path.join(dir, 'background.img');

  function settings() {
    const type = store.getMeta('bg_type');
    const opacity = parseOpacity(store.getMeta('bg_opacity'));
    return {
      image: type && fs.existsSync(file) ? { type, version: store.getMeta('bg_version') || '0' } : null,
      opacity: opacity === null ? DEFAULT_OPACITY : opacity,
    };
  }

  // Written to a temporary name and renamed, so a tap screen loading the
  // picture mid-upload gets the old one or the new one, never half of one.
  function setImage(buf) {
    if (!buf || !buf.length) throw new Error('No picture was sent.');
    if (buf.length > MAX_BYTES) throw new Error('That picture is too big (8 MB at most).');
    const type = imageType(buf);
    if (!type) throw new Error('That isn’t a PNG, JPEG, WebP or GIF picture.');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    store.setMeta('bg_type', type);
    store.setMeta('bg_version', String(Date.now()));
  }

  function removeImage() {
    fs.rmSync(file, { force: true });
    store.setMeta('bg_type', '');
  }

  function setOpacity(value) {
    const opacity = parseOpacity(value);
    if (opacity === null) throw new Error('Opacity must be a number from 0 to 100.');
    store.setMeta('bg_opacity', String(opacity));
  }

  return { settings, setImage, removeImage, setOpacity, file };
}

module.exports = { createAppearance, imageType, parseOpacity, MAX_BYTES, DEFAULT_OPACITY };
