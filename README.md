# TLS Office Attendance

RFID residency-hours tracker for a school media organization. A USB RFID reader
plugs into a Raspberry Pi in the office; the Pi runs everything — the reader, the
database, and the admin site. One box, no cloud, no browser at the reader.

```
Pi (office, no monitor)
┌─────────────────────────────────────────────┐
│  USB RFID reader                            │
│        │ /dev/input/by-id/…-event-kbd       │
│        ▼                                    │
│  lib/reader.js ─► server.js ─► attendance.db│
│        │                                    │
│        └─► console log  (journalctl)        │
│                                             │
│  express :3000 ─► /admin                    │
└─────────────────────────────────────────────┘
              │
        LAN / Tailscale  (admin only)
```

**Scanning never touches the network.** The office internet can be down for a week
and attendance keeps recording; only the remote admin view needs connectivity.

- **The log** — every tap prints a line. With no screen at the reader, this is the live feedback surface.
- **Admin site** (`/admin`) — register people, see who's in, view and export hours. Password-protected.

Stack: Node.js + Express + SQLite. Three dependencies, no build step.

---

## Run it locally

```bash
npm install
cp .env.example .env        # then edit .env — at minimum set ADMIN_PASSWORD
npm start
```

```
Attendance server running on http://localhost:3000
  Admin:  http://localhost:3000/admin  (user: admin)
  reading /dev/input/by-id/usb-Sycreader_USB_Reader-event-kbd

10:12:41  IN    Michael Go
18:30:44  OUT   Michael Go
18:31:02  ???   unknown card 0000000001
```

Without `READER_DEVICE` set the admin site still runs and says so — useful for
working on the UI from a machine that has no reader attached. `npm test` covers the
reader decoding, the in/out toggle, repeat suppression, the hours maths, report date
handling and database persistence — none of it needs hardware.

### Running on a Mac (or any non-Linux machine)

There is no `/dev/input` off Linux, so the reader reads keystrokes from **stdin**
instead. Run `npm start` in a terminal and either tap a card with the reader (it's
a USB keyboard) or just type a card number and press Enter — the scan flows through
exactly as it would on the Pi. `READER_DEVICE` is ignored in this mode. This is a
development convenience; production still runs on Linux through the device node
below (a background daemon has no terminal to read stdin from).

The SQLite file (`attendance.db`) is created automatically on first run.

## Configuration (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `READER_DEVICE` | *(none)* | The reader's input device. No scanning without it — see below |
| `PORT` | `3000` | Port the server listens on |
| `ADMIN_USER` | `admin` | Admin login username |
| `ADMIN_PASSWORD` | `changeme` | Admin login password — **change this** |
| `ORG_NAME` | `TLS` | Shown in the admin header |
| `TZ` | `Asia/Manila` | Timezone for logged times and reports |
| `MAX_SESSION_HOURS` | `10` | The longest a session may be. Longer ones count as zero (see below) |
| `DB_PATH` | `./attendance.db` | Where the database file lives |

### Finding your reader

The reader is a USB keyboard as far as Linux is concerned. List the input devices:

```bash
ls -l /dev/input/by-id/
```

Pick the entry ending in `-event-kbd` that matches the reader (the name usually
gives it away — `Sycreader`, `RFIDeas`, `USB_Reader`, etc.). Use the `by-id` path,
**not** `/dev/input/eventN` — the event numbers get reshuffled on reboot.

To confirm you picked the right one, put it in `.env`, run `npm start`, and tap a
card. If nothing appears, try the next `-event-kbd` entry.

Reading input devices requires membership in the `input` group:

```bash
sudo usermod -aG input $USER   # then log out and back in
```

## How it works

**Registering someone.** Admin → People. Type their name and student ID, then give
the server the card number. Since the reader is wired to the Pi and not to whatever
browser you're using, have them tap once at the reader, then pick the number out of
the **Unrecognized taps** list on that page and click "Use this card". That list
holds the last 20 unrecognized cards, in memory only — it empties on restart,
because it's a registration shortcut, not a record.

**Scanning.** One tap toggles state based on the person's last event: first tap
checks them in, next tap checks them out, and so on. The decision is made from the
database, so nothing at the reader can desync it.

**Repeat taps.** Nobody can see a screen at the reader, so someone unsure whether
their tap landed will tap again — which would check them straight back out. A second
tap of the same card within a few seconds is ignored and logged as such.

**Unknown cards.** If a tapped number isn't registered, the log shows
`???  unknown card <number>` and nothing is recorded. The number is then offered on
the People page for registration.

**Hours.** Each in→out pair is one session; residency hours are the sum. A person
still checked in shows as an open session worth zero until they tap out.

**Forgotten check-outs.** Someone taps in, goes home without tapping out, and comes
back the next morning. Two things would go wrong on their own:

- Their next tap would close one enormous session, inflating the total.
- Worse, a plain toggle reads that next tap as a *check-out* — so they are marked
  out while they are actually in, and every tap after that is inverted too.

`MAX_SESSION_HOURS` fixes both, because it defines what a plausible session is. A
session longer than it **counts as zero** and is flagged in the hours report; and a
tap arriving more than that long after a check-in is treated as a **new arrival**,
not a check-out, so the sequence never inverts. The abandoned check-in is left in
place, worth nothing, and flagged.

Forgetting to tap out therefore costs you that session. It is deliberately not
capped-but-credited: crediting the cap would quietly reward the mistake, and the
system has no way to know what was actually worked.

Set `MAX_SESSION_HOURS` above the longest shift anyone genuinely does. Above it,
a real tap-out is read as an arrival instead — which costs nothing, since a session
that long is worth zero either way, but it does leave an extra open session in the
report.

**Dates and timezone.** The hours report's From/To boxes are read as calendar days
in `TZ` — the same zone the times on screen are formatted in — so a range means the
same thing regardless of the machine's own clock settings. To is inclusive. A box
that isn't a real date is reported on the page and the range is ignored; the CSV
refuses outright rather than handing back a file whose range isn't the one asked for.

**Export.** Admin → Hours → Download CSV, with an optional date range.

## Deploy on the Pi

1. `git clone` the folder onto the Pi, then `npm install`.
2. Set a strong `ADMIN_PASSWORD` and the correct `READER_DEVICE` in `.env`.
3. Install a systemd service so it starts at boot and restarts on failure. Put this
   in `/etc/systemd/system/attendance.service`:

   ```ini
   [Unit]
   Description=TLS attendance
   After=network.target

   [Service]
   User=pi
   SupplementaryGroups=input
   WorkingDirectory=/home/pi/tls-residency
   ExecStart=/usr/bin/node server.js
   Restart=always
   RestartSec=3

   [Install]
   WantedBy=multi-user.target
   ```

   Check `which node` — if you installed Node with nvm rather than apt, correct the
   `ExecStart` path.

4. Start it and watch the taps come in:

   ```bash
   sudo systemctl enable --now attendance
   journalctl -u attendance -f
   ```

Nothing here depends on a monitor, a desktop session, or a logged-in terminal. The
service reads the reader's device node directly, so it works the same whether the
Pi boots to a desktop or to a console. If you don't use the desktop, disabling it
(`sudo raspi-config` → Boot/Auto Login → Console) frees a few hundred MB of RAM,
but it isn't required.

## Reaching the admin site

On the office network, just use the Pi's address: `http://<pi-ip>:3000/admin`.

For occasional access from elsewhere, install Tailscale rather than exposing the Pi
to the internet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Then reach it at `http://<pi-name>:3000/admin` from any device on your tailnet.

The admin login uses HTTP Basic auth. Over Tailscale that's inside an encrypted
WireGuard tunnel; over the plain office LAN it isn't, so don't reuse a password that
matters elsewhere. Since the Pi is never publicly exposed, no reverse proxy or
certificate is needed.

## Back up your data

Everything is in `attendance.db`, and that file now lives on an SD card in an office
cupboard — it is the **only** copy of your attendance records, and SD cards fail.
Copy it somewhere else on a schedule:

```bash
sqlite3 attendance.db ".backup '/media/usb/attendance-$(date +%F).db'"
```

Use `.backup` rather than `cp` — the database runs in WAL mode, so a plain copy can
catch it mid-write. Add it to `crontab -e` to run nightly.

## A note on the clock

A Raspberry Pi has no battery-backed clock. After a power cut with no internet, it
boots believing it's whenever it last shut down and drifts from there, so recorded
times can be wrong until the network returns and NTP corrects them.

In/out toggling is unaffected. Two things keep it that way:

- **Order comes from the database, not the clock.** Events are ordered by insertion
  id, so a backward jump can't make someone check out twice.
- **Durations are measured monotonically.** The repeat-tap window and the stale
  check-in rule both ask "how much time has passed", and on this hardware two
  wall-clock readings taken either side of an NTP correction don't answer that. Both
  use a clock that counts real elapsed time and cannot be rewritten. Wall-clock time
  is still what gets *stored* — the report has to show times a human recognises — but
  it is never used to measure a duration.

  Without this, a Pi that booted a day behind and then synced would read a departure
  one real hour after a check-in as 25 hours later, fire the stale rule, and record an
  arrival — leaving someone who had gone home marked present, every day the clock was
  wrong. There is a regression test for exactly that.

The gap is a restart *between* someone's two taps: no elapsed-time reading survives
it, so the stored timestamp is all there is and it may have been written while the
clock was off. The stale rule still uses it, deliberately — a wrong "stale" costs one
session and rights itself on the next tap, whereas skipping the rule across restarts
would bring back the inverting bug it exists to prevent.

If the *recorded hours* need to be defensible, that gap and the wrong timestamps close
the same way: add a DS3231 RTC module (a couple of dollars) or, on a Pi 5, connect the
RTC battery header.

## Notes / next steps (deliberately left out of this version)

- No feedback at the reader beyond its own beep — a GPIO buzzer or small OLED would
  confirm to the person whether they checked in or out.
- Per-person session history view in the admin area — currently a session discarded
  for a forgotten check-out can only be inspected or corrected with `sqlite3`.
