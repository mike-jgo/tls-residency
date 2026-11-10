// Native tap screen for the Staffer Attendance Monitoring System. See ../PLAN.md.
//
// It talks to the Node server (web/) exactly as the web tap screen does:
//   GET  /station/events    server-sent events: "appearance" and "status"
//   POST /station/tap       { rfid, requestId }, header X-Station: 1
//   POST /station/sync      the cloud in the header
//   POST /station/shutdown  the Shut down button
//   GET  /background?v=…    the picture behind the panels
//
// What each part of the screen says follows the web page's script in
// web/views.js (stationPage) rule for rule; the comments name the matching
// function there.
//
// Environment:
//   STATION_URL         the server (default http://localhost:3000)
//   STATION_FULLSCREEN  1 to fill the screen
//   STATION_TYPING      1 to accept typed card numbers on Linux (off Linux
//                       they are always accepted, like the web page)

slint::include_modules!();

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::rc::Rc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use slint::{Color, Image, ModelRc, Rgba8Pixel, SharedPixelBuffer, Timer, TimerMode, VecModel};

// Longest gap between two keystrokes of one tap (MAX_KEY_GAP_MS).
const MAX_KEY_GAP: Duration = Duration::from_millis(100);
// How long a result stays up (SHOW_MS).
const SHOW_FOR: Duration = Duration::from_secs(6);

// ---- What the server sends ---------------------------------------------

#[derive(Deserialize, Default, Clone)]
struct Status {
    #[serde(rename = "clockReady", default)]
    clock_ready: bool,
    #[serde(default)]
    sync: Option<SyncBadge>,
    #[serde(rename = "currentlyIn", default)]
    currently_in: Vec<InPerson>,
    #[serde(default)]
    leaderboards: Option<Boards>,
}
#[derive(Deserialize, Clone)]
struct SyncBadge { state: String, label: String }
#[derive(Deserialize, Clone)]
struct InPerson { name: String, section: Option<String>, status: Option<String>, since: Option<String> }
#[derive(Deserialize, Clone)]
struct Boards {
    month: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    sections: Vec<SectionHours>,
    #[serde(default)]
    staffers: Vec<StafferHours>,
}
#[derive(Deserialize, Clone)]
struct SectionHours { section: String, hours: f64 }
#[derive(Deserialize, Clone)]
struct StafferHours { name: String, section: Option<String>, hours: f64 }

#[derive(Deserialize)]
struct Appearance { image: Option<Picture>, opacity: f64, theme: String }
#[derive(Deserialize)]
struct Picture { version: String }

#[derive(Deserialize, Clone, Default)]
struct Tap {
    #[serde(default)]
    status: String,
    #[serde(default)]
    direction: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    stale: bool,
    #[serde(default)]
    replayed: bool,
    #[serde(default)]
    time: String,
    #[serde(default)]
    rfid: String,
}

// ---- Colours the web page sets in CSS ----------------------------------

fn hex(rgb: u32) -> Color {
    Color::from_rgb_u8((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
}

// SECTION_COLORS: [background, text].
fn section_colors(section: &str) -> (Color, Color) {
    let (bg, fg) = match section {
        "University" => (0x054805, 0xffffff),
        "Menagerie" => (0x003075, 0xffffff),
        "Sports" => (0xb09900, 0x1a1a1a),
        "Vanguard" => (0x591258, 0xffffff),
        "Intermedia" => (0x430808, 0xffffff),
        "Photo" => (0x8a0303, 0xffffff),
        "A&G" => (0x018181, 0xffffff),
        "Layout" => (0xa64d15, 0xffffff),
        "Web" => (0xb76e79, 0x1a1a1a),
        _ => (0x647082, 0xffffff), // .fill's default, var(--muted)
    };
    (hex(bg), hex(fg))
}

// ul.people .status, by status, in either theme.
fn status_colors(status: &str, christmas: bool) -> (Color, Color) {
    match status.to_lowercase().as_str() {
        "regular" if christmas => (hex(0xfbe4e2), hex(0x9a1f17)),
        "regular" => (hex(0xe6f0fb), hex(0x1f5a96)),
        "eb" | "eal" => (hex(0xe4f2e8), hex(0x1d6b3a)),
        _ => (hex(0xeef2f7), hex(0x647082)),
    }
}

// The sync badge's icon (ICONS) and colours (.sync.<state>).
fn sync_look(state: &str) -> (&'static str, Color, Color) {
    const CLOUD: &str = "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z";
    match state {
        "synced" => ("M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z M9 14l2 2 4-4", hex(0xe4f6ec), hex(0x137a4b)),
        "pending" => ("M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24 M12 12v9 M16 16l-4-4-4 4", hex(0xe8f0fe), hex(0x1f6feb)),
        "offline" => ("M2 2l20 20 M5.78 5.78A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.31-.19 M21.53 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7 7 0 0 0 10 5.07",
                      hex(0xfbf1dc), hex(0x8a5a00)),
        "error" => ("M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z M12 10v3 M12 16h.01", hex(0xfce8e6), hex(0xb42318)),
        _ => (CLOUD, hex(0xeef2f7), hex(0x647082)),
    }
}

// ---- Times, as the page shows them (en-PH, the Pi's time zone) ---------

fn local(iso: &str) -> Option<chrono::DateTime<chrono::Local>> {
    chrono::DateTime::parse_from_rfc3339(iso).ok().map(|t| t.with_timezone(&chrono::Local))
}
fn hm(iso: &str) -> String {
    local(iso).map(|t| t.format("%I:%M %p").to_string()).unwrap_or_default()
}
fn full(iso: &str) -> String {
    local(iso).map(|t| t.format("%m/%d/%Y, %I:%M:%S %p").to_string()).unwrap_or_default()
}

// ---- The app -------------------------------------------------------------

struct Reader {
    digits: String,
    last_key: Option<Instant>,
    scan_started: bool,
    overflow: bool,
    reader_only: bool,
}

struct App {
    ui: AppWindow,
    base: String,
    status: Status,
    connected: bool,
    christmas: bool,
    background_version: Option<String>,
    shown: Option<Tap>,
    hide: Timer,
    // A tap's receipt is kept until the server confirms it, so tapping the
    // same card again repeats the same request rather than toggling twice.
    pending: HashMap<String, String>,
    sending: HashSet<String>,
    shut_open: bool,
    shutting_down: bool,
    shut_error: String,
    reader: Reader,
}

thread_local! {
    static APP: RefCell<Option<App>> = const { RefCell::new(None) };
}

// Run `f` on the app, on the UI thread. Safe to call from any thread.
fn later(f: impl FnOnce(&mut App) + Send + 'static) {
    let _ = slint::invoke_from_event_loop(move || with_app(f));
}
fn with_app(f: impl FnOnce(&mut App)) {
    APP.with(|cell| {
        if let Some(app) = cell.borrow_mut().as_mut() {
            f(app);
        }
    });
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build()
}

impl App {
    // ---- renderMain ----
    fn render_main(&self) {
        let view = |kind: &str, big: &str, name: &str, detail: String, extra: &str| TapView {
            kind: kind.into(), big: big.into(), name: name.into(), detail: detail.into(), extra: extra.into(), clock_glyph: false,
        };
        let v = if let Some(t) = &self.shown {
            if t.replayed {
                view(&t.direction, "Tap confirmed", &t.name,
                     format!("Your earlier {} was recorded at {}. No second tap was recorded.", t.direction.to_uppercase(), full(&t.time)),
                     "Tap again only for a new arrival or departure.")
            } else if t.status == "ok" && t.direction == "in" {
                view("in", "IN", &t.name, format!("Checked in at {}. Welcome!", hm(&t.time)),
                     if t.stale { "Your last check-in was never tapped out, so that session didn’t count." } else { "" })
            } else if t.status == "ok" {
                view("out", "OUT", &t.name, format!("Checked out at {}. See you!", hm(&t.time)), "")
            } else if t.status == "unknown" {
                view("bad", "Not registered", "", format!("Card number {} isn’t registered. Click Register to add it.", t.rfid), "")
            } else if t.status == "inactive" {
                view("bad", "ID deactivated", "", "Nothing was recorded. Ask an admin to reactivate it.".into(), "")
            } else if t.status == "clock" {
                view("bad", "Not recorded", "", "The clock isn’t set yet. Wait a moment, then tap again.".into(), "")
            } else if t.status == "ignored" {
                view("idle", "Repeat ignored", "",
                     "This ID was just read. No new tap was recorded. Wait five seconds if you need to tap again.".into(), "")
            } else {
                view("bad", "Not confirmed yet", "",
                     "Your tap may already be saved. Tap the same ID again to safely confirm it.".into(), "")
            }
        } else if !self.connected {
            view("idle", "Connecting…", "", "Wait for “Tap your ID” before tapping.".into(), "")
        } else if !self.status.clock_ready {
            TapView { clock_glyph: true, ..view("idle", "Setting the clock…", "", "Needs wifi. Taps start in a moment.".into(), "") }
        } else {
            view("idle", "Tap your ID", "", "Once when you arrive, once when you leave.".into(),
                 if self.pending.is_empty() { "" } else { "An earlier tap still needs confirmation. Tap that same ID again." })
        };
        self.ui.set_view(v);
    }

    fn people(&self) -> Vec<Person> {
        self.status.currently_in.iter().map(|p| {
            let section = p.section.clone().unwrap_or_default();
            let status = p.status.clone().unwrap_or_default();
            let (section_bg, section_fg) = section_colors(&section);
            let (status_bg, status_fg) = status_colors(&status, self.christmas);
            Person {
                name: p.name.as_str().into(),
                section: section.into(), section_bg, section_fg,
                status: status.into(), status_bg, status_fg,
                since: format!("since {}", hm(p.since.as_deref().unwrap_or(""))).into(),
            }
        }).collect()
    }

    // ---- renderSide ----
    fn render_side(&self) {
        let n = self.status.currently_in.len();
        self.ui.set_in_title(if self.connected { format!("IN THE OFFICE ({n})") } else { "ATTENDANCE UNAVAILABLE".into() }.into());
        let people = if self.connected { self.people() } else { vec![] };
        self.ui.set_people(ModelRc::from(Rc::new(VecModel::from(people))));
        self.ui.set_people_empty(if self.connected { "Nobody is checked in." } else { "Waiting for the office computer." }.into());
    }

    // ---- renderBoards ----
    fn render_boards(&self) {
        let b = self.status.leaderboards.as_ref();
        self.ui.set_board_title(match b { Some(b) => format!("LEADERBOARD · {}", b.month.to_uppercase()), None => "LEADERBOARD".into() }.into());
        let hidden = b.is_some_and(|b| b.hidden);
        self.ui.set_boards_hidden(hidden);
        let (mut sections, mut staffers) = (vec![], vec![]);
        if let Some(b) = b.filter(|b| !b.hidden) {
            let bar = |i: usize, label: &str, section: &str, hours: f64, top: f64| Bar {
                rank: (i + 1).to_string().into(),
                label: label.into(),
                hours: format!("{hours:.1} h").into(),
                fraction: if top > 0.0 { (hours / top) as f32 } else { 0.0 },
                color: section_colors(section).0,
            };
            let top = b.sections.first().map_or(0.0, |s| s.hours);
            sections = b.sections.iter().enumerate().map(|(i, s)| bar(i, &s.section, &s.section, s.hours, top)).collect();
            let top = b.staffers.first().map_or(0.0, |s| s.hours);
            staffers = b.staffers.iter().enumerate()
                .map(|(i, s)| bar(i, &s.name, s.section.as_deref().unwrap_or(""), s.hours, top)).collect();
        }
        self.ui.set_staffers_empty(b.is_some() && !hidden && staffers.is_empty());
        self.ui.set_sections(ModelRc::from(Rc::new(VecModel::from(sections))));
        self.ui.set_staffers(ModelRc::from(Rc::new(VecModel::from(staffers))));
    }

    // ---- renderSync / showSync ----
    fn render_sync(&self) {
        match &self.status.sync {
            Some(s) => self.show_sync(&s.state, &s.label),
            None => self.ui.set_sync_visible(false),
        }
    }
    fn show_sync(&self, state: &str, label: &str) {
        let (icon, bg, fg) = sync_look(state);
        self.ui.set_sync_visible(true);
        self.ui.set_sync_icon(icon.into());
        self.ui.set_sync_bg(bg);
        self.ui.set_sync_fg(fg);
        self.ui.set_sync_label(label.into());
    }

    // ---- renderShut ----
    fn render_shut(&self) {
        self.ui.set_shut_open(self.shut_open);
        if !self.shut_open { return; }
        self.ui.set_shut_error(self.shut_error.as_str().into());
        if self.shutting_down {
            self.ui.set_shut_mode("shutting".into());
            self.ui.set_shut_title("Shutting down…".into());
            self.ui.set_shut_text("Wait until the screen goes blank and the green light on the Pi stops flashing, then unplug it.".into());
            self.ui.set_shut_warn(false);
            return;
        }
        if !self.connected {
            self.ui.set_shut_mode("waiting".into());
            self.ui.set_shut_title("Checking attendance…".into());
            self.ui.set_shut_text("Wait for the connection before shutting down. Attendance may have changed.".into());
            self.ui.set_shut_warn(false);
            return;
        }
        let n = self.status.currently_in.len();
        self.ui.set_shut_mode("confirm".into());
        self.ui.set_shut_title(if n == 0 { "Everyone has tapped out".into() }
            else { format!("{n} {} still checked in", if n == 1 { "person is" } else { "people are" }) }.into());
        self.ui.set_shut_text(if n > 0 { "If you shut down now, their time since checking in won’t count. Ask them to tap out first." }
            else { "Shut down the office computer for the day?" }.into());
        self.ui.set_shut_warn(n > 0);
        self.ui.set_shut_confirm_label(if n > 0 { "Shut down anyway" } else { "Shut down" }.into());
    }

    fn render_all(&self) {
        self.render_main();
        self.render_side();
        self.render_shut();
        self.render_sync();
        self.render_boards();
    }

    // ---- show ----
    fn show(&mut self, tap: Tap) {
        // An ignored repeat changes nothing, and the screen is still showing
        // the answer to the tap it repeats.
        if tap.status == "ignored" && self.shown.is_some() { return; }
        let error = tap.status == "error";
        self.shown = Some(tap);
        self.hide.stop();
        if !error {
            self.hide.start(TimerMode::SingleShot, SHOW_FOR, || with_app(|app| { app.shown = None; app.render_main(); }));
        }
        self.render_main();
    }

    // ---- sendTap ----
    fn send_tap(&mut self, rfid: String) {
        if self.shutting_down || self.sending.contains(&rfid) { return; }
        let request_id = self.pending.entry(rfid.clone()).or_insert_with(|| uuid::Uuid::new_v4().to_string()).clone();
        self.sending.insert(rfid.clone());
        let url = format!("{}/station/tap", self.base);
        std::thread::spawn(move || {
            let reply = agent().post(&url).set("X-Station", "1")
                .send_json(serde_json::json!({ "rfid": rfid, "requestId": request_id }))
                .ok()
                .and_then(|r| r.into_json::<Tap>().ok());
            later(move |app| {
                app.sending.remove(&rfid);
                match reply {
                    Some(tap) => { app.pending.remove(&rfid); app.show(tap); }
                    None => app.show(Tap { status: "error".into(), ..Tap::default() }),
                }
            });
        });
    }

    // ---- the keydown listener ----
    // Returns whether the key was the reader's (and so consumed).
    fn key(&mut self, text: &str, modifier: bool) -> bool {
        if modifier { return false; }
        let now = Instant::now();
        let gap = self.reader.last_key.map_or(Duration::MAX, |t| now - t);
        self.reader.last_key = Some(now);
        let r = &mut self.reader;
        let mut chars = text.chars();
        let one = match (chars.next(), chars.next()) { (Some(c), None) => Some(c), _ => None };

        if let Some(d) = one.filter(char::is_ascii_digit) {
            if r.reader_only && gap > MAX_KEY_GAP { r.digits.clear(); r.overflow = false; }
            r.scan_started = true;
            if r.overflow { return true; }
            r.digits.push(d);
            if r.digits.len() > 64 { r.digits.clear(); r.overflow = true; }
            true
        } else if one == Some('\n') || one == Some('\r') {
            // With no digits before it this is not the reader.
            if !r.scan_started { return false; }
            let card = std::mem::take(&mut r.digits);
            r.scan_started = false; r.overflow = false;
            if !card.is_empty() && (!r.reader_only || gap <= MAX_KEY_GAP) { self.send_tap(card); }
            true
        } else if one == Some('\u{1b}') {
            r.digits.clear(); r.scan_started = false; r.overflow = false;
            self.close_shut();
            true
        } else {
            r.digits.clear(); r.scan_started = false; r.overflow = false;
            false
        }
    }

    // ---- Shut down ----
    fn open_shut(&mut self) { self.shut_open = true; self.shut_error.clear(); self.render_shut(); }
    fn close_shut(&mut self) {
        if !self.shutting_down { self.shut_open = false; self.render_shut(); }
    }
    fn do_shutdown(&mut self) {
        self.shutting_down = true;
        self.shut_error.clear();
        self.render_shut();
        let url = format!("{}/station/shutdown", self.base);
        std::thread::spawn(move || {
            let failed = match agent().post(&url).set("X-Station", "1").call() {
                Ok(_) => None,
                Err(ureq::Error::Status(_, r)) => Some(r.into_json::<serde_json::Value>().ok()
                    .and_then(|b| b.get("error").and_then(|e| e.as_str()).map(String::from))
                    .unwrap_or_else(|| "the server refused".into())),
                Err(e) => Some(e.to_string()),
            };
            if let Some(why) = failed {
                later(move |app| {
                    app.shutting_down = false;
                    app.shut_error = format!("Couldn’t shut down: {why}");
                    app.render_shut();
                });
            }
        });
    }

    // ---- The appearance event ----
    fn apply_appearance(&mut self, a: Appearance) {
        self.christmas = a.theme == "christmas";
        self.ui.set_christmas(self.christmas);
        self.ui.set_card((a.opacity / 100.0).clamp(0.0, 1.0) as f32);
        let version = a.image.map(|p| p.version);
        if version == self.background_version { self.render_side(); return; }
        self.background_version = version.clone();
        match version {
            None => self.ui.set_has_background(false),
            Some(v) => {
                let url = format!("{}/background?v={v}", self.base);
                std::thread::spawn(move || {
                    if let Some(pixels) = load_picture(&url) {
                        later(move |app| {
                            if app.background_version.as_deref() == Some(v.as_str()) {
                                app.ui.set_picture(Image::from_rgba8(pixels));
                                app.ui.set_has_background(true);
                            }
                        });
                    }
                });
            }
        }
        // Status pills differ by theme.
        self.render_side();
    }
}

// Fetch and decode the background, shrunk to screen size: a phone photo at
// full size would take tens of megabytes of the Pi's memory.
fn load_picture(url: &str) -> Option<SharedPixelBuffer<Rgba8Pixel>> {
    let mut bytes = vec![];
    agent().get(url).call().ok()?.into_reader().take(16 << 20).read_to_end(&mut bytes).ok()?;
    let img = image::load_from_memory(&bytes).ok()?.thumbnail(1920, 1200).into_rgba8();
    let (w, h) = img.dimensions();
    Some(SharedPixelBuffer::clone_from_slice(img.as_raw(), w, h))
}

// The server's event stream, forever, reconnecting after a drop.
fn listen(base: String) {
    loop {
        if let Ok(resp) = ureq::get(&format!("{base}/station/events")).call() {
            let mut event = String::new();
            for line in BufReader::new(resp.into_reader()).lines() {
                let Ok(line) = line else { break };
                if let Some(e) = line.strip_prefix("event: ") {
                    event = e.to_string();
                } else if let Some(data) = line.strip_prefix("data: ") {
                    match event.as_str() {
                        "status" => if let Ok(s) = serde_json::from_str::<Status>(data) {
                            later(move |app| {
                                app.status = s;
                                app.connected = true;
                                app.ui.set_offline(false);
                                app.render_all();
                            });
                        },
                        "appearance" => if let Ok(a) = serde_json::from_str::<Appearance>(data) {
                            later(move |app| app.apply_appearance(a));
                        },
                        _ => {}
                    }
                }
            }
        }
        // es.onerror
        later(|app| {
            app.connected = false;
            if !app.shutting_down { app.ui.set_offline(true); }
            app.render_main();
            app.render_side();
            app.render_shut();
        });
        std::thread::sleep(Duration::from_secs(2));
    }
}

// Register and Admin are web pages: open them in a browser.
fn open_page(url: String) {
    let result = if cfg!(target_os = "windows") {
        std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&url).spawn()
    };
    if let Err(e) = result { eprintln!("couldn't open {url}: {e}"); }
}

fn main() -> Result<(), slint::PlatformError> {
    let base = std::env::var("STATION_URL").unwrap_or_else(|_| "http://localhost:3000".into());
    let base = base.trim_end_matches('/').to_string();
    let ui = AppWindow::new()?;
    if std::env::var("STATION_FULLSCREEN").as_deref() == Ok("1") {
        ui.window().set_fullscreen(true);
    }

    // The clock in the header, once a second (tick).
    let clock = Timer::default();
    let tick = {
        let ui = ui.as_weak();
        move || if let Some(ui) = ui.upgrade() {
            ui.set_clock(chrono::Local::now().format("%a, %b %-d, %I:%M %p").to_string().into());
        }
    };
    tick();
    clock.start(TimerMode::Repeated, Duration::from_secs(1), tick);

    ui.on_key(|text, modifier| {
        let mut used = false;
        with_app(|app| used = app.key(&text, modifier));
        used
    });
    ui.on_sync_clicked({
        let base = base.clone();
        move || {
            with_app(|app| app.show_sync("pending", "Syncing"));
            let url = format!("{base}/station/sync");
            std::thread::spawn(move || { let _ = agent().post(&url).set("X-Station", "1").call(); });
        }
    });
    ui.on_open_register({ let base = base.clone(); move || open_page(format!("{base}/register")) });
    ui.on_open_admin({ let base = base.clone(); move || open_page(format!("{base}/admin")) });
    ui.on_shut_clicked(|| with_app(App::open_shut));
    ui.on_shut_cancel(|| with_app(App::close_shut));
    ui.on_shut_confirm(|| with_app(App::do_shutdown));

    let reader_only = cfg!(target_os = "linux") && std::env::var("STATION_TYPING").as_deref() != Ok("1");
    let app = App {
        ui: ui.clone_strong(),
        base: base.clone(),
        status: Status::default(),
        connected: false,
        christmas: false,
        background_version: None,
        shown: None,
        hide: Timer::default(),
        pending: HashMap::new(),
        sending: HashSet::new(),
        shut_open: false,
        shutting_down: false,
        shut_error: String::new(),
        reader: Reader { digits: String::new(), last_key: None, scan_started: false, overflow: false, reader_only },
    };
    app.render_all();
    APP.with(|cell| *cell.borrow_mut() = Some(app));

    std::thread::spawn(move || listen(base));
    ui.run()
}
