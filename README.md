# TLS Office Residency

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
│  server.js ─► residency.db                      │
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
Residency server running on http://localhost:3000
  Tap screen:  http://localhost:3000/station  (the reader types into this page)
  Admin:       http://localhost:3000/admin  (user: admin)

10:12:41  IN    Michael Go
18:30:44  OUT   Michael Go
18:31:02  ???   unknown card 0000000001
```

Open the tap screen, click on it so it has focus, and tap a card. It only opens
from the machine the server runs on; anywhere else gets a 403. `npm test` covers
the clock check, the in/out toggle, repeat suppression, the daily shutdown, the
hours maths, report date handling, database persistence, deactivation, and backup
and restore, and the Google Sheets sync (against a stand-in for Google) — none of
it needs hardware or a network.

### Running on a Mac (or any non-Linux machine)

On the Pi the tap screen only accepts digits typed at reader speed (see *The
reader* below), so nobody can type a colleague's number on the keyboard. Off Linux
that check is off: with no reader plugged in, type a card number on the tap screen
and press Enter.

Off Linux there is also no clock check, each run of the server counts as a fresh boot
(so a check-in left open when you stop it is abandoned, as it would be overnight on
the Pi), and **Shut down** only logs — it doesn't switch your laptop off.

The SQLite file (`residency.db`) is created automatically on first run.

## Configuration (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `ADMIN_USER` | `admin` | Admin login username |
| `ADMIN_PASSWORD` | `changeme` | Admin login password — **change this** |
| `ORG_NAME` | `TLS` | Shown in the admin header |
| `TZ` | `Asia/Manila` | Timezone for logged times and reports |
| `MAX_SESSION_HOURS` | `10` | The longest a session may be. Longer ones count as zero (see below) |
| `DB_PATH` | `./residency.db` | Where the database file lives |
| `BACKUP_DIR` | `./backups` | Where backups are written — point it at a USB stick (see *Back up your data*) |
| `SHEETS_SPREADSHEET_ID` | *(unset)* | The spreadsheet to publish to. Unset = no sync (see *Google Sheets*) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | `./service-account.json` | The service account's key file |
| `BACKUP_KEEP` | `60` | How many backups to keep; older ones are deleted. Two are taken a day |

### The reader

The reader is a USB keyboard as far as the Pi is concerned: a tap types the card
number and presses Enter. Plug it in; there is nothing to configure. Cards are read
**only by the tap screen**, so it has to be the window with keyboard focus:

- In kiosk mode it is, from boot. If something takes focus away, the tap screen
  dims and shows **Click to resume**.
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

**Someone leaves.** Admin → People → **Deactivate**. Their card stops working — a
tap shows *Card deactivated* and records nothing — but every tap they ever made
stays in the database, and they stay in the hours report and the CSV, marked
deactivated. **Reactivate** undoes it. Nobody can be deleted: deleting a person would
delete the hours they earned. The card number stays theirs, so it can't be
registered to someone else.

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
which knows nothing about residency.

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
   with `sudo visudo -f /etc/sudoers.d/residency-poweroff`:

   ```
   pi ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
   ```

   (Use the account the service runs as, if it isn't `pi`.) Without this the button
   shows *Couldn't shut down* and the log says why.
5. Install a systemd service so the server starts at boot and restarts on failure.
   Put this in `/etc/systemd/system/residency.service`:

   ```ini
   [Unit]
   Description=TLS residency
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
   sudo systemctl enable --now residency
   journalctl -u residency -f
   ```

6. **Open the tap screen at login.** Create
   `~/.config/autostart/residency-station.desktop`:

   ```ini
   [Desktop Entry]
   Type=Application
   Name=Residency tap screen
   Exec=sh -c 'until curl -sf http://localhost:3000/healthz >/dev/null; do sleep 1; done; chromium-browser --kiosk --noerrdialogs --disable-session-crashed-bubble http://localhost:3000/station'
   ```

   The loop waits for the server to be up, so the browser doesn't open on an error
   page. (On newer releases the browser command is `chromium` rather than
   `chromium-browser`.) Kiosk mode has no address bar; the tap screen's **Admin**
   link and the admin site's **Tap screen** link move between the two.

   Check: after a reboot the tap screen should be up, not dimmed with **Click to resume**,
   and a tap should show IN.

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

`residency.db` lives on the Pi's SD card, and SD cards fail. Unplugging without
shutting down is how they fail fastest, which is one reason to always use **Shut
down**.

The server backs the database up by itself, twice a day:

- when **Shut down** is pressed, before the power goes — the whole day's taps;
- when it starts — which covers a day that ended with the plug being pulled.

Each backup is a complete database named for when it was taken, such as
`residency-2026-10-01_183044.db`. The newest `BACKUP_KEEP` (60, about a month)
are kept. Every backup is logged; a failed one is logged as `BACKUP FAILED` and
never stops the server starting or the Pi shutting down — so look for that line in
`journalctl -u residency` now and then.

**Put the backups somewhere other than the SD card.** By default they go in
`backups/` beside the database, which protects against a damaged database or a
mistake, but not against the card dying. With a USB stick mounted at `/media/usb`,
set in `.env`:

```
BACKUP_DIR=/media/usb/residency-backups
```

If the stick isn't mounted, the folder is created on the SD card instead and backups
quietly land there — check the stick actually holds recent files.

### Restoring a backup

On the Pi, in the project folder:

```bash
sudo systemctl stop residency
npm run restore -- /media/usb/residency-backups/residency-2026-10-01_183044.db
sudo systemctl start residency
```

The restore checks the backup is an intact residency database before touching
anything, and refuses if the server is still running. The database it replaces is
not deleted: it is renamed to `residency.db.before-restore-<time>`, so restoring
the wrong backup can be undone by restoring that file. Taps made after the backup
was taken are not in it — they are only in the set-aside file.

On a brand-new SD card: deploy as below, copy the backup onto the Pi, and run the
same three commands.

## Google Sheets

Optional. The Pi can publish residency to a Google spreadsheet, so hours can be
read without the Pi being on. It is one-way: the database stays the record, the
sheet is a copy, and nothing typed into the sheet comes back.

The spreadsheet gets:

- **A tab per month** — `October 2026`, `November 2026`, … — with each person's
  hours for that month.
- **A log tab per month** — `October 2026 Logs`, … — with every tap that month,
  one per row.
- **A `Totals` tab** — when the sheet was last synced, and all-time hours.

Tabs are created as needed. Don't type in them or re-sort them — the next sync
writes over its own cells. Add your own tabs for anything else.

The sync runs when the server starts, and a couple of seconds after any tap or
roster change. With no internet it retries every minute, and taps not yet uploaded
are remembered in the database — through a restart or a shutdown — and go up the
next time there is a connection. A retry can't duplicate a tap: each tap has a fixed
row in its month's log (its position among that month's taps), so sending it twice writes the same
cells twice.

### Is it syncing?

A small cloud in the header of the tap screen and of every admin page says so:

| Cloud | Meaning |
|---|---|
| **Synced** | Every tap is in the sheet |
| **Syncing · 3** | Three taps are on their way up |
| **Offline · 3 saved** | No internet. Taps are still recorded on the Pi and upload when it is back |
| **Sync error** | Google refused the upload — the key, or the sheet's sharing. Needs fixing |

Click the cloud to sync straight away. Admin → Dashboard has the detail: how many taps are uploaded, how many are waiting,
when the sheet was last synced, and for an error, Google's reason. Being offline is
only noticed when an upload is tried — a couple of seconds after a tap, then every
minute until it works.

### Setting it up

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project, and enable the **Google Sheets API** for it.
2. *IAM & Admin → Service Accounts → Create service account.* It needs no roles.
   Open it, *Keys → Add key → JSON*, and save the downloaded file on the Pi as
   `service-account.json` in the project folder. Treat it like a password.
3. Create the spreadsheet and **share it with the service account's email
   address** (it ends in `iam.gserviceaccount.com`) as **Editor**.
4. Put the spreadsheet's ID in `.env` — the long part of its address,
   `docs.google.com/spreadsheets/d/<ID>/edit`:

   ```
   SHEETS_SPREADSHEET_ID=<ID>
   ```

5. Restart the server. The log says `Sheet sync:  spreadsheet <ID>`, and
   `sheet sync failed: …` with Google's reason if something is wrong — most often
   the sheet not being shared with the service account.

The first sync uploads the whole history. Pointing `SHEETS_SPREADSHEET_ID` at a
different spreadsheet does the same there.

After **restoring a backup**, the sheet may still show taps made after that backup
was taken. They are overwritten as new taps arrive; to start clean, delete the month
tabs concerned and point the server at the spreadsheet again by clearing the mark:
`sqlite3 residency.db "DELETE FROM meta WHERE key='sync_spreadsheet'"` (server
stopped).

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
