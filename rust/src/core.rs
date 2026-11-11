use crate::{
    config::Config,
    dates,
    model::{self, Boards, Person, ReportRow, Tap, User},
    scan::Scanner,
    sheets::Google,
    store::Store,
    sync::{Notes, Sync},
    Result,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InPerson {
    pub name: String,
    pub section: String,
    pub status: String,
    pub since: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SyncBadge {
    pub state: String,
    pub label: String,
    pub uploaded: usize,
    pub pending: usize,
    pub last_synced_at: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Picture {
    pub version: String,
    pub path: PathBuf,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Appearance {
    pub image: Option<Picture>,
    pub opacity: f64,
    pub theme: String,
    pub hidden: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub clock_ready: bool,
    pub sync: Option<SyncBadge>,
    pub currently_in: Vec<InPerson>,
    pub leaderboards: Option<Boards>,
    pub appearance: Appearance,
    pub pending_cards: Vec<String>,
}

#[cfg(test)]
#[path = "backup_parity.rs"]
mod backup_parity;
#[cfg(test)]
#[path = "app_parity.rs"]
mod app_parity;
#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("residency-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn config(&self) -> Config {
            Config {
                db_path: self.0.join("residency.db"),
                backup_dir: self.0.join("backups"),
                backup_keep: 60,
                key_file: self.0.join("unused.json"),
                spreadsheet_id: String::new(),
                admin_user: "admin".into(),
                admin_password: "secret".into(),
                dates: dates::Dates::new("Asia/Manila").unwrap(),
                max_session_ms: 36_000_000,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn person() -> Person {
        Person {
            name: "Ana".into(),
            student_id: "001".into(),
            section: "Web".into(),
            status: "Regular".into(),
            telegram: String::new(),
        }
    }
    #[test]
    fn expired_admin_cannot_change_people_or_restore_data() {
        let f = Fixture::new();
        let (core, _) = Core::with_sync(f.config(), None, false).unwrap();
        let id = core.register(person(), "001").unwrap();
        assert!(core.login("admin", "secret"));
        let backup = core.backup_now().unwrap();
        *core.admin_until.lock().unwrap() = Some(Instant::now() - Duration::from_secs(1));
        assert!(core.edit(id, person()).is_err());
        assert!(core.restore(&backup).is_err());
        assert!(!core.authenticated());
    }
    #[test]
    fn appearance_rejects_bad_input_and_removes_only_its_own_image() {
        let f = Fixture::new();
        let (core, _) = Core::with_sync(f.config(), None, false).unwrap();
        assert!(core.login("admin", "secret"));
        let picture = f.0.join("source.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]))
            .save(&picture)
            .unwrap();
        core.background(&picture).unwrap();
        assert!(core.snapshot().unwrap().appearance.image.is_some());
        let invalid = f.0.join("invalid.png");
        fs::write(&invalid, b"not an image").unwrap();
        assert!(core.background(&invalid).is_err());
        assert!(core.appearance(-1, "none", false).is_err());
        assert!(core.appearance(50, "other", false).is_err());
        core.appearance(50, "christmas", true).unwrap();
        let state = core.snapshot().unwrap();
        assert!(state.leaderboards.unwrap().hidden);
        assert_eq!(state.appearance.opacity, 50.0);
        core.remove_background().unwrap();
        assert!(picture.is_file());
        assert!(core.snapshot().unwrap().appearance.image.is_none());
        assert_eq!(core.snapshot().unwrap().appearance.opacity, 50.0);
    }
    #[test]
    fn retention_prunes_dated_backups_and_keeps_unrelated_files() {
        let f = Fixture::new();
        let mut config = f.config();
        config.backup_keep = 2;
        let (core, _) = Core::with_sync(config, None, false).unwrap();
        assert!(core.login("admin", "secret"));
        let unrelated = f.0.join("backups/residency-2020-01-01_000000-manual.db");
        fs::write(&unrelated, b"keep").unwrap();
        let legacy = f.0.join("backups/residency-2020-01-01_000000.db");
        fs::write(&legacy, b"old backup").unwrap();
        for _ in 0..3 {
            core.backup_now().unwrap();
        }
        assert!(unrelated.is_file());
        assert!(!legacy.exists());
        assert_eq!(fs::read_dir(&core.config.backup_dir).unwrap().count(), 3);
    }
    #[test]
    fn native_workflows_keep_history_and_restore_with_an_undo_backup() {
        let f = Fixture::new();
        let (core, _) = Core::with_sync(f.config(), None, false).unwrap();
        core.clock.store(true, Ordering::Relaxed);
        assert!(core.users().is_err());
        assert!(!core.login("admin", "wrong"));
        assert!(core.login("admin", "secret"));
        let id = core.register(person(), "0001").unwrap();
        assert!(core.store.lock().unwrap().events().unwrap().is_empty());
        let tap = core.tap("0001").unwrap();
        core.acknowledge(&tap).unwrap();
        assert_eq!(core.snapshot().unwrap().currently_in.len(), 1);
        core.set_active(id, false).unwrap();
        assert!(core.snapshot().unwrap().currently_in.is_empty());
        assert_eq!(core.store.lock().unwrap().events().unwrap().len(), 1);
        core.set_active(id, true).unwrap();
        let saved = core.backup_now().unwrap();
        let mut edit = person();
        edit.name = "Ana edited".into();
        core.edit(id, edit).unwrap();
        let (_, events, undo) = core.restore(&saved).unwrap();
        assert_eq!(events, 1);
        assert!(undo.is_file());
        assert_eq!(core.users().unwrap()[0].person.name, "Ana");
        core.restore(&undo).unwrap();
        assert_eq!(core.users().unwrap()[0].person.name, "Ana edited");
        core.logout();
        assert!(core.edit(id, person()).is_err());
        assert!(core.backup_now().is_err());
    }
    #[test]
    fn pending_receipts_survive_database_reopen() {
        let f = Fixture::new();
        let tap = {
            let (core, _) = Core::with_sync(f.config(), None, false).unwrap();
            core.clock.store(true, Ordering::Relaxed);
            core.register(person(), "0001").unwrap();
            core.tap("0001").unwrap()
        };
        let (core, _) = Core::with_sync(f.config(), None, false).unwrap();
        core.clock.store(true, Ordering::Relaxed);
        let again = core.tap("0001").unwrap();
        assert!(again.replayed);
        assert_eq!(again.request_id, tap.request_id);
        assert_eq!(core.store.lock().unwrap().events().unwrap().len(), 1);
        core.acknowledge(&again).unwrap();
        assert!(core.snapshot().unwrap().pending_cards.is_empty());
    }
    /// The badge and dashboard share the same uploaded, pending and last-sync data.
    #[test]
    fn the_sync_badge_tells_refused_from_offline_and_counts_what_is_owed() {
        let f = Fixture::new();
        let mut config = f.config();
        config.spreadsheet_id = "sheet".into();
        let (core, _) = Core::with_sync(config, None, false).unwrap();
        core.clock.store(true, Ordering::Relaxed);
        core.register(person(), "0001").unwrap();
        let tap = core.tap("0001").unwrap();
        core.acknowledge(&tap).unwrap();
        let badge = |core: &Core| core.snapshot().unwrap().sync.unwrap();

        assert_eq!((badge(&core).state.as_str(), badge(&core).label.as_str()), ("pending", "Syncing · 1"), "nothing uploaded yet, nothing wrong yet");
        assert_eq!((badge(&core).uploaded, badge(&core).pending), (0, 1));
        assert!(badge(&core).last_synced_at.is_none());

        core.sync_state.lock().unwrap().last = Some(("Could not reach Google (ETIMEDOUT).".into(), true));
        assert_eq!((badge(&core).state.as_str(), badge(&core).label.as_str()), ("offline", "Offline · 1 saved"));

        core.sync_state.lock().unwrap().last = Some(("Google refused (403): no permission".into(), false));
        assert_eq!((badge(&core).state.as_str(), badge(&core).label.as_str()), ("error", "Sync error"));
        assert!(core.sync_error().unwrap().contains("403"));

        // Working again, with everything uploaded.
        core.sync_state.lock().unwrap().last = None;
        {
            let s = core.store.lock().unwrap();
            s.set_meta("sync_event_id", &s.last_id().unwrap().to_string()).unwrap();
            s.set_meta("sync_last_at", &dates::now()).unwrap();
        }
        assert_eq!((badge(&core).state.as_str(), badge(&core).label.as_str()), ("synced", "Synced"));
        assert_eq!((badge(&core).uploaded, badge(&core).pending), (1, 0));
        assert!(badge(&core).last_synced_at.is_some());
    }

    fn scheduled_core(f: &Fixture) -> (Arc<Core>, crate::test_support::Fake) {
        let mut config = f.config();
        config.spreadsheet_id = "test".into();
        let (core, _) = Core::with_sync(config, None, false).unwrap();
        core.clock.store(true, Ordering::Relaxed);
        assert!(core.login("admin", "secret"));
        core.register(person(), "0001").unwrap();
        core.store.lock().unwrap().set_meta("sync_full", "1").unwrap();
        core.store.lock().unwrap().set_meta("sync_seed", "1").unwrap();
        let fake = crate::test_support::Fake::default();
        *core.engine.lock().unwrap() = Some(Sync::new("test", Box::new(fake.clone())));
        (core, fake)
    }

    #[test]
    fn the_scheduler_retries_a_failed_sync_without_a_manual_kick() {
        let f = Fixture::new();
        let (core, fake) = scheduled_core(&f);
        fake.0.lock().unwrap().fail_reads = true;
        let worker = Arc::clone(&core);
        let (finished, attempts) = mpsc::channel();
        let task = std::thread::spawn(move || {
            for _ in 0..2 {
                worker.sync_cycle(Duration::from_secs(300), Duration::from_millis(50));
                finished.send(worker.sync_error()).unwrap();
            }
        });
        assert!(attempts.recv_timeout(Duration::from_secs(3)).unwrap().is_some());
        fake.0.lock().unwrap().fail_reads = false;
        assert!(attempts.recv_timeout(Duration::from_secs(3)).unwrap().is_none());
        task.join().unwrap();
        assert!(core.snapshot().unwrap().sync.unwrap().last_synced_at.is_some());
    }

    #[test]
    fn the_scheduler_sends_nothing_until_the_clock_is_ready() {
        let f = Fixture::new();
        let (core, fake) = scheduled_core(&f);
        core.clock.store(false, Ordering::Relaxed);
        let worker = Arc::clone(&core);
        let (finished, done) = mpsc::channel();
        let task = std::thread::spawn(move || {
            worker.sync_cycle(Duration::from_secs(300), Duration::from_secs(60));
            finished.send(()).unwrap();
        });
        assert!(done.recv_timeout(Duration::from_millis(100)).is_err());
        assert_eq!(fake.0.lock().unwrap().describes, 0);
        core.clock.store(true, Ordering::Relaxed);
        core.sync_now();
        done.recv_timeout(Duration::from_secs(3)).unwrap();
        task.join().unwrap();
        assert!(fake.0.lock().unwrap().describes > 0);
    }

    #[test]
    fn a_stale_roster_edit_schedules_immediate_reconciliation_without_losing_the_edit() {
        let f = Fixture::new();
        let (core, fake) = scheduled_core(&f);
        core.sync_cycle(Duration::from_secs(300), Duration::from_secs(60));
        fake.set("Staffers", "D2", serde_json::json!("EB"));
        let mut proposed = person();
        proposed.name = "Unsaved change".into();
        assert!(core.edit(1, proposed).is_err());
        assert!(*core.due.lock().unwrap() <= Instant::now());
        assert_eq!(core.users().unwrap()[0].person.name, "Ana");
        core.sync_cycle(Duration::from_secs(300), Duration::from_secs(60));
        assert_eq!(core.users().unwrap()[0].person.status, "EB");
        assert_eq!(fake.cell("Staffers", "A2"), Some(serde_json::json!("Ana")));
    }

    #[test]
    fn a_tap_arriving_during_upload_schedules_the_next_pass_immediately() {
        use crate::sheets::{self, Range, Rows, Sheets, Tab};
        struct TapDuringWrite {
            inner: crate::test_support::Fake,
            core: std::sync::Weak<Core>,
            tapped: bool,
        }
        impl Sheets for TapDuringWrite {
            fn describe(&mut self) -> sheets::Result<Vec<Tab>> { self.inner.describe() }
            fn read(&mut self, range: &str) -> sheets::Result<Rows> { self.inner.read(range) }
            fn clear(&mut self, ranges: &[String]) -> sheets::Result<()> { self.inner.clear(ranges) }
            fn batch(&mut self, requests: Vec<serde_json::Value>) -> sheets::Result<()> { self.inner.batch(requests) }
            fn write(&mut self, ranges: &[Range], formulas: bool) -> sheets::Result<()> {
                if !self.tapped && ranges.iter().any(|r| r.range.contains(" Logs'!A2:")) {
                    self.tapped = true;
                    assert_eq!(self.core.upgrade().unwrap().tap("0002").unwrap().status, "ok");
                }
                self.inner.write(ranges, formulas)
            }
        }
        let f = Fixture::new();
        let (core, fake) = scheduled_core(&f);
        let mut second = person();
        second.name = "Ben".into();
        second.student_id = "002".into();
        core.register(second, "0002").unwrap();
        core.tap("0001").unwrap();
        *core.engine.lock().unwrap() = Some(Sync::new("test", Box::new(TapDuringWrite {
            inner: fake.clone(), core: Arc::downgrade(&core), tapped: false,
        })));
        core.sync_cycle(Duration::from_secs(300), Duration::from_secs(60));
        assert!(core.sync_error().is_none());
        assert_eq!(core.snapshot().unwrap().sync.unwrap().pending, 1);
        assert!(*core.due.lock().unwrap() <= Instant::now(), "the tap must not wait for the next poll or debounce");
        core.sync_cycle(Duration::from_secs(300), Duration::from_secs(60));
        let badge = core.snapshot().unwrap().sync.unwrap();
        assert_eq!((badge.uploaded, badge.pending), (2, 0));
        let (y, m) = core.config.dates.month(&dates::now()).unwrap();
        let title = format!("{} Logs", dates::Dates::title(y, m));
        assert_eq!(fake.column(&title, 'A').iter().filter(|v| v.is_some()).count(), 2);
    }
    #[test]
    fn failed_sheet_confirmation_does_not_change_the_local_person() {
        let f = Fixture::new();
        let fake = crate::test_support::Fake::default();
        fake.tab("Staffers", vec![]);
        let (core, _) = Core::with_sync(
            f.config(),
            Some(Sync::new("test", Box::new(fake.clone()))),
            false,
        )
        .unwrap();
        fake.0.lock().unwrap().refuse_writes = true;
        assert!(core.register(person(), "0001").is_err());
        assert!(core.store.lock().unwrap().users().unwrap().is_empty());
    }
    #[test]
    fn restore_migrates_old_backups_and_rejects_invalid_files() {
        let f = Fixture::new();
        let old = f.0.join("old.db");
        let db = rusqlite::Connection::open(&old).unwrap();
        db.execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,rfid TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL); CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,type TEXT NOT NULL,ts TEXT NOT NULL); INSERT INTO users VALUES(1,'Old name','7','2026-01-01T00:00:00.000Z');").unwrap();
        drop(db);
        let (core, _) = Core::with_sync(f.config(), None, false).unwrap();
        assert!(core.login("admin", "secret"));
        core.restore(&old).unwrap();
        assert_eq!(core.users().unwrap()[0].person.name, "Old name");
        let broken = f.0.join("broken.db");
        fs::write(&broken, "not sqlite").unwrap();
        assert!(core.restore(&broken).is_err());
        assert_eq!(core.users().unwrap().len(), 1);
    }
    #[test]
    fn a_tap_returns_its_receipt_before_publishing_status() {
        let f = Fixture::new();
        let (core, updates) = Core::with_sync(f.config(), None, false).unwrap();
        core.clock.store(true, Ordering::Relaxed);
        core.register(person(), "0001").unwrap();
        while updates.try_recv().is_ok() {}
        let tap = core.tap("0001").unwrap();
        assert_eq!(tap.status, "ok");
        assert!(updates.try_recv().is_err(), "the receipt must reach the caller before any status refresh");
        core.acknowledge(&tap).unwrap();
        let status = updates.try_recv().unwrap();
        assert_eq!(status.currently_in.len(), 1);
        assert!(status.pending_cards.is_empty());
    }
    #[test]
    fn a_tap_does_not_wait_for_a_blocked_google_read() {
        use crate::sheets::{self, Range, Rows, Sheets, Tab};
        struct Blocking {
            inner: crate::test_support::Fake,
            ready: Option<Sender<()>>,
            release: Receiver<()>,
        }
        impl Sheets for Blocking {
            fn describe(&mut self) -> sheets::Result<Vec<Tab>> {
                self.inner.describe()
            }
            fn read(&mut self, range: &str) -> sheets::Result<Rows> {
                if let Some(ready) = self.ready.take() {
                    ready.send(()).unwrap();
                    self.release.recv().unwrap();
                }
                self.inner.read(range)
            }
            fn write(&mut self, ranges: &[Range], formulas: bool) -> sheets::Result<()> {
                self.inner.write(ranges, formulas)
            }
            fn clear(&mut self, ranges: &[String]) -> sheets::Result<()> {
                self.inner.clear(ranges)
            }
            fn batch(&mut self, requests: Vec<serde_json::Value>) -> sheets::Result<()> {
                self.inner.batch(requests)
            }
        }
        let f = Fixture::new();
        let fake = crate::test_support::Fake::default();
        let (ready, wait) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let (core, _) = Core::with_sync(f.config(), None, false).unwrap();
        core.clock.store(true, Ordering::Relaxed);
        core.register(person(), "0001").unwrap();
        let user = core.store.lock().unwrap().user(1).unwrap().unwrap();
        fake.tab(
            "Staffers",
            vec![
                crate::sheets::strings(&crate::roster::HEADER),
                crate::roster::row(&user),
            ],
        );
        *core.engine.lock().unwrap() = Some(Sync::new(
            "test",
            Box::new(Blocking {
                inner: fake,
                ready: Some(ready),
                release: blocked,
            }),
        ));
        let worker = Arc::clone(&core);
        let sync = std::thread::spawn(move || {
            worker.engine.lock().unwrap().as_mut().unwrap().run(
                &worker.store,
                &worker.boot_id,
                worker.config.dates,
                worker.config.max_session_ms,
            )
        });
        wait.recv_timeout(Duration::from_secs(3)).unwrap();
        let worker = Arc::clone(&core);
        let (sent, received) = mpsc::channel();
        let tap = std::thread::spawn(move || {
            sent.send(worker.tap("0001").map(|tap| tap.status)).unwrap()
        });
        let answer = received.recv_timeout(Duration::from_secs(1));
        release.send(()).unwrap();
        tap.join().unwrap();
        sync.join().unwrap().unwrap();
        assert_eq!(answer.unwrap().unwrap(), "ok");
    }
}
#[derive(Default)]
struct SyncState {
    running: bool,
    last: Option<(String, bool)>,
}

pub struct Core {
    pub config: Config,
    pub boot_id: String,
    store: Mutex<Store>,
    scanner: Mutex<Scanner>,
    engine: Mutex<Option<Sync>>,
    clock: AtomicBool,
    started: Instant,
    admin_until: Mutex<Option<Instant>>,
    sync_state: Mutex<SyncState>,
    notes: Mutex<Notes>,
    changed: Sender<Snapshot>,
    due: Mutex<Instant>,
    wake: Condvar,
    refresh: AtomicBool,
    operation: Mutex<()>,
}
impl Core {
    pub fn start(config: Config) -> Result<(Arc<Self>, Receiver<Snapshot>)> {
        let engine = if config.spreadsheet_id.is_empty() {
            None
        } else {
            Some(Sync::new(
                &config.spreadsheet_id,
                Box::new(Google::new(
                    config.spreadsheet_id.clone(),
                    config.key_file.clone(),
                )),
            ))
        };
        Self::with_sync(config, engine, true)
    }
    fn with_sync(
        config: Config,
        engine: Option<Sync>,
        background: bool,
    ) -> Result<(Arc<Self>, Receiver<Snapshot>)> {
        let store = Store::open(&config.db_path)?;
        let (sender, receiver) = mpsc::channel();
        let core = Arc::new(Self {
            config,
            boot_id: crate::machine::boot_id(),
            store: Mutex::new(store),
            scanner: Mutex::new(Scanner::default()),
            engine: Mutex::new(engine),
            clock: AtomicBool::new(!cfg!(target_os = "linux")),
            started: Instant::now(),
            admin_until: Mutex::new(None),
            sync_state: Mutex::new(SyncState::default()),
            notes: Mutex::new(Notes::default()),
            changed: sender,
            due: Mutex::new(Instant::now()),
            wake: Condvar::new(),
            refresh: AtomicBool::new(true),
            operation: Mutex::new(()),
        });
        // Attempt a backup before starting any sheet reconciliation, as on the web server.
        if let Err(e) = core.backup_internal() {
            core.log(&format!("BACKUP FAILED (startup): {e}"));
        }
        core.publish();
        if background {
            let clock = Arc::clone(&core);
            std::thread::spawn(move || {
                // Why the hardware clock isn't trusted, said once, as on the web.
                let mut said: Option<String> = None;
                while !clock.clock.load(Ordering::Relaxed) {
                    let floor = clock
                        .store
                        .lock()
                        .expect("database mutex poisoned")
                        .last_time()
                        .ok()
                        .flatten()
                        .and_then(|s| dates::millis(&s))
                        .unwrap_or(0);
                    let check = crate::machine::clock_check(floor);
                    if let Some(note) = check.note.filter(|n| said.as_ref() != Some(n)) {
                        clock.log(&note);
                        said = Some(note);
                    }
                    if let Some(source) = check.ready {
                        clock.clock.store(true, Ordering::Relaxed);
                        clock.log(match source {
                            crate::machine::Source::Network => "Clock is set over the network; taps are being recorded.",
                            crate::machine::Source::Rtc => "Clock is set from the hardware clock; taps are being recorded.",
                            crate::machine::Source::Host => "Clock is ready.",
                        });
                        clock.publish();
                        clock.kick(false);
                        break;
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
            });
            if !core.config.spreadsheet_id.is_empty() {
                let sync = Arc::clone(&core);
                std::thread::spawn(move || sync.sync_loop());
            }
        }
        Ok((core, receiver))
    }
    pub fn log(&self, message: &str) {
        let line = format!(
            "{}  {message}\n",
            self.config.dates.stamp(&dates::now()).unwrap_or_default()
        );
        eprint!("{line}");
        if let Some(dir) = self.config.db_path.parent() {
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("residency.log"))
            {
                let _ = file.write_all(line.as_bytes());
            }
        }
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let s = self.store.lock().expect("database mutex poisoned");
        let current = s
            .currently_in(&self.boot_id)?
            .into_iter()
            .map(|(u, since)| InPerson {
                name: u.person.name,
                section: u.person.section,
                status: u.person.status,
                since,
            })
            .collect();
        let (y, m) = self.config.dates.month(&dates::now())?;
        let (start, end) = self.config.dates.month_bounds(y, m)?;
        let hidden = s.meta("rankings_hidden")?.as_deref() == Some("1");
        let boards = if hidden {
            Boards {
                month: crate::dates::Dates::title(y, m),
                hidden,
                ..Boards::default()
            }
        } else {
            model::leaderboards(
                &s.report(
                    &self.boot_id,
                    self.config.max_session_ms,
                    Some(&start),
                    Some(&end),
                )?,
                crate::dates::Dates::title(y, m),
                false,
            )
        };
        let image_path = self.data_dir().join("background.img");
        let image = if s.meta("bg_type")?.is_some_and(|s| !s.is_empty()) && image_path.is_file() {
            Some(Picture {
                version: s.meta("bg_version")?.unwrap_or_else(|| "0".into()),
                path: image_path,
            })
        } else {
            None
        };
        let theme = s
            .meta("theme")?
            .filter(|t| t == "christmas")
            .unwrap_or_else(|| "none".into());
        let opacity = s
            .meta("bg_opacity")?
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite())
            .unwrap_or(85.0)
            .clamp(0.0, 100.0);
        let sync = if self.config.spreadsheet_id.is_empty() {
            None
        } else {
            let state = self.sync_state.lock().expect("sync status mutex poisoned");
            let (uploaded, count) = s.sync_counts()?;
            let last_synced_at = s.meta("sync_last_at")?;
            let (kind, label) = if let Some((_, offline)) = &state.last {
                if *offline {
                    (
                        "offline",
                        if count > 0 {
                            format!("Offline · {count} saved")
                        } else {
                            "Offline".into()
                        },
                    )
                } else {
                    ("error", "Sync error".into())
                }
            } else if state.running || count > 0 || last_synced_at.is_none() {
                (
                    "pending",
                    if count > 0 {
                        format!("Syncing · {count}")
                    } else {
                        "Syncing".into()
                    },
                )
            } else {
                ("synced", "Synced".into())
            };
            Some(SyncBadge {
                state: kind.into(),
                label,
                uploaded,
                pending: count,
                last_synced_at,
            })
        };
        Ok(Snapshot {
            clock_ready: self.clock.load(Ordering::Relaxed),
            sync,
            currently_in: current,
            leaderboards: Some(boards),
            appearance: Appearance {
                image,
                opacity,
                theme,
                hidden,
            },
            pending_cards: s.pending_cards()?,
        })
    }
    pub fn publish(&self) {
        match self.snapshot() {
            Ok(snapshot) => {
                let _ = self.changed.send(snapshot);
            }
            Err(e) => self.log(&format!("Could not refresh attendance: {e}")),
        }
    }
    // Return the durable receipt before building status. The UI acknowledges
    // it after presenting the result; acknowledge then publishes the snapshot.
    pub fn tap(&self, card: &str) -> Result<Tap> {
        let tap = {
            let s = self.store.lock().expect("database mutex poisoned");
            let mut scanner = self.scanner.lock().expect("scanner mutex poisoned");
            scanner.tap(
                &s,
                card,
                &self.boot_id,
                self.clock.load(Ordering::Relaxed),
                self.config.max_session_ms,
                &dates::now(),
                self.started.elapsed().as_millis() as u64,
            )?
        };
        self.log(&format!(
            "{} {} {}",
            tap.status,
            tap.direction,
            if tap.name.is_empty() {
                &tap.rfid
            } else {
                &tap.name
            }
        ));
        if tap.status == "ok" {
            self.kick(false);
        }
        Ok(tap)
    }
    pub fn acknowledge(&self, tap: &Tap) -> Result<()> {
        self.store
            .lock()
            .expect("database mutex poisoned")
            .acknowledge(&tap.rfid, &tap.request_id)?;
        self.publish();
        Ok(())
    }
    pub fn unknown(&self) -> Vec<(String, String)> {
        self.scanner
            .lock()
            .expect("scanner mutex poisoned")
            .unknown
            .clone()
    }
    pub fn notes(&self) -> Notes {
        self.notes
            .lock()
            .expect("roster notes mutex poisoned")
            .clone()
    }
    pub fn login(&self, user: &str, password: &str) -> bool {
        let digest = |text: &str| ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
        let equal = |a: &str, b: &str| bool::from(digest(a).as_ref().ct_eq(digest(b).as_ref()));
        if equal(user, &self.config.admin_user) && equal(password, &self.config.admin_password) {
            *self.admin_until.lock().expect("session mutex poisoned") =
                Some(Instant::now() + Duration::from_secs(1800));
            true
        } else {
            false
        }
    }
    pub fn logout(&self) {
        *self.admin_until.lock().expect("session mutex poisoned") = None;
    }
    pub fn authenticated(&self) -> bool {
        self.admin_until
            .lock()
            .expect("session mutex poisoned")
            .is_some_and(|until| Instant::now() < until)
    }
    fn admin(&self) -> Result<()> {
        let mut until = self.admin_until.lock().expect("session mutex poisoned");
        if until.is_none_or(|until| Instant::now() >= until) {
            *until = None;
            return Err("Your admin session ended. Sign in again.".into());
        }
        *until = Some(Instant::now() + Duration::from_secs(1800));
        Ok(())
    }
    pub fn users(&self) -> Result<Vec<User>> {
        self.admin()?;
        self.store.lock().expect("database mutex poisoned").users()
    }
    pub fn register(&self, person: Person, card: &str) -> Result<i64> {
        let person = person.validated()?;
        let card = card.trim();
        if !model::valid_card(card) {
            return Err("Tap their ID, or enter its card number using digits only.".into());
        }
        let _operation = self
            .operation
            .lock()
            .expect("management operation mutex poisoned");
        {
            let s = self.store.lock().expect("database mutex poisoned");
            s.check_person(&person, None)?;
            if let Some(user) = s.by_card(card)? {
                return Err(format!(
                    "That card number is already registered to {}.{}",
                    user.person.name,
                    if user.active {
                        ""
                    } else {
                        " They are deactivated; ask an admin to reactivate them."
                    }
                )
                .into());
            }
        }
        let wanted = User {
            id: 0,
            person,
            rfid: card.into(),
            active: true,
            created_at: dates::now(),
        };
        let mut engine = self.engine.lock().expect("sync mutex poisoned");
        if let Some(sync) = engine.as_mut() {
            sync.save(&self.store, &wanted, None).map_err(|e| {
                self.kick(true);
                self.sync_now();
                format!(
                    "Could not confirm the change. Sync requested; check People before retrying. {}",
                    e.message
                )
            })?;
        }
        let id = self
            .store
            .lock()
            .expect("database mutex poisoned")
            .transaction(|s| {
                s.check_person(&wanted.person, None)?;
                s.create(&wanted.person, card, true)
            })?;
        if let Some(sync) = engine.as_mut() {
            sync.refresh();
        }
        drop(engine);
        self.scanner
            .lock()
            .expect("scanner mutex poisoned")
            .forget_unknown(card);
        self.publish();
        self.kick(true);
        Ok(id)
    }
    pub fn edit(&self, id: i64, person: Person) -> Result<()> {
        self.admin()?;
        let person = person.validated()?;
        let _operation = self
            .operation
            .lock()
            .expect("management operation mutex poisoned");
        let own = {
            let s = self.store.lock().expect("database mutex poisoned");
            s.check_person(&person, Some(id))?;
            s.user(id)?.ok_or("No such person.")?
        };
        let wanted = User {
            person,
            ..own.clone()
        };
        let mut engine = self.engine.lock().expect("sync mutex poisoned");
        if let Some(sync) = engine.as_mut() {
            sync.save(&self.store, &wanted, Some(&own)).map_err(|e| {
                self.kick(true);
                self.sync_now();
                format!(
                    "Could not confirm the change. Sync requested; check People before retrying. {}",
                    e.message
                )
            })?;
        }
        self.store
            .lock()
            .expect("database mutex poisoned")
            .transaction(|s| {
                s.check_person(&wanted.person, Some(id))?;
                s.update(id, &wanted.person)
            })?;
        if let Some(sync) = engine.as_mut() {
            sync.refresh();
        }
        drop(engine);
        self.publish();
        self.kick(true);
        Ok(())
    }
    pub fn set_active(&self, id: i64, active: bool) -> Result<()> {
        self.admin()?;
        let _operation = self
            .operation
            .lock()
            .expect("management operation mutex poisoned");
        let own = self
            .store
            .lock()
            .expect("database mutex poisoned")
            .user(id)?
            .ok_or("No such person.")?;
        let wanted = User {
            active,
            ..own.clone()
        };
        let mut engine = self.engine.lock().expect("sync mutex poisoned");
        if let Some(sync) = engine.as_mut() {
            sync.save(&self.store, &wanted, Some(&own)).map_err(|e| {
                self.kick(true);
                self.sync_now();
                format!(
                    "Could not confirm the change. Sync requested; check People before retrying. {}",
                    e.message
                )
            })?;
        }
        self.store
            .lock()
            .expect("database mutex poisoned")
            .set_active(id, active)?;
        if let Some(sync) = engine.as_mut() {
            sync.refresh();
        }
        drop(engine);
        self.publish();
        self.kick(true);
        Ok(())
    }
    pub fn report(&self, start: &str, end: &str) -> Result<Vec<ReportRow>> {
        self.admin()?;
        let (a, b) = self.config.dates.bounds(start, end)?;
        self.store.lock().expect("database mutex poisoned").report(
            &self.boot_id,
            self.config.max_session_ms,
            a.as_deref(),
            b.as_deref(),
        )
    }
    pub fn months(&self) -> Result<Vec<(i32, u32)>> {
        self.admin()?;
        let s = self.store.lock().expect("database mutex poisoned");
        let mut months = std::collections::BTreeSet::new();
        months.insert(self.config.dates.month(&dates::now())?);
        for event in s.events()? {
            if let Ok(month) = self.config.dates.month(&event.ts) {
                months.insert(month);
            }
        }
        Ok(months.into_iter().rev().collect())
    }
    pub fn export(&self, path: &Path, start: &str, end: &str) -> Result<()> {
        let rows = self.report(start, end)?;
        let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
        file.write_all(model::hours_csv(&rows).as_bytes())?;
        file.sync_all()?;
        Ok(())
    }
    pub fn appearance(&self, opacity: i32, theme: &str, hidden: bool) -> Result<()> {
        self.admin()?;
        if !(0..=100).contains(&opacity) || !["none", "christmas"].contains(&theme) {
            return Err("Choose a listed theme and opacity from 0 to 100.".into());
        }
        self.store
            .lock()
            .expect("database mutex poisoned")
            .transaction(|s| {
                s.set_meta("bg_opacity", &opacity.to_string())?;
                s.set_meta("theme", theme)?;
                s.set_meta("rankings_hidden", if hidden { "1" } else { "0" })
            })?;
        self.publish();
        Ok(())
    }
    pub fn background(&self, path: &Path) -> Result<()> {
        self.admin()?;
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("That picture is too big; choose a file no larger than 8 MB.".into());
        }
        let kind = image::guess_format(&bytes)?;
        let mime = match kind {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::WebP => "image/webp",
            image::ImageFormat::Gif => "image/gif",
            _ => return Err("Choose a PNG, JPEG, WebP or GIF picture.".into()),
        };
        let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), kind);
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        reader.decode()?;
        let destination = self.data_dir().join("background.img");
        let tmp = destination.with_extension("img.tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &destination)?;
        let version = chrono::Utc::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
            .to_string();
        self.store
            .lock()
            .expect("database mutex poisoned")
            .transaction(|s| {
                s.set_meta("bg_type", mime)?;
                s.set_meta("bg_version", &version)
            })?;
        self.publish();
        Ok(())
    }
    pub fn remove_background(&self) -> Result<()> {
        self.admin()?;
        self.store
            .lock()
            .expect("database mutex poisoned")
            .set_meta("bg_type", "")?;
        match fs::remove_file(self.data_dir().join("background.img")) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        self.publish();
        Ok(())
    }
    pub fn backup_now(&self) -> Result<PathBuf> {
        self.admin()?;
        self.backup_internal()
    }
    fn backup_internal(&self) -> Result<PathBuf> {
        self.backup_preserving(None)
    }
    fn backup_preserving(&self, protected: Option<&Path>) -> Result<PathBuf> {
        let protected = protected.map(fs::canonicalize).transpose()?;
        fs::create_dir_all(&self.config.backup_dir)?;
        let stamp = chrono::Utc::now()
            .with_timezone(&self.config.dates.0)
            .format("%Y-%m-%d_%H%M%S-%f")
            .to_string();
        let file = self.config.backup_dir.join(format!("residency-{stamp}.db"));
        let partial = file.with_extension("db.partial");
        let result = self
            .store
            .lock()
            .expect("database mutex poisoned")
            .backup(&partial);
        if let Err(e) = result {
            let _ = fs::remove_file(&partial);
            return Err(e);
        }
        fs::rename(&partial, &file)?;
        let mut backups = fs::read_dir(&self.config.backup_dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                let stem = name
                    .strip_prefix("residency-")
                    .or_else(|| name.strip_prefix("attendance-"));
                name.ends_with(".db")
                    && stem.and_then(|s| s.strip_suffix(".db")).is_some_and(|s| {
                        s.is_ascii()
                            && s.len() >= 17
                            && chrono::NaiveDateTime::parse_from_str(&s[..17], "%Y-%m-%d_%H%M%S")
                                .is_ok()
                            && (s.len() == 17
                                || (s.len() == 27
                                    && s.as_bytes()[17] == b'-'
                                    && s[18..].bytes().all(|b| b.is_ascii_digit())))
                    })
            })
            .collect::<Vec<_>>();
        backups.sort();
        let discard = backups.len().saturating_sub(self.config.backup_keep);
        for old in backups.into_iter().take(discard) {
            if protected.as_ref().is_some_and(|p| fs::canonicalize(&old).ok().as_ref() == Some(p)) {
                continue;
            }
            fs::remove_file(old)?;
        }
        self.log(&format!("Backup: {}", file.display()));
        Ok(file)
    }
    pub fn restore(&self, path: &Path) -> Result<(i64, i64, PathBuf)> {
        self.admin()?;
        Store::verify_backup(path)?;
        let _operation = self
            .operation
            .lock()
            .expect("management operation mutex poisoned");
        let mut engine = self.engine.lock().expect("sync mutex poisoned");
        let undo = self.backup_preserving(Some(path))?;
        let counts = self
            .store
            .lock()
            .expect("database mutex poisoned")
            .restore(path)?;
        *self.scanner.lock().expect("scanner mutex poisoned") = Scanner::default();
        if let Some(sync) = engine.as_mut() {
            sync.reset();
        }
        drop(engine);
        self.publish();
        self.kick(true);
        Ok((counts.0, counts.1, undo))
    }
    pub fn shutdown(&self) -> Result<()> {
        let names = self
            .snapshot()?
            .currently_in
            .into_iter()
            .map(|p| p.name)
            .collect::<Vec<_>>()
            .join(", ");
        self.log(&format!("OFF: shutting down; still checked in: {names}"));
        if let Err(e) = self.backup_internal() {
            self.log(&format!("BACKUP FAILED (shutdown): {e}"));
        }
        crate::machine::shutdown()
    }
    pub fn data_dir(&self) -> PathBuf {
        self.config
            .db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf()
    }
    pub fn sync_error(&self) -> Option<String> {
        self.sync_state
            .lock()
            .expect("sync status mutex poisoned")
            .last
            .as_ref()
            .map(|s| s.0.clone())
    }
    pub fn kick(&self, all: bool) {
        if self.config.spreadsheet_id.is_empty() {
            return;
        }
        if all {
            self.refresh.store(true, Ordering::Relaxed);
        }
        let running = self.sync_state.lock().expect("sync status mutex poisoned").running;
        let mut due = self.due.lock().expect("sync scheduler mutex poisoned");
        let next = Instant::now() + if running { Duration::ZERO } else { Duration::from_secs(2) };
        if *due > next {
            *due = next;
        }
        self.wake.notify_one();
    }
    pub fn sync_now(&self) {
        if self.config.spreadsheet_id.is_empty() {
            return;
        }
        *self.due.lock().expect("sync scheduler mutex poisoned") = Instant::now();
        self.wake.notify_one();
    }
    fn sync_loop(self: Arc<Self>) {
        loop {
            self.sync_cycle(Duration::from_secs(300), Duration::from_secs(60));
        }
    }
    // One scheduled attempt, including clock gating and retry scheduling.
    fn sync_cycle(&self, poll: Duration, retry_after: Duration) {
        let mut due = self.due.lock().expect("sync scheduler mutex poisoned");
        while Instant::now() < *due || !self.clock.load(Ordering::Relaxed) {
            let timeout = due
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(2))
                .max(Duration::from_millis(100));
            due = self
                .wake
                .wait_timeout(due, timeout)
                .expect("sync scheduler mutex poisoned")
                .0;
        }
        *due = Instant::now() + poll;
        drop(due);
        self.sync_state
            .lock()
            .expect("sync status mutex poisoned")
            .running = true;
        self.publish();
        let result = {
            let mut engine = self.engine.lock().expect("sync mutex poisoned");
            let sync = engine.as_mut().expect("configured sync engine");
            if self.refresh.swap(false, Ordering::Relaxed) {
                sync.refresh();
            }
            let result = sync.run(
                &self.store,
                &self.boot_id,
                self.config.dates,
                self.config.max_session_ms,
            );
            *self.notes.lock().expect("roster notes mutex poisoned") = sync.notes.clone();
            result
        };
        let retry = result.is_err();
        {
            let mut state = self.sync_state.lock().expect("sync status mutex poisoned");
            state.running = false;
            state.last = result.err().map(|e| {
                self.log(&format!("Sheet sync failed: {}", e.message));
                (e.message, e.offline)
            });
        }
        if retry {
            let mut due = self.due.lock().expect("sync scheduler mutex poisoned");
            *due = (*due).min(Instant::now() + retry_after);
        }
        self.publish();
    }
}
