'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDecoder, createLineDecoder } = require('../lib/reader');

// Build one raw input_event for the given word size (8 = 64-bit, 4 = 32-bit).
function ev(word, type, code, value) {
  const b = Buffer.alloc(word * 2 + 8);
  b.writeUInt16LE(type, word * 2);
  b.writeUInt16LE(code, word * 2 + 2);
  b.writeInt32LE(value, word * 2 + 4);
  return b;
}

const CODE = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11 };

// What the reader sends for a card: press+release per digit, then Enter.
function typeCard(word, digits, enterCode = 28) {
  const parts = [];
  for (const ch of digits) {
    parts.push(ev(word, 1, CODE[ch], 1), ev(word, 1, CODE[ch], 0));
  }
  parts.push(ev(word, 1, enterCode, 1), ev(word, 1, enterCode, 0));
  return Buffer.concat(parts);
}

function collect(word) {
  const cards = [];
  return { cards, push: createDecoder((c) => cards.push(c), word) };
}

for (const [label, word] of [['64-bit (24-byte struct)', 8], ['32-bit (16-byte struct)', 4]]) {
  test(`decodes a card on ${label}`, () => {
    const { cards, push } = collect(word);
    push(typeCard(word, '0009182736'));
    assert.deepStrictEqual(cards, ['0009182736']);
  });

  test(`decodes consecutive taps on ${label}`, () => {
    const { cards, push } = collect(word);
    push(typeCard(word, '0009182736'));
    push(typeCard(word, '1234567890'));
    assert.deepStrictEqual(cards, ['0009182736', '1234567890']);
  });
}

test('reassembles events split across chunk boundaries', () => {
  const { cards, push } = collect(8);
  const buf = typeCard(8, '0009182736');
  // Worst case: one byte at a time, so every struct straddles a chunk.
  for (const byte of buf) push(Buffer.from([byte]));
  assert.deepStrictEqual(cards, ['0009182736']);
});

test('reassembles when a chunk splits mid-struct', () => {
  const { cards, push } = collect(8);
  const buf = typeCard(8, '0009182736');
  push(buf.subarray(0, 13)); // partway through the first event
  push(buf.subarray(13));
  assert.deepStrictEqual(cards, ['0009182736']);
});

test('ignores key releases and autorepeat', () => {
  const { cards, push } = collect(8);
  push(Buffer.concat([
    ev(8, 1, CODE['5'], 1), // press 5
    ev(8, 1, CODE['5'], 2), // autorepeat — must not double the digit
    ev(8, 1, CODE['5'], 0), // release
    ev(8, 1, 28, 1),
  ]));
  assert.deepStrictEqual(cards, ['5']);
});

test('ignores non-key events', () => {
  const { cards, push } = collect(8);
  push(Buffer.concat([
    ev(8, 0, 0, 0),         // EV_SYN separator, emitted after every key
    ev(8, 1, CODE['7'], 1),
    ev(8, 4, 4, 458756),    // EV_MSC scancode, which real readers also emit
    ev(8, 1, 28, 1),
  ]));
  assert.deepStrictEqual(cards, ['7']);
});

test('accepts keypad digits and keypad Enter', () => {
  const { cards, push } = collect(8);
  push(Buffer.concat([
    ev(8, 1, 82, 1), // KP0
    ev(8, 1, 79, 1), // KP1
    ev(8, 1, 96, 1), // KP_ENTER
  ]));
  assert.deepStrictEqual(cards, ['01']);
});

test('a bare Enter emits nothing', () => {
  const { cards, push } = collect(8);
  push(Buffer.concat([ev(8, 1, 28, 1), ev(8, 1, 28, 1)]));
  assert.deepStrictEqual(cards, []);
});

test('drops absurdly long input instead of buffering forever', () => {
  const { cards, push } = collect(8);
  for (let i = 0; i < 100; i++) push(ev(8, 1, CODE['1'], 1));
  push(ev(8, 1, 28, 1));
  // The run was discarded at the cap, so whatever survives is short.
  assert.strictEqual(cards.length <= 1, true);
  if (cards.length) assert.strictEqual(cards[0].length <= 64, true);
});

test('unmapped keys are skipped without breaking the number', () => {
  const { cards, push } = collect(8);
  push(Buffer.concat([
    ev(8, 1, CODE['4'], 1),
    ev(8, 1, 30, 1), // KEY_A — not part of a numeric card
    ev(8, 1, CODE['2'], 1),
    ev(8, 1, 28, 1),
  ]));
  assert.deepStrictEqual(cards, ['42']);
});

// ---- stdin path (Mac / non-Linux dev) -----------------------------------

function collectLines() {
  const cards = [];
  return { cards, push: createLineDecoder((c) => cards.push(c)) };
}

test('stdin: decodes one number per line', () => {
  const { cards, push } = collectLines();
  push('0009182736\n');
  assert.deepStrictEqual(cards, ['0009182736']);
});

test('stdin: handles CRLF and surrounding whitespace', () => {
  const { cards, push } = collectLines();
  push('  0009182736  \r\n');
  assert.deepStrictEqual(cards, ['0009182736']);
});

test('stdin: reassembles a number split across chunks', () => {
  const { cards, push } = collectLines();
  push('00091');
  push('82736');
  assert.deepStrictEqual(cards, []); // no newline yet
  push('\n');
  assert.deepStrictEqual(cards, ['0009182736']);
});

test('stdin: decodes multiple lines in one chunk', () => {
  const { cards, push } = collectLines();
  push('0009182736\n1234567890\n');
  assert.deepStrictEqual(cards, ['0009182736', '1234567890']);
});

test('stdin: ignores blank and non-numeric lines', () => {
  const { cards, push } = collectLines();
  push('\n');
  push('hello\n');
  push('42\n');
  assert.deepStrictEqual(cards, ['42']);
});

test('stdin: drops an absurdly long line instead of buffering forever', () => {
  const { cards, push } = collectLines();
  push('1'.repeat(100)); // no newline — exceeds the cap
  push('\n');
  assert.deepStrictEqual(cards, []);
});
