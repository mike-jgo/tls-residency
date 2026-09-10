'use strict';

/*
 * Reads an RFID reader that presents itself as a USB keyboard.
 *
 * On Linux (the Pi that runs this in production) the reader's keystrokes go to
 * two places at once: whichever session owns keyboard focus, and the device's
 * own node under /dev/input. We read the node. That way scanning doesn't depend
 * on a monitor, a desktop session, or a logged-in tty — the daemon just works.
 *
 * Everywhere else — a Mac used for development, mainly — there is no
 * /dev/input, so we fall back to reading the keystrokes off stdin. The reader
 * is still a keyboard, so with this process focused in a terminal each tap
 * arrives as a line of digits terminated by Enter, and you can also just type a
 * number by hand to simulate a scan. See startStdinReader below.
 *
 * Either way, card numbers arrive as a burst of key presses terminated by
 * Enter, exactly as if someone had typed them.
 */

const fs = require('fs');

// struct input_event { struct timeval time; __u16 type; __u16 code; __s32 value; }
// timeval is two longs, so the struct is 24 bytes on 64-bit and 16 on 32-bit.
// Pi OS ships in both flavours, hence the check. Fields are little-endian on
// every platform this runs on (ARM and x86 alike).
const WORD = (process.arch === 'arm64' || process.arch === 'x64') ? 8 : 4;

const EV_KEY = 1;   // event type: key press/release
const KEY_DOWN = 1; // value 1 = pressed (0 = released, 2 = autorepeat)

// Linux keycode → the character the reader "typed". Registered cards are all
// digits, so that's all we map. Keypad codes are included because some readers
// emit those instead of the number row.
const KEYS = {
  2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
  79: '1', 80: '2', 81: '3', 75: '4', 76: '5', 77: '6', 71: '7', 72: '8', 73: '9', 82: '0',
};
const ENTER = new Set([28, 96]); // KEY_ENTER, KEY_KPENTER

// A card is 10 digits. If we somehow pass this without seeing Enter, something
// other than a card is typing — drop it rather than growing forever.
const MAX_DIGITS = 64;

const RECONNECT_MS = 3000;

/*
 * Turns a stream of raw event bytes into finished card numbers.
 *
 * Separated from the file handling so it can be tested without a reader
 * plugged in — pass `word` to exercise the other architecture's layout.
 */
function createDecoder(onCard, word = WORD) {
  const size = word * 2 + 8;
  const offType = word * 2;
  const offCode = offType + 2;
  const offValue = offCode + 2;

  let carry = Buffer.alloc(0);
  let digits = '';

  return function push(chunk) {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;

    let i = 0;
    for (; i + size <= buf.length; i += size) {
      if (buf.readUInt16LE(i + offType) !== EV_KEY) continue;
      if (buf.readInt32LE(i + offValue) !== KEY_DOWN) continue;

      const code = buf.readUInt16LE(i + offCode);
      if (ENTER.has(code)) {
        if (digits) onCard(digits);
        digits = '';
      } else if (KEYS[code]) {
        digits += KEYS[code];
        if (digits.length > MAX_DIGITS) digits = '';
      }
    }

    // Reads don't align to the struct size, so hold the tail until the rest arrives.
    carry = buf.subarray(i);
  };
}

/*
 * Turns lines of typed text into finished card numbers.
 *
 * The stdin counterpart of createDecoder: stdin is already decoded into
 * characters, so all we do is split on newlines and keep the all-digit lines.
 * Split out for the same reason — it can be tested without any terminal.
 */
function createLineDecoder(onCard) {
  let line = '';

  return function push(chunk) {
    line += chunk;
    let nl;
    while ((nl = line.indexOf('\n')) !== -1) {
      const digits = line.slice(0, nl).trim(); // trim also drops a trailing \r
      line = line.slice(nl + 1);
      if (digits && /^\d+$/.test(digits)) onCard(digits);
    }
    // Same runaway guard as the raw decoder: don't buffer a line forever.
    if (line.length > MAX_DIGITS) line = '';
  };
}

/*
 * Watch the reader device, calling onCard with each complete number.
 *
 * On anything other than Linux there is no /dev/input to watch, so we read the
 * reader's keystrokes off stdin instead — see startStdinReader. This is the
 * path a Mac takes; devicePath is ignored there.
 *
 * On Linux we reconnect on our own: the device node doesn't exist yet if we
 * start before udev, and it disappears whenever someone unplugs the reader.
 * Neither should take attendance down until a human notices.
 */
function startReader({ devicePath, onCard, log }) {
  if (process.platform !== 'linux') {
    return startStdinReader({ onCard, log });
  }

  let complained = false;

  function open() {
    let retried = false;
    const retry = (message) => {
      if (retried) return; // error and end can both fire for one failure
      retried = true;
      if (message) log(message);
      setTimeout(open, RECONNECT_MS);
    };

    // A blocking read on a character device parks one libuv threadpool thread.
    // That's fine here — SQLite runs synchronously on the main thread and the
    // admin pages don't touch the pool.
    const stream = fs.createReadStream(devicePath);
    const decode = createDecoder(onCard);

    stream.on('open', () => {
      complained = false;
      log(`reading ${devicePath}`);
    });
    stream.on('data', decode);
    stream.on('end', () => retry('reader disconnected — waiting for it to come back'));
    stream.on('error', (err) => {
      stream.destroy();
      if (!complained) {
        complained = true; // don't repeat this every few seconds while it's missing
        log(`cannot read ${devicePath} (${err.code || err.message}) — retrying every ${RECONNECT_MS / 1000}s`);
      }
      retry();
    });
  }

  open();
}

/*
 * Read card numbers from stdin, one per line, calling onCard with each.
 *
 * Used off Linux, where /dev/input isn't available. Unlike the device path
 * this does depend on the process owning a focused terminal, which is exactly
 * why the Pi doesn't use it — but for developing on a Mac it means you can tap
 * the reader (or just type a number and hit Enter) and watch a scan flow all
 * the way through.
 */
function startStdinReader({ onCard, log }) {
  const decode = createLineDecoder(onCard);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', decode);
  process.stdin.resume();
  log('reading card numbers from stdin — tap the reader, or type a number and press Enter');
}

module.exports = { createDecoder, createLineDecoder, startReader, startStdinReader };
