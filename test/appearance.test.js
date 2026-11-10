'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppearance, imageType, parseOpacity, DEFAULT_OPACITY, MAX_BYTES } = require('../lib/appearance');
const views = require('../views');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);

function setup() {
  const meta = {};
  const store = { getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'residency-bg-'));
  return { meta, dir, appearance: createAppearance({ store, dir }) };
}

test('imageType goes by the file’s first bytes', () => {
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(JPEG), 'image/jpeg');
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(imageType(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(imageType(Buffer.alloc(4)), null);
  assert.equal(imageType('not a buffer'), null);
});

test('parseOpacity keeps 0 to 100 and refuses anything else', () => {
  assert.equal(parseOpacity('40'), 40);
  assert.equal(parseOpacity('0'), 0);
  assert.equal(parseOpacity('250'), 100);
  assert.equal(parseOpacity('33.6'), 34);
  assert.equal(parseOpacity('-5'), null);
  assert.equal(parseOpacity('abc'), null);
  assert.equal(parseOpacity(''), null);
  assert.equal(parseOpacity(undefined), null);
});

test('no picture until one is set, at the default opacity', () => {
  const { appearance } = setup();
  assert.deepEqual(appearance.settings(), { image: null, opacity: DEFAULT_OPACITY, theme: 'none' });
});

test('a picture is stored beside the database and versioned', () => {
  const { appearance, dir } = setup();
  appearance.setImage(PNG);
  const s = appearance.settings();
  assert.equal(s.image.type, 'image/png');
  assert.ok(s.image.version);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'background.img')), PNG);
  assert.equal(fs.existsSync(path.join(dir, 'background.img.tmp')), false);

  appearance.setImage(JPEG);
  assert.equal(appearance.settings().image.type, 'image/jpeg');
});

test('what isn’t a picture, or is too big, is refused and the old one kept', () => {
  const { appearance } = setup();
  appearance.setImage(PNG);
  assert.throws(() => appearance.setImage(Buffer.from('#!/bin/sh\necho hi\n')), /isn.t a PNG/);
  assert.throws(() => appearance.setImage(Buffer.alloc(0)), /No picture/);
  assert.throws(() => appearance.setImage(Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)])), /too big/);
  assert.equal(appearance.settings().image.type, 'image/png');
});

test('removing the picture keeps the opacity', () => {
  const { appearance, dir } = setup();
  appearance.setImage(PNG);
  appearance.setOpacity('60');
  appearance.removeImage();
  assert.deepEqual(appearance.settings(), { image: null, opacity: 60, theme: 'none' });
  assert.equal(fs.existsSync(path.join(dir, 'background.img')), false);
  appearance.removeImage(); // twice is fine
});

test('a bad opacity is refused and the old one kept', () => {
  const { appearance } = setup();
  appearance.setOpacity('20');
  assert.throws(() => appearance.setOpacity('lots'), /0 to 100/);
  assert.equal(appearance.settings().opacity, 20);
});

test('a missing file reads as no picture', () => {
  const { appearance } = setup();
  appearance.setImage(PNG);
  fs.rmSync(appearance.file);
  assert.equal(appearance.settings().image, null);
});

test('the tap screen shows the picture behind panels at their opacity', () => {
  const html = views.stationPage({ background: { image: { type: 'image/png', version: '123' }, opacity: 40 } });
  assert.match(html, /<body style="--card:40%"/);
  assert.match(html, /<div id="bg"[^>]*style="background-image:url\('\/background\?v=123'\)"/);
  const plain = views.stationPage();
  assert.match(plain, /<body style="--card:100%"/);
  assert.doesNotMatch(plain, /background-image:url\('\/background/);
});

test('the appearance page shows the slider at the saved value', () => {
  const html = views.appearancePage({ image: null, opacity: 55, local: false, sync: null });
  assert.match(html, /<input id="bg-opacity" name="opacity" type="range"[^>]*value="55"/);
  assert.match(html, /No picture yet/);
  assert.doesNotMatch(html, /Remove picture/);
  const withImage = views.appearancePage({ image: { type: 'image/png', version: '9' }, opacity: 55, local: false, sync: null });
  assert.match(withImage, /Remove picture/);
  assert.match(withImage, /\/background\?v=9/);
});

test('the rankings show until hidden, and come back when shown again', () => {
  const { appearance } = setup();
  assert.equal(appearance.rankingsHidden(), false);
  appearance.setRankingsHidden(true);
  assert.equal(appearance.rankingsHidden(), true);
  appearance.setRankingsHidden(false);
  assert.equal(appearance.rankingsHidden(), false);
});

test('the appearance page offers to hide or show the rankings', () => {
  const page = (rankingsHidden) => views.appearancePage({ image: null, opacity: 85, rankingsHidden });
  assert.match(page(false), /name="rankings" value="hide"/);
  assert.match(page(true), /name="rankings" value="show"/);
});

test('a season is one of the listed themes, and a bad one keeps the old', () => {
  const { appearance } = setup();
  appearance.setTheme('christmas');
  assert.equal(appearance.settings().theme, 'christmas');
  assert.throws(() => appearance.setTheme('halloween'), /listed seasons/);
  assert.throws(() => appearance.setTheme('__proto__'), /listed seasons/);
  assert.equal(appearance.settings().theme, 'christmas');
  appearance.setTheme('none');
  assert.equal(appearance.settings().theme, 'none');
});

test('the tap screen wears the season, and the admin page offers it', () => {
  const html = views.stationPage({ background: { image: null, opacity: 85, theme: 'christmas' } });
  assert.match(html, /<body [^>]*class="theme-christmas"/);
  assert.match(html, /<div id="lights"/);
  // The snow is a couple of sliding pictures, not an element per flake, and
  // the lights stay still: on the Pi 3 the old snowfall and twinkling kept a
  // core busy all day.
  const snow = html.match(/<div id="snow"[^>]*>(.*?)<\/div>/);
  assert.ok(snow, 'the snow is on the page');
  assert.ok((snow[1].match(/<b /g) || []).length <= 2);
  assert.doesNotMatch(html, /createElement\('i'\)|@keyframes twinkle/);
  assert.match(views.stationPage(), /<body [^>]*class="theme-none"/);
  const admin = views.appearancePage({ image: null, opacity: 85, theme: 'christmas', local: false, sync: null });
  assert.match(admin, /<option value="christmas" selected>Christmas<\/option>/);
});
