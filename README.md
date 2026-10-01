# TLS Office Attendance

RFID residency-hours tracker for a school media organization. A USB RFID reader
plugs into a Raspberry Pi in the office, with a monitor, keyboard and mouse. The Pi
runs everything — the reader, the database, the tap screen and the admin site. One
box, no cloud.

The Pi is **not** left running. The first person in switches it on each morning;
the last person out shuts it down from the tap screen and unplugs it.

```
Pi (office, monitor + keyboard + mouse)
┌──────────────────────────────────────────────────┐
│  USB RFID reader  (a USB keyboard: types the     │
│        │           card number, then Enter)      │
│        ▼                                         │
│  Chromium, full-screen ─► /station (tap screen)  │
│        │ POST /station/tap                       │
│        ▼                                         │
│  server.js ─► attendance.db                      │
│     │    └──► console log (journalctl)           │
│     └► /admin  (password-protected)              │
└──────────────────────────────────────────────────┘
              │
        office wifi  (sets the clock; admin from other devices)
```

- **Tap screen** (`/station`) — full-screen on the monitor, and where cards are read: the reader types each card number into this page. Shows IN / OUT / unknown card for every tap, who's in the office, and the **Shut down** button that ends the day.
- **Admin site** (`/admin`) — register people, see who's in, view and export hours. Password-protected; open it from the tap screen or from any device on the office network.
- **The log** — every tap also prints a line, so `journalctl` is a record of the day.

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
  Tap screen:  http://localhost:3000/station  (the reader types into this page)
  Admin:       http://localhost:3000/admin  (user: admin)

10:12:41  IN    Michael Go
18:30:44  OUT   Michael Go
18:31:02  ???   unknown card 0000000001
```

Open the tap screen, click on it so it has focus, and tap a card. It only opens
from the machine the server runs on; anywhere else gets a 403. `npm test` covers
the clock check, the in/out toggle, repeat suppression, the daily shutdown, the
hours maths, report date handling and database persistence — none of it needs
hardware.

### Running on a Mac (or any non-Linux machine)

On the Pi the tap screen only accepts digits typed at reader speed (see *The
reader* below), so nobody can type a colleague's number on the keyboard. Off Linux
that check is off: with no reader plugged in, type a card number on the tap screen
and press Enter.

Off Linux there is also no clock check, each run of the server counts as a fresh boot
(so a check-in left open when you stop it is abandoned, as it would be overnight on
the Pi), and **Shut down** only logs — it doesn't switch your laptop off.

The SQLite file (`attendance.db`) is created automatically on first run.

## Configuration (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `ADMIN_USER` | `admin` | Admin login username |
| `ADMIN_PASSWORD` | `changeme` | Admin login password — **change this** |
| `ORG_NAME` | `TLS` | Shown in the admin header |
| `TZ` | `Asia/Manila` | Timezone for logged times and reports |
| `MAX_SESSION_HOURS` | `10` | The longest a session may be. Longer ones count as zero (see below) |
| `DB_PATH` | `./attendance.db` | Where the database file lives |

### The reader

The reader is a USB keyboard as far as the Pi is concerned: a tap types the card
number and presses Enter. Plug it in; there is nothing to configure. Cards are read
**only by the tap screen**, so it has to be the window with keyboard focus:

- In kiosk mode it is, from boot. If something takes focus away, the tap screen
  shows **Taps can't be read right now — click anywhere on this screen** in a
  bar across the top.
- An admin page opened on the Pi returns to the tap screen after two minutes
  without mouse or keyboard use, so one left open doesn't silently swallow taps.
- The tap screen catches the reader's keystrokes before anything else on the page,
  so a tap never presses a focused button — not even **Shut down anyway**.
- On the Pi it only accepts a number whose digits arrive within 100 ms of each
  other, as a reader's do. A person typing on the keyboard can't manage that, so
  the attached keyboard can't be used to tap in on someone else's behalf. If your
  reader is unusually slow and taps are ignored, raise `MAX_KEY_GAP_MS` in
  `views.js`.

## How it works

**The day.** The first person in plugs the Pi in and switches it on. It boots to
the desktop, which opens the tap screen full-screen. Until the Pi has set its clock
over wifi — usually within a minute — the screen says **Setting the clock…** and
taps are refused (see *The clock* below). After that, people tap in and out. At
the end of the day the last person clicks **Shut down** on the tap screen, waits for
the screen to go blank, and unplugs it.

**Registering someone.** Admin → People. Type their name and student ID. On the Pi,
click the RFID box and have them tap their card — the reader types the number
straight in. From another device, have them tap on the tap screen (it says *Not
registered*), refresh the People page, pick the number out of the **Unrecognized
taps** list and click "Use this card". That list holds the last 20
unrecognized cards, in memory only — it empties on restart, because it's a
registration shortcut, not a record.

**Scanning.** One tap toggles state based on the person's last event: first tap
checks them in, next tap checks them out, and so on. The decision is made from the
database, so nothing at the reader can desync it. The tap screen shows the result
in large type for a few seconds.

**Repeat taps.** Someone unsure whether their tap landed will tap again — which
would check them straight back out. A second tap of the same card within a few
seconds is ignored and logged as such; the screen keeps showing the first answer.

**Unknown cards.** If a tapped number isn't registered, the tap screen says so, the
log shows `???  unknown card <number>`, and nothing is recorded. The number is then
offered on the People page for registration.

**Hours.** Each in→out pair is one session; residency hours are the sum. A person
still checked in shows as an open session worth zero until they tap out.

**Shutting down.** **Shut down** first lists everyone still checked in, and the list
updates live — anyone who taps out while it's open drops off it. If nobody is left
it just asks to confirm; otherwise the button reads **Shut down anyway**, because
those people will lose today's session (see below). Who was still in at shutdown is
written to the log. Use this button rather than the desktop's own shutdown menu,
which knows nothing about attendance.

**Forgotten check-outs.** Someone taps in and goes home without tapping out. Two
things would go wrong on their own:

- Their next tap would close one enormous session, inflating the total.
- Worse, a plain toggle reads their next arrival as a *check-out* — so they are
  marked out while they are actually in, and every tap after that is inverted too.

Because the machine is off overnight, **no session can span a shutdown.** Every
event is stored with the id Linux gives the current boot, so a check-in left open
from before the Pi was last switched on is known to be abandoned — with no need to
trust the clock, which first thing in the morning is exactly what's wrong. The next
tap is a **new arrival**, not a check-out, so the sequence never inverts; the
abandoned check-in **counts as zero** and is flagged in the hours report. That
person also stops showing as "in" as soon as the machine is switched back on.

Within a single day, `MAX_SESSION_HOURS` does the same job: a session longer than it
counts as zero and is flagged, and a tap arriving more than that long after a
check-in is treated as a new arrival.

Forgetting to tap out therefore costs you that session. It is deliberately not
capped-but-credited: crediting the cap would quietly reward the mistake, and the
system has no way to know what was actually worked.

Set `MAX_SESSION_HOURS` above the longest day anyone genuinely does. Above it,
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

Raspberry Pi OS with the desktop, set to log in automatically (the default).

1. `git clone` the folder onto the Pi, then `npm install`.
2. Set a strong `ADMIN_PASSWORD` in `.env`.
3. **Wifi.** Connect to the office wifi from the desktop's network icon. It's saved
   and reconnects by itself at every boot. The Pi needs it each morning to set its
   clock — see *The clock* below.
4. **Let the server switch the Pi off.** The Shut down button runs
   `sudo -n /usr/bin/systemctl poweroff`. Allow exactly that, and nothing else,
   with `sudo visudo -f /etc/sudoers.d/attendance-poweroff`:

   ```
   pi ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
   ```

   (Use the account the service runs as, if it isn't `pi`.) Without this the button
   shows *Couldn't shut down* and the log says why.
5. Install a systemd service so the server starts at boot and restarts on failure.
   Put this in `/etc/systemd/system/attendance.service`:

   ```ini
   [Unit]
   Description=TLS attendance
   After=network.target

   [Service]
   User=pi
   WorkingDirectory=/home/pi/tls-residency
   ExecStart=/usr/bin/node server.js
   Restart=always
   RestartSec=3

   [Install]
   WantedBy=multi-user.target
   ```

   Check `which node` — if you installed Node with nvm rather than apt, correct the
   `ExecStart` path. Then:

   ```bash
   sudo systemctl enable --now attendance
   journalctl -u attendance -f
   ```

6. **Open the tap screen at login.** Create
   `~/.config/autostart/attendance-station.desktop`:

   ```ini
   [Desktop Entry]
   Type=Application
   Name=Attendance tap screen
   Exec=sh -c 'until curl -sf http://localhost:3000/healthz >/dev/null; do sleep 1; done; chromium-browser --kiosk --noerrdialogs --disable-session-crashed-bubble http://localhost:3000/station'
   ```

   The loop waits for the server to be up, so the browser doesn't open on an error
   page. (On newer releases the browser command is `chromium` rather than
   `chromium-browser`.) Kiosk mode has no address bar; the tap screen's **Admin**
   link and the admin site's **Tap screen** link move between the two.

   Check: after a reboot the tap screen should be up with no orange bar across the
   top, and a tap should show IN.

## Reaching the admin site

On the Pi itself, click **Admin** on the tap screen. From another device on the
office network, use the Pi's address: `http://<pi-ip>:3000/admin` — only while the
Pi is switched on, of course.

The admin login uses HTTP Basic auth, which isn't encrypted on the office network,
so don't reuse a password that matters elsewhere. The browser also remembers the
login until it closes — on the Pi, that's until shutdown — so anyone at the monitor
can reach the admin site for the rest of the day once someone has logged in there.

The tap screen and the shutdown button only answer requests from the Pi itself;
nobody on the network can switch it off.

## Back up your data

Everything is in `attendance.db`, and that file lives on the Pi's SD card — it is
the **only** copy of your attendance records, and SD cards fail. Unplugging without
shutting down is how they fail fastest, which is one reason to always use **Shut
down**.

Since the Pi is off overnight, back up when it starts instead. With a USB stick
mounted at `/media/usb`, add this to `crontab -e`:

```bash
@reboot sleep 60 && sqlite3 /home/pi/tls-residency/attendance.db ".backup '/media/usb/attendance-$(date +\%F).db'"
```

Use `.backup` rather than `cp` — the database runs in WAL mode, so a plain copy can
catch it mid-write. (The `\%` is how cron needs `%` written.)

## The clock

A Raspberry Pi has no battery-backed clock. Switched on in the morning, it believes
it is whenever it was last shut down — last night — until it reaches the internet
over wifi and sets the time. A tap recorded before then would be stamped with last
night's time.

So **taps are refused until the clock is set.** The server asks the system
(`timedatectl`) every couple of seconds after boot; until the answer is yes, the tap
screen shows **Setting the clock…**, a tap shows **Not recorded — wait a moment,
then tap again**, and the log shows `WAIT`. Nothing is written. With working wifi
this lasts well under a minute. If it doesn't clear, the wifi is the problem —
check the network icon.

If the wifi is down all day, nothing is recorded that day. That is deliberate:
missing taps are obvious and can be added by hand, whereas wrong times would
quietly go into the hours report. If that happens often, add a DS3231 RTC module
(a couple of dollars) or, on a Pi 5, connect the RTC battery header — the Pi then
knows the time at boot and the wait disappears.

Two more things keep the in/out toggle right whatever the clock does:

- **Order comes from the database, not the clock.** Events are ordered by insertion
  id, so a clock jump can't make someone check out twice.
- **Durations are measured monotonically.** The repeat-tap window and the
  `MAX_SESSION_HOURS` rule both ask "how much time has passed". They use a clock
  that counts real elapsed time and cannot be rewritten. Wall-clock time is still
  what gets *stored* — the report has to show times a human recognises — but it is
  never used to measure a duration.

The one case left is the server restarting mid-day (a crash, an update) between
someone's two taps: no elapsed-time reading survives it, so the stored timestamp is
used — and since taps are only recorded once the clock is set, that timestamp is
right.

## Notes / next steps (deliberately left out of this version)

- Per-person session history view in the admin area — currently a session discarded
  for a forgotten check-out can only be inspected or corrected with `sqlite3`.
- The Unrecognized taps list on the People page doesn't update by itself; refresh
  it after the new card is tapped.
