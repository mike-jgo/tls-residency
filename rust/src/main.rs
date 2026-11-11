// Standalone native attendance application. Runtime data stays outside the package.
slint::include_modules!();
mod management;
use slint::{
    Color, ComponentHandle, Image, ModelRc, Rgba8Pixel, SharedPixelBuffer, Timer, TimerMode,
    VecModel,
};
use std::{
    cell::RefCell,
    collections::HashSet,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};
use tls_residency::{
    config::Config,
    core::{Appearance, Core, Snapshot},
    dates,
    model::{Person as PersonData, ReportRow, Tap, User},
    scan::Reader,
};
const SHOW_FOR: Duration = Duration::from_secs(6);
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

struct App {
    ui: AppWindow,
    core: Arc<Core>,
    status: Snapshot,
    christmas: bool,
    background_version: Option<String>,
    background_size: (u32, u32),
    shown: Option<Tap>,
    hide: Timer,
    sending: HashSet<String>,
    shut_open: bool,
    shutting_down: bool,
    shut_error: String,
    reader: Reader,
    manage_open: bool,
    last_activity: Instant,
    data: management::Data,
}
thread_local! { static APP: RefCell<Option<App>> = const { RefCell::new(None) }; }
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
fn model<T: Clone + 'static>(rows: Vec<T>) -> ModelRc<T> {
    ModelRc::from(Rc::new(VecModel::from(rows)))
}
impl App {
    fn tick(&mut self) {
        self.ui.set_clock(self.core.config.dates.clock().into());
        let size = self.ui.window().size();
        if self.status.appearance.image.is_some() && self.background_size != (size.width, size.height) {
            self.apply_appearance(self.status.appearance.clone());
        }
        if self.manage_open
            && !self.adm().get_busy()
            && (self.last_activity.elapsed() > Duration::from_secs(120)
                || (self.adm().get_admin() && !self.core.authenticated()))
        {
            self.navigate("station");
        }
    }
    fn adm(&self) -> Admin<'_> {
        self.ui.global::<Admin>()
    }
    // ---- renderMain ----
    fn render_main(&self) {
        let view = |kind: &str, big: &str, name: &str, detail: String, extra: &str| TapView {
            kind: kind.into(),
            big: big.into(),
            name: name.into(),
            detail: detail.into(),
            extra: extra.into(),
            clock_glyph: false,
        };
        let v = if let Some(t) = &self.shown {
            if t.replayed {
                view(
                    &t.direction,
                    "Tap confirmed",
                    &t.name,
                    format!(
                        "Your earlier {} was recorded at {}. No second tap was recorded.",
                        t.direction.to_uppercase(),
                        self.core.config.dates.full(&t.time)
                    ),
                    "Tap again only for a new arrival or departure.",
                )
            } else if t.status == "ok" && t.direction == "in" {
                view(
                    "in",
                    "IN",
                    &t.name,
                    format!(
                        "Checked in at {}. Welcome!",
                        self.core.config.dates.time(&t.time)
                    ),
                    if t.stale {
                        "Your last check-in was never tapped out, so that session didn’t count."
                    } else {
                        ""
                    },
                )
            } else if t.status == "ok" {
                view(
                    "out",
                    "OUT",
                    &t.name,
                    format!(
                        "Checked out at {}. See you!",
                        self.core.config.dates.time(&t.time)
                    ),
                    "",
                )
            } else if t.status == "unknown" {
                view(
                    "bad",
                    "Not registered",
                    "",
                    format!(
                        "Card number {} isn’t registered. Click Register to add it.",
                        t.rfid
                    ),
                    "",
                )
            } else if t.status == "inactive" {
                view(
                    "bad",
                    "ID deactivated",
                    "",
                    "Nothing was recorded. Ask an admin to reactivate it.".into(),
                    "",
                )
            } else if t.status == "clock" {
                view(
                    "bad",
                    "Not recorded",
                    "",
                    "The clock isn’t set yet. Wait a moment, then tap again.".into(),
                    "",
                )
            } else if t.status == "ignored" {
                view("idle", "Repeat ignored", "",
                     "This ID was just read. No new tap was recorded. Wait five seconds if you need to tap again.".into(), "")
            } else if t.status == "shutdown-test" {
                view(
                    "idle",
                    "Backup saved",
                    "",
                    "Shutdown only powers off the computer on Linux.".into(),
                    "",
                )
            } else {
                view(
                    "bad",
                    "Not confirmed yet",
                    "",
                    "Your tap may already be saved. Tap the same ID again to safely confirm it."
                        .into(),
                    "",
                )
            }
        } else if !self.status.clock_ready {
            TapView {
                clock_glyph: true,
                ..view(
                    "idle",
                    "Setting the clock…",
                    "",
                    "Needs wifi. Taps start in a moment.".into(),
                    "",
                )
            }
        } else {
            view(
                "idle",
                "Tap your ID",
                "",
                "Once when you arrive, once when you leave.".into(),
                if self.status.pending_cards.is_empty() {
                    ""
                } else {
                    "An earlier tap still needs confirmation. Tap that same ID again."
                },
            )
        };
        self.ui.set_view(v);
    }

    fn people(&self) -> Vec<Person> {
        self.status
            .currently_in
            .iter()
            .map(|p| {
                let section = p.section.clone();
                let status = p.status.clone();
                let (section_bg, section_fg) = section_colors(&section);
                let (status_bg, status_fg) = status_colors(&status, self.christmas);
                Person {
                    name: p.name.as_str().into(),
                    section: section.into(),
                    section_bg,
                    section_fg,
                    status: status.into(),
                    status_bg,
                    status_fg,
                    since: format!("since {}", self.core.config.dates.time(&p.since)).into(),
                }
            })
            .collect()
    }

    // ---- renderSide ----
    fn render_side(&self) {
        self.ui
            .set_in_title(format!("IN THE OFFICE ({})", self.status.currently_in.len()).into());
        self.ui.set_people(model(self.people()));
        self.ui.set_people_empty("Nobody is checked in.".into());
    }

    // ---- renderBoards ----
    fn render_boards(&self) {
        let b = self.status.leaderboards.as_ref();
        self.ui.set_board_title(
            match b {
                Some(b) => format!("LEADERBOARD · {}", b.month.to_uppercase()),
                None => "LEADERBOARD".into(),
            }
            .into(),
        );
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
            sections = b
                .sections
                .iter()
                .enumerate()
                .map(|(i, s)| bar(i, &s.section, &s.section, s.hours, top))
                .collect();
            let top = b.staffers.first().map_or(0.0, |s| s.hours);
            staffers = b
                .staffers
                .iter()
                .enumerate()
                .map(|(i, s)| bar(i, &s.name, &s.section, s.hours, top))
                .collect();
        }
        self.ui
            .set_staffers_empty(b.is_some() && !hidden && staffers.is_empty());
        self.ui
            .set_sections(ModelRc::from(Rc::new(VecModel::from(sections))));
        self.ui
            .set_staffers(ModelRc::from(Rc::new(VecModel::from(staffers))));
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
        let _ = icon;
        self.ui.set_sync_icon(state.into());
        self.ui.set_sync_bg(bg);
        self.ui.set_sync_fg(fg);
        self.ui.set_sync_label(label.into());
    }

    // ---- renderShut ----
    fn render_shut(&self) {
        self.ui.set_shut_open(self.shut_open);
        if !self.shut_open {
            return;
        }
        self.ui.set_shut_error(self.shut_error.as_str().into());
        if self.shutting_down {
            self.ui.set_shut_mode("shutting".into());
            self.ui.set_shut_title("Shutting down…".into());
            self.ui.set_shut_text("Wait until the screen goes blank and the green light on the Pi stops flashing, then unplug it.".into());
            self.ui.set_shut_warn(false);
            return;
        }
        let n = self.status.currently_in.len();
        self.ui.set_shut_mode("confirm".into());
        self.ui.set_shut_title(
            if n == 0 {
                "Everyone has tapped out".into()
            } else {
                format!(
                    "{n} {} still checked in",
                    if n == 1 { "person is" } else { "people are" }
                )
            }
            .into(),
        );
        self.ui.set_shut_text(if n > 0 { "If you shut down now, their time since checking in won’t count. Ask them to tap out first." }
            else { "Shut down the office computer for the day?" }.into());
        self.ui.set_shut_warn(n > 0);
        self.ui.set_shut_confirm_label(
            if n > 0 {
                "Shut down anyway"
            } else {
                "Shut down"
            }
            .into(),
        );
    }

    fn render_all(&self) {
        self.render_main();
        self.render_side();
        self.render_shut();
        self.render_sync();
        self.render_boards();
    }

    fn apply_snapshot(&mut self, status: Snapshot) {
        let appearance = self.status.appearance != status.appearance;
        let people = self.status.currently_in != status.currently_in;
        let sync = self.status.sync != status.sync;
        let boards = self.status.leaderboards != status.leaderboards;
        let main = self.status.clock_ready != status.clock_ready
            || self.status.pending_cards != status.pending_cards;
        self.status = status;
        if appearance { self.apply_appearance(self.status.appearance.clone()); }
        if main { self.render_main(); }
        if people || appearance { self.render_side(); }
        if people && self.shut_open { self.render_shut(); }
        if sync { self.render_sync(); }
        if boards { self.render_boards(); }
        if self.manage_open { self.management_status(); }
    }

    // ---- show ----
    fn show(&mut self, tap: Tap) {
        // An ignored repeat changes nothing, and the screen is still showing
        // the answer to the tap it repeats.
        if tap.status == "ignored" && self.shown.is_some() {
            return;
        }
        let error = tap.status == "error";
        self.shown = Some(tap);
        self.hide.stop();
        if !error {
            self.hide.start(TimerMode::SingleShot, SHOW_FOR, || {
                with_app(|app| {
                    app.shown = None;
                    app.render_main();
                })
            });
        }
        self.render_main();
    }

    fn send_tap(&mut self, card: String) {
        if self.shutting_down || !self.sending.insert(card.clone()) {
            return;
        }
        let core = Arc::clone(&self.core);
        std::thread::spawn(move || {
            let reply = core.tap(&card);
            later(move |app| {
                app.sending.remove(&card);
                match reply {
                    Ok(tap) => {
                        app.show(tap.clone());
                        let core = Arc::clone(&app.core);
                        std::thread::spawn(move || {
                            if let Err(e) = core.acknowledge(&tap) {
                                core.log(&format!("Receipt needs confirmation: {e}"));
                            }
                        });
                    }
                    Err(e) => {
                        app.core.log(&format!("Tap not confirmed: {e}"));
                        app.show(Tap {
                            status: "error".into(),
                            ..Tap::default()
                        });
                    }
                }
            });
        });
    }
    fn key(&mut self, text: &str, modifier: bool) -> bool {
        let (used, card) = self.reader.key(text, modifier, Instant::now());
        if let Some(card) = card {
            self.send_tap(card);
        }
        used
    }
    fn open_shut(&mut self) {
        self.shut_open = true;
        self.shut_error.clear();
        self.render_shut();
    }
    fn close_shut(&mut self) {
        if !self.shutting_down {
            self.shut_open = false;
            self.render_shut();
        }
    }
    fn do_shutdown(&mut self) {
        if !self.shut_open || self.shutting_down {
            return;
        }
        self.shutting_down = true;
        self.shut_error.clear();
        self.render_shut();
        let core = Arc::clone(&self.core);
        std::thread::spawn(move || {
            let result = core.shutdown();
            later(move |app| {
                if let Err(e) = result {
                    app.shutting_down = false;
                    app.shut_error = format!("Could not shut down: {e}");
                    app.render_shut();
                } else if !cfg!(target_os = "linux") {
                    app.shutting_down = false;
                    app.close_shut();
                    app.show(Tap {
                        status: "shutdown-test".into(),
                        ..Tap::default()
                    });
                }
            });
        });
    }
    fn apply_appearance(&mut self, a: Appearance) {
        self.christmas = a.theme == "christmas";
        self.ui.set_christmas(self.christmas);
        self.ui.set_card((a.opacity / 100.0) as f32);
        let version = a.image.as_ref().map(|p| p.version.clone());
        let size = self.ui.window().size();
        let size = (size.width.max(1), size.height.max(1));
        if version == self.background_version && size == self.background_size {
            return;
        }
        self.background_version = version.clone();
        self.background_size = size;
        match a.image {
            None => {
                self.ui.set_has_background(false);
                self.ui.set_picture(Image::default());
                self.adm().set_has_preview(false);
                self.adm().set_preview(Image::default());
            }
            Some(p) => {
                std::thread::spawn(move || {
                    let pixels = load_picture(&p.path, size);
                    later(move |app| {
                        if app.background_version == version && app.background_size == size {
                            if let Some(pixels) = pixels {
                                let image = Image::from_rgba8(pixels);
                                app.ui.set_picture(image.clone());
                                app.ui.set_has_background(true);
                                app.adm().set_preview(image);
                                app.adm().set_has_preview(true);
                            } else {
                                app.ui.set_has_background(false);
                                app.adm().set_has_preview(false);
                            }
                        }
                    });
                });
            }
        }
    }
}
fn load_picture(path: &Path, size: (u32, u32)) -> Option<SharedPixelBuffer<Rgba8Pixel>> {
    let bytes = std::fs::read(path).ok()?;
    let kind = image::guess_format(&bytes).ok()?;
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), kind);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().ok()?
        .resize_to_fill(size.0, size.1, image::imageops::FilterType::Triangle).into_rgba8();
    let (w, h) = img.dimensions();
    Some(SharedPixelBuffer::clone_from_slice(img.as_raw(), w, h))
}
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (core, updates) = Core::start(Config::from_env()?)?;
    let ui = AppWindow::new()?;
    if std::env::var("STATION_FULLSCREEN").as_deref() == Ok("1") {
        ui.window().set_fullscreen(true);
    }
    ui.on_key(|text, modifier| {
        let mut used = false;
        with_app(|app| used = app.key(&text, modifier));
        used
    });
    ui.on_sync_clicked(|| with_app(|app| app.core.sync_now()));
    ui.on_open_register(|| with_app(|app| app.navigate("register")));
    ui.on_open_admin(|| with_app(|app| app.navigate("dashboard")));
    ui.on_shut_clicked(|| with_app(App::open_shut));
    ui.on_shut_cancel(|| with_app(App::close_shut));
    ui.on_shut_confirm(|| with_app(App::do_shutdown));
    management::connect(&ui);
    // Closing the window from Register or Admin goes back to the tap screen;
    // from the tap screen it quits, as before.
    ui.window().on_close_requested(|| {
        let mut keep = false;
        with_app(|app| {
            if app.ui.get_managing() {
                keep = true;
                if !app.adm().get_busy() {
                    app.navigate("station");
                }
            }
        });
        if keep {
            slint::CloseRequestResponse::KeepWindowShown
        } else {
            slint::CloseRequestResponse::HideWindow
        }
    });
    let mut app = App {
        ui: ui.clone_strong(),
        status: core.snapshot()?,
        core: Arc::clone(&core),
        christmas: false,
        background_version: None,
        background_size: (0, 0),
        shown: None,
        hide: Timer::default(),
        sending: HashSet::new(),
        shut_open: false,
        shutting_down: false,
        shut_error: String::new(),
        reader: Reader::new(
            cfg!(target_os = "linux") && std::env::var("STATION_TYPING").as_deref() != Ok("1"),
        ),
        manage_open: false,
        last_activity: Instant::now(),
        data: management::Data::default(),
    };
    app.apply_appearance(app.status.appearance.clone());
    app.render_all();
    APP.with(|cell| *cell.borrow_mut() = Some(app));
    std::thread::spawn(move || {
        for status in updates {
            later(move |app| {
                app.apply_snapshot(status);
            });
        }
    });
    let clock = Timer::default();
    clock.start(TimerMode::Repeated, Duration::from_secs(1), || {
        with_app(App::tick)
    });
    ui.run()?;
    APP.with(|cell| cell.borrow_mut().take());
    Ok(())
}
